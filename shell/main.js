/*
 * HF 下载器 · 主进程
 *
 * 启动顺序不能错：
 *   1) paths.js 先跑 —— 它要 app.setPath('userData')，必须在 whenReady 之前
 *   2) 建窗口
 *   3) 注册 IPC
 */
'use strict';

const path = require('path');
const fs = require('fs');

// 必须先 require：里面有 app.setPath('userData')，有时序要求
const { CODE_ROOT, APP_ROOT, DATA_DIR, LOG_DIR } = require('./paths');

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const log = require('./util/log');
const { Settings } = require('./settings');
const { History } = require('./history');
const { ParseHistory } = require('./parse-history');
const { DownloadManager } = require('./download/manager');
const ipc = require('./ipc');

/* ---------- 单实例：重复双击时聚焦已有窗口 ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let settings = null;
let history = null;
let parseHistory = null;
let manager = null;

const getWindow = () => win;

/* ---------- 窗口 ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'HF 模型下载器',
    backgroundColor: '#15181d', // 深色底，避免加载瞬间白屏一闪
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(CODE_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  const indexHtml = path.join(CODE_ROOT, 'renderer', 'index.html');
  if (!fs.existsSync(indexHtml)) {
    dialog.showErrorBox('缺少界面文件', `找不到：\n${indexHtml}\n\n打包可能不完整。`);
    app.quit();
    return;
  }
  win.loadFile(indexHtml);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    dialog.showErrorBox(
      '界面加载失败',
      `无法打开：${url}\n\n错误：${desc}（${code}）\n\n日志目录：\n${LOG_DIR}`
    );
  });

  // 外部链接用系统浏览器打开，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

/* ---------- 菜单 ---------- */
function buildMenu() {
  const isDev = !app.isPackaged;
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(DATA_DIR),
        },
        {
          label: '打开日志目录',
          click: () => shell.openPath(LOG_DIR),
        },
        {
          label: '打开程序目录',
          click: () => shell.openPath(APP_ROOT),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 HF 模型下载器',
              message: 'HF 模型下载器',
              detail:
                `版本 ${app.getVersion()}\n`
                + `Electron ${process.versions.electron}\n`
                + `Node ${process.versions.node}\n\n`
                + `程序目录：${APP_ROOT}\n`
                + `数据目录：${DATA_DIR}\n\n`
                + '镜像站：hf-mirror.com',
              buttons: ['确定'],
            });
          },
        },
      ],
    },
  ];
  if (isDev) {
    template[1].submenu.unshift({ type: 'separator' });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 启动 ---------- */
app.whenReady().then(() => {
  try {
    log.prune();
    log.info('==== 应用启动 ====');
    log.info(`程序目录 ${APP_ROOT}`);
    log.info(`代码目录 ${CODE_ROOT}`);
    log.info(`数据目录 ${DATA_DIR}`);

    settings = new Settings();
    history = new History();
    parseHistory = new ParseHistory();

    createWindow();

    manager = new DownloadManager({
      win,
      settings: settings.get(),
      history,
      logger: log,
    });

    ipc.register({ settings, history, parseHistory, manager, getWindow });

    buildMenu();

    // 恢复未完成的任务：不自动开始，让用户自己决定
    const snap = manager.snapshot();
    if (snap.length) {
      log.info(`队列中有 ${snap.length} 个任务（未自动开始）`);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (e) {
    log.error('启动失败', e);
    dialog.showErrorBox('启动失败', `${e.message}\n\n日志：${LOG_DIR}`);
    app.quit();
  }
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  if (manager) manager.shutdown();
  app.quit();
});

app.on('before-quit', () => {
  if (manager) manager.shutdown();
  log.info('==== 应用退出 ====');
});

process.on('uncaughtException', (e) => {
  log.error('未捕获异常', e);
});
process.on('unhandledRejection', (e) => {
  log.error('未处理的 Promise 拒绝', e instanceof Error ? e : new Error(String(e)));
});
