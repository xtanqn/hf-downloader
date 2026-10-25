/*
 * 左侧目录树
 *
 * 只显示目录，不显示文件（左右分工模仿资源管理器）。
 * 增量渲染：展开/折叠只插入或移除对应的行，不整树重绘，
 * 这样滚动位置和焦点都不会丢。
 */
'use strict';

class TreeView {
  constructor(el, opts) {
    this.el = el;
    this.opts = opts || {};
    this.model = null;
    this.rowEls = new Map(); // path -> element
    this.activePath = '';
  }

  setModel(model) {
    this.model = model;
    this.activePath = '';
    this.render();
  }

  render() {
    this.el.replaceChildren();
    this.rowEls.clear();
    if (!this.model) return;

    const frag = document.createDocumentFragment();
    // 根目录本身不显示，直接展开它的子目录
    this._insertChildren(this.model.root, 0, frag);
    this.el.appendChild(frag);
  }

  _insertChildren(dir, depth, frag) {
    for (const child of dir.children) {
      if (child.type !== 'dir') continue;
      frag.appendChild(this._row(child, depth));
      if (child.expanded) this._insertChildren(child, depth + 1, frag);
    }
  }

  _row(dir, depth) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = dir.path;
    row.dataset.depth = String(depth);
    row.style.paddingLeft = 8 + depth * 15 + 'px';
    row.setAttribute('role', 'treeitem');
    if (dir.path === this.activePath) row.classList.add('active');

    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = dir.expanded ? '▾' : '▸';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    applyTriState(cb, this.model.dirState(dir));
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      const on = cb.checked;
      const touched = this.model.setDirChecked(dir, on);
      this.refreshAncestors(touched);
      this.refreshDirRow(dir);
      if (this.opts.onToggle) this.opts.onToggle(touched, dir);
    });

    const ico = document.createElement('span');
    ico.className = 'folder-ico';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = dir.name; // textContent：目录名不参与 HTML 解析

    const count = document.createElement('span');
    count.className = 'count';
    this._setCountText(count, dir);

    row.append(caret, cb, ico, name, count);

    row.addEventListener('click', () => {
      // 点整行 = 进入该目录（不展开折叠，避免误操作）
      this.setActive(dir.path);
      if (this.opts.onNavigate) this.opts.onNavigate(dir);
    });

    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleExpand(dir);
    });

    this.rowEls.set(dir.path, row);
    return row;
  }

  _setCountText(el, dir) {
    el.className = 'count';
    if (!dir.fileCount) {
      el.textContent = '';
      return;
    }
    if (dir.checkedCount === 0) {
      el.textContent = String(dir.fileCount);
      return;
    }
    el.textContent = `${dir.checkedCount}/${dir.fileCount}`;
    el.classList.add(dir.checkedCount === dir.fileCount ? 'full' : 'partial');
  }

  toggleExpand(dir) {
    dir.expanded = !dir.expanded;
    const row = this.rowEls.get(dir.path);
    if (!row) return;

    const caret = row.querySelector('.caret');
    if (caret) caret.textContent = dir.expanded ? '▾' : '▸';

    if (dir.expanded) {
      const depth = Number(row.dataset.depth) + 1;
      const frag = document.createDocumentFragment();
      this._insertChildren(dir, depth, frag);
      row.after(frag);
    } else {
      const depth = Number(row.dataset.depth);
      let el = row.nextElementSibling;
      while (el && Number(el.dataset.depth) > depth) {
        const next = el.nextElementSibling;
        const p = el.dataset.path;
        el.remove();
        if (p) this.rowEls.delete(p);
        el = next;
      }
      // 折叠后，子孙的 expanded 状态保留在模型里，重新展开会恢复
    }
  }

  expandAll() {
    if (!this.model) return;
    for (const d of this.model.dirs()) d.expanded = true;
    this.render();
  }

  /** 勾选变化后，更新某个目录行的复选框和计数 */
  refreshDirRow(dir) {
    const row = this.rowEls.get(dir.path);
    if (!row) return;
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb) applyTriState(cb, this.model.dirState(dir));
    const count = row.querySelector('.count');
    if (count) this._setCountText(count, dir);
  }

  /** 只刷新受影响的祖先目录（最小刷新） */
  refreshAncestors(files) {
    if (!this.model) return;
    const paths = this.model.ancestorsOf(files);
    // 包含根
    for (const p of paths) {
      const d = this.model.get(p);
      if (d && d.type === 'dir') this.refreshDirRow(d);
    }
  }

  /** 全量刷新所有目录行（全选/反选后调用，成本很低） */
  refreshAll() {
    if (!this.model) return;
    for (const [p, row] of this.rowEls) {
      const d = this.model.get(p);
      if (!d || d.type !== 'dir') continue;
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) applyTriState(cb, this.model.dirState(d));
      const count = row.querySelector('.count');
      if (count) this._setCountText(count, d);
    }
  }

  setActive(path) {
    if (this.activePath === path) return;
    const prev = this.rowEls.get(this.activePath);
    if (prev) prev.classList.remove('active');
    this.activePath = path;
    const cur = this.rowEls.get(path);
    if (cur) cur.classList.add('active');
  }

  /** 展开到某个目录（让它在树里可见） */
  revealPath(path) {
    if (!this.model) return;
    const parts = String(path).split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      const d = this.model.get(acc);
      if (!d || d.type !== 'dir') break;
      // 最后一级不需要展开
      if (i < parts.length - 1 && !d.expanded) {
        d.expanded = true;
        this.render();
        return; // render 会重建整棵树，跳出
      }
    }
  }
}
