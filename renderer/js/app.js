/* 渲染进程主逻辑 */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  /* ---------- 全局状态 ---------- */
  const state = {
    model: null,
    repo: '',
    rev: 'main',
    repoInfo: null,
    stats: null,
    mirror: '',
    settings: null,
    loading: false,
  };

  let treeView = null;
  let listView = null;
  let queueView = null;
  let toastTimer = null;

  /* ---------- 提示条 ---------- */
  function toast(text, kind) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  /* ---------- 主题 ---------- */
  function applyTheme(theme) {
    const light = theme === 'light';
    document.body.classList.toggle('light', light);
    // 图标和文字一起变：显示的是「当前主题」，点击后切到另一个
    $('theme-icon').textContent = light ? '☀️' : '🌙';
    $('theme-label').textContent = light ? '亮色' : '深色';
    $('btn-theme').title = light ? '当前为亮色主题，点击切换到深色' : '当前为深色主题，点击切换到亮色';
  }

  async function toggleTheme() {
    const next = document.body.classList.contains('light') ? 'dark' : 'light';
    applyTheme(next);
    const r = await window.hf.setSettings({ theme: next });
    if (r.ok) state.settings = r.data;
  }

  /* ---------- 解析历史（主页快速入口） ---------- */
  async function renderParseHistory() {
    const box = $('parse-history');
    if (!box) return;
    const r = await window.hf.parseHistory();
    const items = r.ok ? r.data : [];

    box.replaceChildren();

    if (!items.length) {
      // 没有历史：显示内置示例
      const examples = [
        'stabilityai/stable-diffusion-xl-base-1.0',
        'black-forest-labs/FLUX.1-dev',
        'Qwen/Qwen3-8B',
      ];
      for (const repo of examples) {
        const el = document.createElement('div');
        el.className = 'ex-skeleton';
        el.textContent = repo;
        el.addEventListener('click', () => {
          $('repo-input').value = repo;
          doParse();
        });
        box.appendChild(el);
      }
      return;
    }

    // 标题行
    const head = document.createElement('div');
    head.className = 'ex-history-head';
    const label = document.createElement('span');
    label.textContent = '最近解析';
    head.appendChild(label);
    const clear = document.createElement('button');
    clear.className = 'mini-btn';
    clear.textContent = '清空';
    clear.addEventListener('click', async () => {
      if (!confirm('清空解析历史？')) return;
      await window.hf.clearParseHistory();
      renderParseHistory();
    });
    head.appendChild(clear);
    box.appendChild(head);

    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'ex';
      el.title = `点击解析 ${it.repo}（${it.rev}）`;

      const name = document.createElement('span');
      name.textContent = it.repo + (it.rev && it.rev !== 'main' ? `@${it.rev}` : '');
      el.appendChild(name);

      if (it.fileCount) {
        const meta = document.createElement('span');
        meta.className = 'ex-meta';
        meta.textContent = `${it.fileCount} 个文件 · ${Fmt.bytes(it.totalBytes)}`;
        el.appendChild(meta);
      }

      const del = document.createElement('button');
      del.className = 'ex-del';
      del.textContent = '✕';
      del.title = '从历史中删除';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.hf.removeParseHistory(it.repo, it.rev);
        renderParseHistory();
      });
      el.appendChild(del);

      el.addEventListener('click', () => {
        $('repo-input').value = it.repo + (it.rev && it.rev !== 'main' ? `@${it.rev}` : '');
        doParse();
      });
      box.appendChild(el);
    }
  }

  /* ---------- 返回主页 ---------- */
  function goHome() {
    // 清掉当前仓库状态，回到空状态
    state.repo = '';
    state.rev = 'main';
    state.repoInfo = null;
    state.stats = null;
    state.model = null;

    $('repo-bar').classList.add('hidden');
    $('repo-input').value = '';
    $('sel-stat').textContent = '已选 0 项 · 0 B';
    $('btn-start').disabled = true;
    $('btn-home-top').disabled = true;

    document.querySelector('.list-pane').classList.add('no-repo');
    treeView.setModel(new TreeModel());
    listView.setModel(new TreeModel(), '');

    renderParseHistory();
  }

  /* ---------- 初始化 ---------- */
  async function init() {
    // 视图
    treeView = new TreeView($('tree'), {
      onNavigate: (dir) => {
        listView.navigate(dir.path);
        listView.refreshRows();
      },
      onToggle: (touched) => {
        listView.refreshRows();
        updateSelStat();
      },
    });

    listView = new ListView({
      elFiles: $('files'),
      elCrumb: $('crumb'),
      elEmpty: $('empty-hint'),
      onSelectionChange: (touched, node) => {
        treeView.refreshAncestors(touched);
        listView.refreshRows();
        updateSelStat();
      },
      onNavigate: (dir) => {
        treeView.setActive(dir ? dir.path : '');
        listView.refreshRows();
      },
      onContextMenu: onFileContextMenu,
    });

    queueView = new QueueView({
      elBody: $('queue'),
      elPane: $('queue-pane'),
      elSpeed: $('q-speed'),
      elEta: $('q-eta'),
      elCount: $('queue-count'),
      onPause: (ids) => window.hf.pause(ids),
      onResume: (ids) => window.hf.resume(ids),
      onCancel: (ids) => {
        if (confirm('取消下载并删除已下载的临时文件？')) window.hf.cancel(ids);
      },
      onOpen: (id) => window.hf.openFolder(id),
    });

    // 设置
    const r = await window.hf.getSettings();
    if (r.ok) state.settings = r.data;
    applySettingsToForm();
    applyTheme(state.settings.theme || 'dark');

    // 初始是空状态：隐藏工具栏和表头，顶栏主页按钮不可用
    document.querySelector('.list-pane').classList.add('no-repo');
    $('btn-home-top').disabled = true;

    // 恢复队列
    const snap = await window.hf.snapshot();
    if (snap.ok && snap.data.length) queueView.setAll(snap.data);

    bindEvents();
    bindPushEvents();
    updateDestButton();
    renderParseHistory();
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $('btn-parse').addEventListener('click', doParse);
    $('repo-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doParse();
    });

    // 示例点击
    for (const el of document.querySelectorAll('.ex')) {
      el.addEventListener('click', () => {
        $('repo-input').value = el.dataset.repo;
        doParse();
      });
    }

    $('btn-expand-all').addEventListener('click', () => treeView.expandAll());

    $('chk-all').addEventListener('change', (e) => {
      const touched = listView.toggleAll(e.target.checked);
      treeView.refreshAll();
      listView.refreshRows();
      updateSelStat();
    });

    $('btn-invert').addEventListener('click', () => {
      listView.invert();
      treeView.refreshAll();
      listView.refreshRows();
      updateSelStat();
    });

    let filterTimer = null;
    $('filter').addEventListener('input', (e) => {
      if (filterTimer) clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        listView.setFilter(e.target.value);
        listView.refreshHeaderCheckbox();
      }, 120);
    });

    $('btn-dest').addEventListener('click', pickDest);
    $('btn-start').addEventListener('click', startDownload);

    $('btn-clear-done').addEventListener('click', () => window.hf.clearDone());

    $('btn-toggle-queue').addEventListener('click', () => {
      const pane = $('queue-pane');
      pane.classList.toggle('collapsed');
      $('btn-toggle-queue').textContent = pane.classList.contains('collapsed') ? '▸' : '▾';
    });

    // 设置弹窗
    $('btn-theme').addEventListener('click', toggleTheme);

    $('btn-home').addEventListener('click', goHome);
    $('btn-home-top').addEventListener('click', goHome);

    $('btn-settings').addEventListener('click', () => {
      applySettingsToForm();
      $('modal-settings').classList.remove('hidden');
    });
    $('btn-close-settings').addEventListener('click', () =>
      $('modal-settings').classList.add('hidden')
    );
    $('btn-save-settings').addEventListener('click', saveSettings);
    $('btn-pick-dest').addEventListener('click', async () => {
      const r = await window.hf.pickDir();
      if (r.ok && r.data) $('set-dest').value = r.data;
    });

    // 目录结构 radio：切到 comfyui 时展开目录选择行
    for (const el of document.querySelectorAll('input[name="layout"]')) {
      el.addEventListener('change', updateComfyuiRow);
    }
    $('btn-pick-comfyui').addEventListener('click', async () => {
      const r = await window.hf.pickDir();
      if (r.ok && r.data) $('set-comfyui-dir').value = r.data;
    });
    $('btn-open-data').addEventListener('click', () => window.hf.openDataDir());

    // 历史
    $('btn-hist').addEventListener('click', showHistory);
    $('btn-close-history').addEventListener('click', () =>
      $('modal-history').classList.add('hidden')
    );
    $('btn-hist-clear').addEventListener('click', async () => {
      if (!confirm('确定清空所有下载历史？')) return;
      await window.hf.clearHistory();
      toast('历史已清空', 'ok');
    });

    // 分隔条拖拽
    setupSplitter();

    // ESC 关弹窗
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $('modal-settings').classList.add('hidden');
        $('modal-history').classList.add('hidden');
      }
    });
  }

  function bindPushEvents() {
    window.hf.onProgress((batch) => queueView.applyProgress(batch));
    window.hf.onTask((t) => queueView.upsert(t));
    window.hf.onRemoved((ids) => queueView.remove(ids));
    window.hf.onLog((p) => {
      if (p.level === 'error') console.warn(p.text);
    });
  }

  function setupSplitter() {
    const sp = $('splitter');
    const pane = document.querySelector('.tree-pane');
    let dragging = false;

    sp.addEventListener('mousedown', (e) => {
      dragging = true;
      sp.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(180, Math.min(560, e.clientX));
      pane.style.width = w + 'px';
      document.querySelector('.workspace').style.gridTemplateColumns = `${w}px 4px 1fr`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove('dragging');
      document.body.style.cursor = '';
    });
  }

  /* ---------- 解析 ---------- */
  async function doParse() {
    const input = $('repo-input').value.trim();
    if (!input) {
      toast('请先输入模型地址', 'err');
      return;
    }
    if (state.loading) return;

    state.loading = true;
    $('btn-parse').disabled = true;
    $('btn-parse').textContent = '解析中…';

    try {
      const r = await window.hf.load({ input });
      if (!r.ok) {
        toast(r.error, 'err');
        return;
      }
      const d = r.data;

      state.repo = d.repo;
      state.rev = d.rev;
      state.repoInfo = d.repoInfo;
      state.stats = d.stats;
      state.mirror = d.mirror;

      state.model = new TreeModel().build(d.entries);
      treeView.setModel(state.model);
      listView.setModel(state.model, d.repo.split('/')[1]);

      // 已有仓库可浏览，恢复工具栏和表头
      document.querySelector('.list-pane').classList.remove('no-repo');
      $('btn-home-top').disabled = false;

      if (d.subPath) {
        treeView.revealPath(d.subPath);
        listView.navigate(d.subPath);
      }

      renderRepoBar(d);
      updateSelStat();
      // 后台刷新解析历史，下次回主页就是最新的
      renderParseHistory();
    } catch (e) {
      toast('解析失败：' + e.message, 'err');
    } finally {
      state.loading = false;
      $('btn-parse').disabled = false;
      $('btn-parse').textContent = '解析';
    }
  }

  function renderRepoBar(d) {
    const bar = $('repo-bar');
    bar.classList.remove('hidden');
    $('repo-name').textContent = d.repo;
    $('repo-rev').textContent = d.rev;

    const gated = d.repoInfo.gated;
    const gatedEl = $('repo-gated');
    if (gated && gated !== false) {
      gatedEl.classList.remove('hidden');
      gatedEl.title = '该仓库需要先在 Hugging Face 网站同意协议，否则下载会返回 403';
    } else {
      gatedEl.classList.add('hidden');
    }

    $('stat-files').textContent = `${Fmt.count(d.stats.fileCount)} 个文件`;
    $('stat-size').textContent = Fmt.bytes(d.stats.totalBytes);
    if (d.repoInfo.downloads) {
      $('stat-dl').textContent = `${Fmt.count(d.repoInfo.downloads)} 次下载`;
    } else {
      $('stat-dl').textContent = '';
    }
  }

  /* ---------- 选择统计 ---------- */
  function updateSelStat() {
    if (!state.model) {
      $('sel-stat').textContent = '已选 0 项 · 0 B';
      $('btn-start').disabled = true;
      return;
    }
    const n = state.model.selectedCount();
    const b = state.model.selectedBytes();
    $('sel-stat').textContent = `已选 ${n} 项 · ${Fmt.bytes(b)}`;
    $('btn-start').disabled = n === 0;
  }

  /* ---------- 右键菜单 ---------- */
  async function onFileContextMenu(node) {
    const r = await window.hf.resolveUrl({
      repo: state.repo,
      rev: state.rev,
      path: node.path,
    });
    if (!r.ok) {
      toast('生成链接失败', 'err');
      return;
    }
    await window.hf.copyText(r.data);
    toast('镜像直链已复制到剪贴板', 'ok');
  }

  /* ---------- 下载目录 ---------- */
  /** 当前布局下实际生效的落盘根目录 */
  function effectiveDest() {
    const s = state.settings;
    if (!s) return '';
    if ((s.layout || 'repo') === 'comfyui') return s.comfyuiDir || s.destDir;
    return s.destDir;
  }

  function updateDestButton() {
    const d = effectiveDest();
    const btn = $('btn-dest');
    const mode = state.settings && state.settings.layout === 'comfyui' ? '（ComfyUI 分类）' : '';
    btn.textContent = d ? `下载到：${shortenPath(d)}${mode}` : '下载到…';
    btn.title = d || '点击选择下载目录';
  }

  function shortenPath(p) {
    if (!p) return '';
    if (p.length <= 34) return p;
    return p.slice(0, 14) + '…' + p.slice(-16);
  }

  async function pickDest() {
    const r = await window.hf.pickDir();
    if (!r.ok || !r.data) return;
    const s = await window.hf.setSettings({ destDir: r.data });
    if (s.ok) {
      state.settings = s.data;
      updateDestButton();
      toast('下载目录已更新', 'ok');
    }
  }

  /* ---------- 开始下载 ---------- */
  async function startDownload() {
    if (!state.model) return;
    const files = state.model.selectedFiles();
    if (!files.length) {
      toast('请先勾选要下载的文件', 'err');
      return;
    }
    if (!state.settings || !state.settings.destDir) {
      toast('请先设置下载目录', 'err');
      return;
    }

    const items = files.map((f) => ({ path: f.path, size: f.size, oid: f.oid }));
    const r = await window.hf.enqueue({
      items,
      repo: state.repo,
      rev: state.rev,
      destDir: effectiveDest(),
    });

    if (!r.ok) {
      toast(r.error, 'err');
      return;
    }

    const { added, skipped } = r.data;
    let msg = `已加入队列 ${added.length} 项`;
    if (skipped.length) msg += `，跳过 ${skipped.length} 项`;
    toast(msg, added.length ? 'ok' : 'err');

    // 展开队列面板
    $('queue-pane').classList.remove('collapsed');
    $('btn-toggle-queue').textContent = '▾';
  }

  /* ---------- 设置 ---------- */
  function applySettingsToForm() {
    const s = state.settings;
    if (!s) return;
    $('set-dest').value = s.destDir || '';
    $('set-mirror').value = s.mirror || '';
    $('set-maxfiles').value = s.maxFiles;
    $('set-chunks').value = s.chunksPerFile;
    $('set-conns').value = s.maxConnections;
    const layout = s.layout || (s.flatLayout ? 'flat' : 'repo');
    $('set-layout-repo').checked = layout === 'repo';
    $('set-layout-flat').checked = layout === 'flat';
    $('set-layout-comfyui').checked = layout === 'comfyui';
    $('set-comfyui-dir').value = s.comfyuiDir || '';
    $('set-legacy-unet').checked = s.legacyUnetDir === true;
    updateComfyuiRow();
  }

  /** ComfyUI 目录行只在选中该模式时显示 */
  function updateComfyuiRow() {
    const on = $('set-layout-comfyui').checked;
    $('comfyui-dir-row').classList.toggle('hidden', !on);
    $('comfyui-hint').classList.toggle('hidden', !on);
    $('legacy-unet-row').classList.toggle('hidden', !on);
  }

  async function saveSettings() {
    const layout = document.querySelector('input[name="layout"]:checked').value;
    const patch = {
      destDir: $('set-dest').value.trim(),
      layout,
      comfyuiDir: $('set-comfyui-dir').value.trim(),
      legacyUnetDir: $('set-legacy-unet').checked,
      mirror: $('set-mirror').value.trim(),
      maxFiles: Number($('set-maxfiles').value),
      chunksPerFile: Number($('set-chunks').value),
      maxConnections: Number($('set-conns').value),
    };
    const r = await window.hf.setSettings(patch);
    if (!r.ok) {
      toast('保存失败：' + r.error, 'err');
      return;
    }
    state.settings = r.data;
    updateDestButton();
    applySettingsToForm();
    $('modal-settings').classList.add('hidden');
    toast('设置已保存', 'ok');
  }

  /* ---------- 历史 ---------- */
  async function showHistory() {
    const r = await window.hf.history();
    const body = $('history-body');
    body.replaceChildren();

    const items = r.ok ? r.data : [];
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'hist-empty';
      e.textContent = '还没有下载记录';
      body.appendChild(e);
    } else {
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'hist-row';

        const main = document.createElement('div');
        main.className = 'hist-main';
        const p = document.createElement('div');
        p.className = 'hist-path';
        p.textContent = it.path;
        p.title = it.finalFile || it.path;
        const rp = document.createElement('div');
        rp.className = 'hist-repo';
        rp.textContent = `${it.repo}  ·  ${Fmt.time(it.at)}`;
        main.append(p, rp);

        const size = document.createElement('div');
        size.className = 'hist-size';
        size.textContent = Fmt.bytes(it.size);

        const act = document.createElement('div');
        act.className = 'hist-act';

        const bOpen = document.createElement('button');
        bOpen.className = 'mini-btn';
        bOpen.textContent = '打开目录';
        bOpen.addEventListener('click', () => window.hf.openPath(it.destDir));
        act.appendChild(bOpen);

        const bFile = document.createElement('button');
        bFile.className = 'mini-btn';
        bFile.textContent = '定位文件';
        bFile.addEventListener('click', () => window.hf.openPath(it.finalFile));
        act.appendChild(bFile);

        row.append(main, size, act);
        body.appendChild(row);
      }
    }
    $('modal-history').classList.remove('hidden');
  }

  /* ---------- 启动 ---------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
