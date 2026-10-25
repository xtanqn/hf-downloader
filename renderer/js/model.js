/*
 * 文件树模型 + 勾选级联
 *
 * 设计决策：目录【不存 checked】，只存 checkedCount，状态全部派生。
 * 这消灭了"父目录勾了但子文件没同步"这类经典 bug —— 因为不存在两份真相。
 */
'use strict';

class TreeModel {
  constructor() {
    this.byPath = new Map();
    this.root = this._mkDir('', null);
    this.byPath.set('', this.root);
  }

  _mkDir(name, parent) {
    const p = parent ? (parent.path ? parent.path + '/' : '') + name : '';
    return {
      type: 'dir',
      name,
      path: p,
      parent,
      children: [],
      expanded: false,
      fileCount: 0,
      checkedCount: 0,
      totalSize: 0,
    };
  }

  _ensureDir(p) {
    if (this.byPath.has(p)) return this.byPath.get(p);
    const i = p.lastIndexOf('/');
    const parent = this._ensureDir(i < 0 ? '' : p.slice(0, i));
    const node = this._mkDir(i < 0 ? p : p.slice(i + 1), parent);
    parent.children.push(node);
    this.byPath.set(p, node);
    return node;
  }

  /** entries: HF tree API 返回的扁平数组 */
  build(entries) {
    this.byPath.clear();
    this.root = this._mkDir('', null);
    this.byPath.set('', this.root);

    for (const e of entries) {
      if (e.type === 'directory') {
        this._ensureDir(e.path);
        continue;
      }
      const i = e.path.lastIndexOf('/');
      const parent = this._ensureDir(i < 0 ? '' : e.path.slice(0, i));
      const node = {
        type: 'file',
        name: e.path.slice(i + 1),
        path: e.path,
        parent,
        size: Number(e.size) || 0,
        oid: e.lfs && e.lfs.oid ? e.lfs.oid : e.oid || '',
        checked: false,
      };
      parent.children.push(node);
      this.byPath.set(e.path, node);
    }

    // 排序（目录在前）+ 自底向上累加统计
    const roll = (n) => {
      n.fileCount = 0;
      n.totalSize = 0;
      n.checkedCount = 0;
      for (const c of n.children) {
        if (c.type === 'dir') {
          roll(c);
          n.fileCount += c.fileCount;
          n.totalSize += c.totalSize;
        } else {
          n.fileCount++;
          n.totalSize += c.size;
        }
      }
      n.children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh', { numeric: true });
      });
    };
    roll(this.root);
    return this;
  }

  get(path) {
    return this.byPath.get(path) || null;
  }

  dirs() {
    return [...this.byPath.values()].filter((n) => n.type === 'dir' && n.path !== '');
  }

  files() {
    return [...this.byPath.values()].filter((n) => n.type === 'file');
  }

  /* ---------- 勾选 ---------- */

  setFileChecked(node, on) {
    if (node.checked === on) return false;
    node.checked = on;
    const delta = on ? 1 : -1;
    // 沿祖先链增量更新 —— O(深度)，不是 O(子树)
    for (let p = node.parent; p; p = p.parent) p.checkedCount += delta;
    return true;
  }

  /** 勾选/取消整个目录，返回状态变化的文件列表 */
  setDirChecked(dir, on) {
    const touched = [];
    const stack = [dir];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === 'file') {
        if (this.setFileChecked(n, on)) touched.push(n);
        continue;
      }
      for (const c of n.children) stack.push(c);
    }
    return touched;
  }

  /** 'all' | 'partial' | 'none' */
  dirState(dir) {
    if (!dir.fileCount) return 'none';
    if (!dir.checkedCount) return 'none';
    return dir.checkedCount === dir.fileCount ? 'all' : 'partial';
  }

  selectedFiles() {
    const out = [];
    for (const n of this.byPath.values()) {
      if (n.type === 'file' && n.checked) out.push(n);
    }
    return out;
  }

  selectedBytes() {
    let n = 0;
    for (const f of this.byPath.values()) {
      if (f.type === 'file' && f.checked) n += f.size;
    }
    return n;
  }

  selectedCount() {
    let n = 0;
    for (const f of this.byPath.values()) {
      if (f.type === 'file' && f.checked) n++;
    }
    return n;
  }

  clearAll() {
    for (const n of this.byPath.values()) {
      if (n.type === 'file') n.checked = false;
      else n.checkedCount = 0;
    }
  }

  /** 收集某个目录下所有已选文件的祖先目录集合（用于最小刷新） */
  ancestorsOf(files) {
    const set = new Set();
    for (const f of files) {
      for (let p = f.parent; p; p = p.parent) set.add(p.path);
    }
    return set;
  }
}

/** 三态复选框 */
function applyTriState(cb, state) {
  cb.checked = state === 'all';
  cb.indeterminate = state === 'partial';
}
