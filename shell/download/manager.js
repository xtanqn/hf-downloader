/*
 * 下载队列管理
 *
 * 三级并发：
 *   maxFiles       同时"正在下载"的文件数（默认 3）
 *   chunksPerFile  单文件内并发分块数（默认 8）
 *   maxConnections 全局 socket 上限（默认 16，信号量）
 *
 * 第三层不能省：3 × 8 = 24 > 16。没有全局闸门时用户把 maxFiles 调高
 * 会让连接数失控，弱网下互相拖死。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Semaphore } = require('./semaphore');
const { SpeedMeter } = require('./meter');
const { startTask, PART_SUFFIX } = require('./task');
const { readState, writeStateAtomic, validateOnLoad } = require('./state');
const { resolveUrl } = require('../net/hf-api');
const { safeRelPath, isInside, longPath } = require('../util/pathsafe');
const { HfError } = require('../net/errors');

const PROGRESS_INTERVAL = 250;

class DownloadManager {
  constructor(opts) {
    const o = opts || {};
    this.win = o.win || null;
    this.settings = o.settings;
    this.history = o.history || null;
    this.logger = o.logger;

    this.tasks = [];
    this.byId = new Map();
    this.sem = new Semaphore(this.settings.maxConnections || 16);
    this.chunksPerFile = this.settings.chunksPerFile || 8;
    this.maxFiles = this.settings.maxFiles || 3;

    this.running = new Set();
    this.dirty = new Map();
    this.progressTimer = null;
    this.saveTimer = null;

    this._restore();
  }

  /* ---------------- 持久化 ---------------- */

  _restore() {
    const loaded = validateOnLoad(readState());
    for (const t of loaded) {
      t.meter = new SpeedMeter(3000);
      this.tasks.push(t);
      this.byId.set(t.id, t);
    }
    if (loaded.length) {
      this.logger.info(`恢复 ${loaded.length} 个下载任务`);
    }
  }

  saveState() {
    if (this.saveTimer) return Promise.resolve();
    return new Promise((resolve) => {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        writeStateAtomic(this.tasks);
        resolve();
      }, 500);
    });
  }

  saveStateNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    writeStateAtomic(this.tasks);
  }

  /* ---------------- 事件推送 ---------------- */

  _send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.webContents.send(channel, payload); } catch {}
    }
  }

  emitTask(task) {
    this._send('dl:task', this.publicTask(task));
  }

  /** 进度节流：10GB 文件 + 16 连接，若每块都发 IPC 会把渲染进程淹死 */
  markDirty(task) {
    this.dirty.set(task.id, {
      id: task.id,
      done: task.doneBytes,
      speed: task.meter ? task.meter.speed() : 0,
      status: task.status,
    });
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      const batch = [...this.dirty.values()];
      this.dirty.clear();
      if (batch.length) this._send('dl:progress', batch);
    }, PROGRESS_INTERVAL);
  }

  log(task, text) {
    this.logger.info(`[${task ? task.id : '-'}] ${text}`);
    this._send('dl:log', { id: task ? task.id : '', level: 'info', text });
  }

  publicTask(t) {
    return {
      id: t.id,
      repo: t.repo,
      rev: t.rev,
      path: t.path,
      size: t.size,
      done: t.doneBytes || 0,
      status: t.status,
      error: t.error || '',
      destDir: t.destDir,
      finalFile: t.finalFile,
      speed: t.meter ? t.meter.speed() : 0,
      singleStream: !!t.singleStream,
      createdAt: t.createdAt,
      doneAt: t.doneAt || 0,
    };
  }

  snapshot() {
    return this.tasks.map((t) => this.publicTask(t));
  }

  /* ---------------- 入队 ---------------- */

  /**
   * items: [{ path, size, oid }]
   * 返回 { added, skipped }
   */
  enqueue(items, ctx) {
    const c = ctx || {};
    const destRoot = c.destDir || this.settings.destDir;
    if (!destRoot) throw new HfError('NO_DEST', '请先设置下载目录');

    const mirror = this.settings.mirror;
    const flat = this.settings.flatLayout === true;
    const repoName = String(c.repo).split('/')[1] || 'model';

    const added = [];
    const skipped = [];

    for (const it of items) {
      // 目标路径：带仓库名 或 扁平化
      const rel = safeRelPath(it.path);
      const base = flat ? path.join(destRoot, repoName) : path.join(destRoot, repoName);
      const finalFile = flat ? path.join(base, rel) : path.join(base, rel);

      // 防路径穿越：仓库里理论上没有 ../，但不能只靠"理论上"
      if (!isInside(destRoot, finalFile)) {
        skipped.push({ path: it.path, reason: '路径越界' });
        continue;
      }

      const existing = this.tasks.find(
        (t) => t.finalFile === finalFile && t.repo === c.repo && t.status !== 'error'
      );
      if (existing) {
        skipped.push({ path: it.path, reason: '已在队列中' });
        continue;
      }

      // 磁盘上已有完整文件且大小一致 → 跳过
      try {
        const st = fs.statSync(longPath(finalFile));
        if (st.size === Number(it.size)) {
          skipped.push({ path: it.path, reason: '已存在' });
          continue;
        }
      } catch {}

      const id = crypto.randomBytes(5).toString('hex');
      const task = {
        id,
        repo: c.repo,
        rev: c.rev || 'main',
        path: it.path,
        url: resolveUrl(mirror, c.repo, c.rev || 'main', it.path),
        destDir: destRoot,
        finalFile,
        partFile: finalFile + PART_SUFFIX,
        size: Number(it.size) || 0,
        oid: it.oid || '',
        chunks: null,
        status: 'pending',
        error: '',
        doneBytes: 0,
        rangeable: undefined,
        singleStream: false,
        meter: new SpeedMeter(3000),
        createdAt: Date.now(),
      };

      this.tasks.push(task);
      this.byId.set(id, task);
      added.push(this.publicTask(task));
    }

    if (added.length) {
      this.saveStateNow();
      this.pump();
    }
    return { added, skipped };
  }

  /* ---------------- 调度 ---------------- */

  pump() {
    if (this.running.size >= this.maxFiles) return;
    for (const t of this.tasks) {
      if (this.running.size >= this.maxFiles) break;
      if (t.status !== 'pending' && t.status !== 'queued') continue;
      if (this.running.has(t.id)) continue;

      this.running.add(t.id);
      startTask(t, this)
        .catch(() => {})
        .finally(() => {
          this.running.delete(t.id);
          this.pump();
        });
    }
  }

  pause(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const waits = [];
    for (const id of list) {
      const t = this.byId.get(id);
      if (!t) continue;
      if (t.status === 'done') continue;
      t.pauseRequested = true;
      if (t._sleepResolve) t._sleepResolve();
      // 必须等 runTask 把 worker 收干净、状态落盘
      // 否则"暂停→立刻继续"时旧写入还在飞，新的一轮从同一个 chunk.done 开始，会交错损坏
      if (t._runPromise) waits.push(t._runPromise.catch(() => {}));
      else {
        t.status = 'paused';
        this.emitTask(t);
      }
    }
    return Promise.all(waits).then(() => {
      for (const id of list) {
        const t = this.byId.get(id);
        if (t) t.pauseRequested = false;
      }
      this.saveStateNow();
      return { ok: true };
    });
  }

  resume(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      const t = this.byId.get(id);
      if (!t) continue;
      if (t.status !== 'paused' && t.status !== 'error') continue;
      t.status = 'pending';
      t.error = '';
      t.pauseRequested = false;
      this.emitTask(t);
    }
    this.saveStateNow();
    this.pump();
    return { ok: true };
  }

  cancel(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      const t = this.byId.get(id);
      if (!t) continue;
      t.abortReason = new HfError('CANCELLED', '已取消');
      if (t._sleepResolve) t._sleepResolve();
    }
    return Promise.all(
      list.map((id) => {
        const t = this.byId.get(id);
        return t && t._runPromise ? t._runPromise.catch(() => {}) : Promise.resolve();
      })
    ).then(async () => {
      for (const id of list) {
        const t = this.byId.get(id);
        if (!t) continue;
        try { await fs.promises.unlink(longPath(t.partFile)); } catch {}
        const i = this.tasks.indexOf(t);
        if (i >= 0) this.tasks.splice(i, 1);
        this.byId.delete(id);
        this.running.delete(id);
      }
      this.saveStateNow();
      this._send('dl:removed', list);
      this.pump();
      return { ok: true };
    });
  }

  clearDone() {
    const keep = [];
    const removed = [];
    for (const t of this.tasks) {
      if (t.status === 'done') removed.push(t.id);
      else keep.push(t);
    }
    this.tasks = keep;
    for (const id of removed) this.byId.delete(id);
    this.saveStateNow();
    this._send('dl:removed', removed);
    return { ok: true, removed };
  }

  /** 设置变更后调用 */
  applySettings(s) {
    this.settings = s;
    this.chunksPerFile = s.chunksPerFile || 8;
    this.maxFiles = s.maxFiles || 3;
    this.sem.resize(s.maxConnections || 16);
  }

  recordHistory(task) {
    if (this.history) {
      this.history.add({
        repo: task.repo,
        rev: task.rev,
        path: task.path,
        size: task.size,
        finalFile: task.finalFile,
        destDir: task.destDir,
      });
    }
  }

  /** 退出前保存 */
  shutdown() {
    this.saveStateNow();
  }
}

module.exports = { DownloadManager, PROGRESS_INTERVAL };
