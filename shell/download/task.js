/*
 * 单个下载任务的状态机
 *
 * 生命周期：
 *   pending → preparing → downloading → finalizing → done
 *                       ↘ paused / error
 *
 * 收尾必须【先关 fd 再 rename】。Windows 上文件句柄没释放时 rename 会报 EPERM，
 * 这是这类下载器最常见的"最后一步失败"。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { planChunks, preallocate, probeRange } = require('./plan');
const { downloadChunk } = require('./chunk');
const { HfError } = require('../net/errors');
const { SpeedMeter } = require('./meter');
const { longPath } = require('../util/pathsafe');

const PART_SUFFIX = '.hfdlpart';

async function runTask(task, mgr) {
  task.status = 'preparing';
  task.error = '';
  mgr.emitTask(task);

  try {
    const dir = path.dirname(task.finalFile);
    await fs.promises.mkdir(dir, { recursive: true });

    // 空文件直接落盘
    if (!task.size || task.size <= 0) {
      await fs.promises.writeFile(task.finalFile, '');
      task.doneBytes = 0;
      task.status = 'done';
      task.doneAt = Date.now();
      mgr.emitTask(task);
      mgr.recordHistory(task);
      return;
    }

    // 续传前校验磁盘上的分块文件是否可信
    if (!task.chunks) task.chunks = planChunks(task.size);

    const partPath = longPath(task.partFile);
    let partOk = false;
    try {
      const st = await fs.promises.stat(partPath);
      partOk = st.size === task.size;
    } catch {
      partOk = false;
    }

    if (!partOk) {
      // 分块文件不存在或尺寸对不上，整个任务重置
      task.chunks = planChunks(task.size);
      task.doneBytes = 0;
      await preallocate(partPath, task.size);
    }

    const fh = await fs.promises.open(partPath, 'r+');

    try {
      /* ---- Range 探测：只有多分块且还没探测过才做 ---- */
      if (task.chunks.length > 1 && task.rangeable === undefined) {
        const p = await probeRange(task.url, task.size);
        task.rangeable = p.rangeable;
        if (!p.rangeable) {
          // 实测：hf-mirror 的非 LFS 小文件走这条路
          task.chunks = [{ index: 0, start: 0, end: task.size - 1, len: task.size, done: 0 }];
          task.singleStream = true;
          task.doneBytes = 0;
          mgr.log(task, '远端不支持分段下载，改为单连接');
        } else if (p.total !== task.size) {
          task.size = p.total;
          task.chunks = planChunks(task.size);
          task.doneBytes = 0;
          await preallocate(partPath, task.size);
          mgr.log(task, `文件大小已更新为 ${p.total} 字节，重新分块`);
        }
      }

      task.status = 'downloading';
      mgr.emitTask(task);

      const ctx = {
        fh,
        url: task.url,
        sem: mgr.sem,
        meter: task.meter,
        log: (t, m) => mgr.log(t, m),
        onDirty: (t) => mgr.markDirty(t),
      };

      // 待办队列：只取还没下完的分块
      const queue = task.chunks.filter((c) => c.done < c.len);
      const limit = task.singleStream ? 1 : mgr.chunksPerFile;
      const workers = [];

      for (let i = 0; i < Math.min(limit, queue.length); i++) {
        workers.push(
          (async () => {
            while (queue.length) {
              if (task.abortReason || task.pauseRequested) return;
              const c = queue.shift();
              await downloadChunk(task, c, ctx);
            }
          })()
        );
      }

      // 任一 worker 致命失败 → 立刻置 abortReason，其余在下一个检查点退出
      for (const p of workers) {
        p.catch((e) => {
          if (!task.abortReason && e && e.code !== 'PAUSED') task.abortReason = e;
        });
      }
      await Promise.allSettled(workers);

      if (task.pauseRequested) {
        task.status = 'paused';
        mgr.emitTask(task);
        return;
      }

      if (task.abortReason) throw task.abortReason;

      /* ---- 收尾 ---- */
      task.status = 'finalizing';
      mgr.emitTask(task);

      await fh.close(); // 必须先关，否则 Windows 上 rename 会 EPERM
      await fs.promises.rename(longPath(task.partFile), longPath(task.finalFile));

      task.status = 'done';
      task.doneAt = Date.now();
      task.doneBytes = task.size;
      task.meter.reset();
      mgr.emitTask(task);
      mgr.recordHistory(task);
      mgr.log(task, '下载完成');
      return;
    } finally {
      try { await fh.close(); } catch {}
    }
  } catch (e) {
    if (e && e.reset) {
      // 远端文件变了，清掉分块状态重来
      task.chunks = null;
      task.doneBytes = 0;
      task.rangeable = undefined;
      task.singleStream = false;
      try { await fs.promises.unlink(longPath(task.partFile)); } catch {}
    }

    if (e && e.code === 'PAUSED') {
      task.status = 'paused';
    } else if (e && e.fallbackSingle) {
      // 探测阶段才发现不支持 Range（理论上已在前面处理，兜底）
      task.singleStream = true;
      task.chunks = [{ index: 0, start: 0, end: task.size - 1, len: task.size, done: 0 }];
      task.doneBytes = 0;
      task.status = 'pending';
    } else {
      task.status = 'error';
      task.error = (e && e.message) || String(e);
      mgr.log(task, `失败：${task.error}`);
    }
    mgr.emitTask(task);
  } finally {
    task.abortReason = null;
    await mgr.saveState();
  }
}

/**
 * 由 Manager 调用，包一层 promise 便于 pause 等待。
 *
 * 防重入：同一任务并发跑两遍会各自持有 FileHandle 往同一偏移写，
 * 表现为「下载完成」与「写入超出分块范围」同时出现，且文件可能损坏。
 * 这里用 _running 标记硬性拦住。
 */
function startTask(task, mgr) {
  if (task._running) return task._runPromise || Promise.resolve();

  task._running = true;
  task.meter = task.meter || new SpeedMeter(3000);
  task.abortReason = null;

  const p = runTask(task, mgr)
    .catch((e) => {
      task.status = 'error';
      task.error = (e && e.message) || String(e);
      mgr.emitTask(task);
    })
    .finally(() => {
      task._running = false;
    });

  task._runPromise = p;
  return p;
}

module.exports = { runTask, startTask, PART_SUFFIX };
