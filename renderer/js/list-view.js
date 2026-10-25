/*
 * 右侧文件列表 + 面包屑
 *
 * 只渲染当前目录的直接子项（一层），所以不需要虚拟滚动。
 */
'use strict';

class ListView {
  constructor(opts) {
    this.elFiles = opts.elFiles;
    this.elCrumb = opts.elCrumb;
    this.elEmpty = opts.elEmpty;
    this.model = null;
    this.current = null;
    this.filterText = '';
    this.rowEls = new Map(); // path -> element
    this.opts = opts;
  }

  setModel(model, repoName) {
    this.model = model;
    this.repoName = repoName || '';
    this.filterText = '';
    this.rowEls.clear();
    // 空模型（null 或没有文件）→ 显示空状态提示
    if (!model || !model.files().length) {
      this.current = null;
      this.elEmpty.classList.remove('hidden');
      this.elFiles.classList.add('hidden');
      this.elCrumb.replaceChildren();
      return;
    }
    this.navigate('');
  }

  navigate(dirPath) {
    if (!this.model) return;
    const dir = this.model.get(dirPath || '');
    if (!dir || dir.type !== 'dir') return;
    this.current = dir;
    this.renderCrumb();
    this.render();
  }

  setFilter(text) {
    this.filterText = String(text || '').trim().toLowerCase();
    this.render();
  }

  /** 当前可见（经过筛选的）文件 */
  visibleFiles() {
    if (!this.current) return [];
    const out = [];
    for (const c of this.current.children) {
      if (this.filterText && !c.name.toLowerCase().includes(this.filterText)) continue;
      out.push(c);
    }
    return out;
  }

  render() {
    if (!this.current) {
      this.elEmpty.classList.remove('hidden');
      this.elFiles.classList.add('hidden');
      return;
    }
    this.elEmpty.classList.add('hidden');
    this.elFiles.classList.remove('hidden');
    this.rowEls.clear();

    const frag = document.createDocumentFragment();
    const items = this.visibleFiles();
    for (const child of items) {
      frag.appendChild(this._row(child));
    }
    this.elFiles.replaceChildren(frag);
  }

  _row(node) {
    const isDir = node.type === 'dir';
    const row = document.createElement('div');
    row.className = 'file-row' + (isDir ? ' dir' : '');
    row.dataset.path = node.path;
    if (!isDir && node.checked) row.classList.add('checked');
    row.setAttribute('role', 'option');

    /* 复选框 */
    const cChk = document.createElement('span');
    cChk.className = 'c-chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    if (isDir) {
      applyTriState(cb, this.model.dirState(node));
    } else {
      cb.checked = !!node.checked;
    }
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isDir) {
        const touched = this.model.setDirChecked(node, cb.checked);
        this.opts.onSelectionChange(touched, node);
      } else {
        const changed = this.model.setFileChecked(node, cb.checked);
        this.opts.onSelectionChange(changed ? [node] : [], node);
      }
    });
    cChk.appendChild(cb);

    /* 图标 */
    const cIco = document.createElement('span');
    cIco.className = 'c-ico';
    if (isDir) {
      const f = document.createElement('span');
      f.className = 'folder-icon';
      cIco.appendChild(f);
    } else {
      const info = Fmt.extInfo(node.name);
      const b = document.createElement('span');
      b.className = 'badge';
      b.dataset.t = info.kind;
      b.textContent = info.text;
      cIco.appendChild(b);
    }

    /* 名称 */
    const cName = document.createElement('span');
    cName.className = 'c-name';
    if (isDir) {
      const s = document.createElement('span');
      s.className = 'dir-name';
      s.textContent = node.name;
      cName.appendChild(s);
      const n = document.createElement('span');
      n.style.color = 'var(--fg-2)';
      n.style.fontSize = '11.5px';
      n.textContent = node.fileCount ? `  (${node.fileCount} 个文件)` : '';
      cName.appendChild(n);
    } else {
      cName.textContent = node.name;
      cName.title = node.path;
    }

    /* 大小 */
    const cSize = document.createElement('span');
    cSize.className = 'c-size';
    cSize.textContent = isDir ? (node.totalSize ? Fmt.bytes(node.totalSize) : '—') : Fmt.bytes(node.size);

    /* 类型 */
    const cType = document.createElement('span');
    cType.className = 'c-type';
    cType.textContent = Fmt.typeLabel(node.name, isDir);

    row.append(cChk, cIco, cName, cSize, cType);

    if (isDir) {
      row.addEventListener('click', () => {
        this.navigate(node.path);
        if (this.opts.onNavigate) this.opts.onNavigate(node);
      });
      row.addEventListener('dblclick', () => {
        this.navigate(node.path);
        if (this.opts.onNavigate) this.opts.onNavigate(node);
      });
    } else {
      // 单击行切换勾选，符合资源管理器里选文件的直觉
      row.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const next = !node.checked;
        const changed = this.model.setFileChecked(node, next);
        cb.checked = next;
        row.classList.toggle('checked', next);
        if (changed) this.opts.onSelectionChange([node], node);
      });
      // 右键复制镜像直链
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (this.opts.onContextMenu) this.opts.onContextMenu(node, e);
      });
    }

    this.rowEls.set(node.path, row);
    return row;
  }

  renderCrumb() {
    this.elCrumb.replaceChildren();
    if (!this.current) return;

    const items = [{ label: this.repoName || '仓库根目录', path: '' }];
    if (this.current.path) {
      let acc = '';
      for (const p of this.current.path.split('/')) {
        acc = acc ? acc + '/' + p : p;
        items.push({ label: p, path: acc });
      }
    }

    items.forEach((it, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        this.elCrumb.appendChild(sep);
      }
      const b = document.createElement('button');
      b.className = 'crumb-item' + (i === items.length - 1 ? ' current' : '');
      b.textContent = it.label;
      b.addEventListener('click', () => {
        this.navigate(it.path);
        if (this.opts.onNavigate) this.opts.onNavigate(this.current);
      });
      this.elCrumb.appendChild(b);
    });
  }

  /** 勾选变化后刷新可见行 */
  refreshRows() {
    for (const [p, row] of this.rowEls) {
      const node = this.model.get(p);
      if (!node) continue;
      const cb = row.querySelector('input[type="checkbox"]');
      if (!cb) continue;
      if (node.type === 'dir') {
        applyTriState(cb, this.model.dirState(node));
      } else {
        cb.checked = !!node.checked;
        row.classList.toggle('checked', !!node.checked);
      }
    }
    this.refreshHeaderCheckbox();
  }

  /** 工具栏「全选」的三态 */
  refreshHeaderCheckbox() {
    const el = document.getElementById('chk-all');
    if (!el || !this.current) return;
    const items = this.visibleFiles();
    if (!items.length) {
      el.checked = false;
      el.indeterminate = false;
      el.disabled = true;
      return;
    }
    el.disabled = false;
    let checked = 0;
    let total = 0;
    for (const n of items) {
      if (n.type === 'file') {
        total++;
        if (n.checked) checked++;
      } else {
        total += n.fileCount;
        checked += n.checkedCount;
      }
    }
    if (total === 0) {
      el.checked = false;
      el.indeterminate = false;
    } else if (checked === 0) {
      el.checked = false;
      el.indeterminate = false;
    } else if (checked === total) {
      el.checked = true;
      el.indeterminate = false;
    } else {
      el.checked = false;
      el.indeterminate = true;
    }
  }

  /** 全选 / 取消全选当前可见项 */
  toggleAll(on) {
    if (!this.current) return [];
    const touched = [];
    for (const n of this.visibleFiles()) {
      if (n.type === 'dir') {
        touched.push(...this.model.setDirChecked(n, on));
      } else if (this.model.setFileChecked(n, on)) {
        touched.push(n);
      }
    }
    return touched;
  }

  /** 反选当前可见项 */
  invert() {
    if (!this.current) return [];
    const touched = [];
    for (const n of this.visibleFiles()) {
      if (n.type === 'dir') {
        const state = this.model.dirState(n);
        const target = state !== 'all';
        touched.push(...this.model.setDirChecked(n, target));
      } else {
        if (this.model.setFileChecked(n, !n.checked)) touched.push(n);
      }
    }
    return touched;
  }
}
