/* 所有 IPC 通道注册 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, shell, clipboard, app } = require('electron');
const { parseRepoInput, loadRepo, resolveUrl, cacheClear } = require('./net/hf-api');
const { APP_ROOT, DATA_DIR, LOG_DIR } = require('./paths');
const log = require('./util/log');

function register(ctx) {
  const { settings, history, parseHistory, manager, getWindow } = ctx;

  /* ---------- 解析 ---------- */
  ipcMain.handle('hf:parse', async (_e, input) => {
    const parsed = parseRepoInput(input);
    return parsed;
  });

  ipcMain.handle('hf:load', async (_e, payload) => {
    const p = payload || {};
    const s = settings.get();
    const mirror = p.mirror || s.mirror;
    const parsed = parseRepoInput(p.input || p.repo);
    const rev = p.rev || parsed.rev || 'main';

    log.info(`加载仓库 ${parsed.id}@${rev}（镜像 ${mirror}）`);
    const result = await loadRepo(mirror, parsed.id, rev, !!p.force);

    // 成功解析后记入历史，供主页「最近解析」使用
    parseHistory.add({
      repo: parsed.id,
      rev,
      fileCount: result.stats.fileCount,
      totalBytes: result.stats.totalBytes,
    });

    return {
      repo: parsed.id,
      rev,
      subPath: parsed.subPath || '',
      repoInfo: result.repoInfo,
      entries: result.entries,
      stats: result.stats,
      mirror,
    };
  });

  /* ---------- 下载 ---------- */
  ipcMain.handle('dl:enqueue', async (_e, payload) => {
    const p = payload || {};
    return manager.enqueue(p.items || [], {
      repo: p.repo,
      rev: p.rev || 'main',
      destDir: p.destDir || settings.get().destDir,
    });
  });

  ipcMain.handle('dl:pause', async (_e, ids) => manager.pause(ids));
  ipcMain.handle('dl:resume', async (_e, ids) => manager.resume(ids));
  ipcMain.handle('dl:cancel', async (_e, ids) => manager.cancel(ids));
  ipcMain.handle('dl:clearDone', async () => manager.clearDone());
  ipcMain.handle('dl:snapshot', async () => manager.snapshot());

  ipcMain.handle('dl:openFolder', async (_e, id) => {
    const t = manager.byId.get(id);
    if (!t) return { ok: false };
    const target = t.status === 'done' ? t.finalFile : path.dirname(t.finalFile);
    try {
      if (t.status === 'done' && fs.existsSync(target)) {
        shell.showItemInFolder(target);
      } else {
        await shell.openPath(path.dirname(t.finalFile));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /* ---------- 设置 ---------- */
  ipcMain.handle('set:get', async () => settings.get());
  ipcMain.handle('set:set', async (_e, patch) => {
    const next = settings.set(patch);
    manager.applySettings(next);
    cacheClear(); // 镜像变了，缓存作废
    return next;
  });

  /* ---------- 应用 ---------- */
  ipcMain.handle('app:pickDir', async () => {
    const win = getWindow();
    const r = await dialog.showOpenDialog(win, {
      title: '选择下载目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.get().destDir,
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('app:openPath', async (_e, p) => {
    try {
      await shell.openPath(String(p));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('app:openDataDir', async () => {
    await shell.openPath(DATA_DIR);
    return { ok: true };
  });

  ipcMain.handle('app:openLogDir', async () => {
    await shell.openPath(LOG_DIR);
    return { ok: true };
  });

  ipcMain.handle('app:copyText', async (_e, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('app:resolveUrl', async (_e, p) => {
    const s = settings.get();
    return resolveUrl(p.mirror || s.mirror, p.repo, p.rev || 'main', p.path);
  });

  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    appRoot: APP_ROOT,
    dataDir: DATA_DIR,
  }));

  /* ---------- 历史 ---------- */
  ipcMain.handle('hist:list', async () => history.list());
  ipcMain.handle('hist:clear', async () => history.clear());

  /* ---------- 解析历史 ---------- */
  ipcMain.handle('phist:list', async () => parseHistory.list());
  ipcMain.handle('phist:remove', async (_e, p) => parseHistory.remove(p.repo, p.rev));
  ipcMain.handle('phist:clear', async () => parseHistory.clear());
}

module.exports = { register };
