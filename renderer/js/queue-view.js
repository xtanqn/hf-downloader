/*
 * 下载队列 UI
 *
 * 进度更新走直接 DOM 变更，绝不重渲染整行 —— 16 连接下每 250ms 一批，
 * 重建 DOM 会明显掉帧。
 */
'use strict';

const STATUS_TEXT = {
  pending: '等待中',
  preparing: '准备中',
  downloading: '下载中',
  finalizing: '收尾中',
  paused: '已暂停',
  error: '失败',
  done: '已完成',
};

class QueueView {
  constructor(opts) {
    this.elBody = opts.elBody;
    this.elPane = opts.elPane;
    this.elSpeed = opts.elSpeed;
    this.elEta = opts.elEta;
    this.elCount = opts.elCount;
    this.opts = opts;
    this.tasks = new Map(); // id -> task
    this.rows = new Map(); // id -> {root, bar, pct, speed, status, sub, actions}
    this.rafPending = false;
  }

  /** 全量替换（快照） */
  setAll(list) {
    this.tasks.clear();
    for (const t of list) this.tasks.set(t.id, t);
    this.renderAll();
  }

  upsert(task) {
    const existed = this.tasks.has(task.id);
    this.tasks.set(task.id, task);
    if (!existed) {
      this.elBody.appendChild(this._row(task));
    } else {
      this._updateRow(task);
    }
    this.updateGlobal();
  }

  remove(ids) {
    for (const id of ids) {
      this.tasks.delete(id);
      const r = this.rows.get(id);
      if (r) {
        r.root.remove();
        this.rows.delete(id);
      }
    }
    this.updateGlobal();
  }

  /** 批量进度（250ms 一批） */
  applyProgress(batch) {
    for (const p of batch) {
      const t = this.tasks.get(p.id);
      if (!t) continue;
      t.done = p.done;
      t.speed = p.speed;
      t.status = p.status;
      const r = this.rows.get(p.id);
      if (!r) continue;
      const ratio = t.size ? Math.min(1, p.done / t.size) : 1;
      r.bar.style.width = (ratio * 100).toFixed(2) + '%';
      r.pct.textContent = (ratio * 100).toFixed(1) + '%';
      r.speed.textContent = p.status === 'downloading' ? Fmt.speed(p.speed) : '';
      r.sub.textContent = this._subText(t, p.done, p.speed);
    }
    this.updateGlobal();
  }

  _subText(t, done, speed) {
    if (t.status === 'error') return t.error || '失败';
    if (t.status === 'done') return Fmt.bytes(t.size);
    const d = done || 0;
    return `${Fmt.bytes(d)} / ${Fmt.bytes(t.size)}`;
  }

  _row(task) {
    const root = document.createElement('div');
    root.className = 'queue-row';

    /* 名称 */
    const nameWrap = document.createElement('div');
    nameWrap.className = 'q-name';
    const pathEl = document.createElement('div');
    pathEl.className = 'q-path';
    pathEl.textContent = task.path;
    pathEl.title = task.finalFile || task.path;
    const subEl = document.createElement('div');
    subEl.className = 'q-sub';
    subEl.textContent = this._subText(task, task.done, task.speed);
    nameWrap.append(pathEl, subEl);

    /* 进度条 */
    const barWrap = document.createElement('div');
    barWrap.className = 'q-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'q-bar';
    barWrap.appendChild(bar);

    /* 百分比 */
    const pct = document.createElement('div');
    pct.className = 'q-pct';
    const ratio = task.size ? Math.min(1, (task.done || 0) / task.size) : 0;
    pct.textContent = (ratio * 100).toFixed(1) + '%';

    /* 速度 */
    const spd = document.createElement('div');
    spd.className = 'q-speed';

    /* 状态 + 操作 */
    const actions = document.createElement('div');
    actions.className = 'q-actions';

    root.append(nameWrap, barWrap, pct, spd, actions);

    const rec = { root, bar, pct, speed: spd, sub: subEl, actions, statusEl: null };
    this.rows.set(task.id, rec);
    this._renderActions(task, rec);
    this._applyBarClass(task, bar);
    return root;
  }

  _applyBarClass(task, bar) {
    bar.classList.remove('done', 'err', 'paused');
    if (task.status === 'done') bar.classList.add('done');
    else if (task.status === 'error') bar.classList.add('err');
    else if (task.status === 'paused') bar.classList.add('paused');
  }

  _renderActions(task, rec) {
    rec.actions.replaceChildren();

    const st = document.createElement('span');
    st.className = 'q-status ' + task.status;
    st.textContent = STATUS_TEXT[task.status] || task.status;
    rec.statusEl = st;
    rec.actions.appendChild(st);

    const mk = (label, title, fn, cls) => {
      const b = document.createElement('button');
      b.className = 'mini-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.title = title || label;
      b.addEventListener('click', fn);
      rec.actions.appendChild(b);
      return b;
    };

    const s = task.status;
    if (s === 'downloading' || s === 'preparing' || s === 'finalizing') {
      mk('暂停', '暂停下载', () => this.opts.onPause([task.id]));
      mk('取消', '取消并删除临时文件', () => this.opts.onCancel([task.id]), 'danger');
    } else if (s === 'paused' || s === 'error' || s === 'pending') {
      mk('继续', '继续下载', () => this.opts.onResume([task.id]));
      mk('取消', '取消并删除临时文件', () => this.opts.onCancel([task.id]), 'danger');
    } else if (s === 'done') {
      mk('打开', '在资源管理器中显示', () => this.opts.onOpen(task.id));
    }
  }

  _updateRow(task) {
    const r = this.rows.get(task.id);
    if (!r) {
      this.elBody.appendChild(this._row(task));
      return;
    }
    const ratio = task.size ? Math.min(1, (task.done || 0) / task.size) : 0;
    r.bar.style.width = (ratio * 100).toFixed(2) + '%';
    r.pct.textContent = (ratio * 100).toFixed(1) + '%';
    r.speed.textContent = task.status === 'downloading' ? Fmt.speed(task.speed || 0) : '';
    r.sub.textContent = this._subText(task, task.done, task.speed);
    r.sub.classList.toggle('err', task.status === 'error');
    this._applyBarClass(task, r.bar);
    this._renderActions(task, r);
  }

  renderAll() {
    this.elBody.replaceChildren();
    this.rows.clear();
    for (const t of this.tasks.values()) {
      this.elBody.appendChild(this._row(t));
    }
    this.updateGlobal();
  }

  updateGlobal() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      let totalSpeed = 0;
      let remaining = 0;
      let active = 0;
      for (const t of this.tasks.values()) {
        if (t.status === 'downloading') {
          active++;
          totalSpeed += t.speed || 0;
          remaining += Math.max(0, (t.size || 0) - (t.done || 0));
        }
      }
      this.elSpeed.textContent = active ? Fmt.speed(totalSpeed) : '0 B/s';
      this.elEta.textContent =
        active && totalSpeed > 1024 ? `剩余约 ${Fmt.eta(remaining / totalSpeed)}` : '';
      this.elCount.textContent = this.tasks.size ? String(this.tasks.size) : '';
    });
  }
}
