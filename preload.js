/*
 * 渲染进程与主进程之间的桥
 *
 * 只暴露白名单方法。contextIsolation + sandbox 下，渲染进程拿不到 require/fs/net，
 * 所有网络和文件操作都在主进程完成。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 包一层：把主进程抛的 HfError 变成可读的 { ok, error } */
async function call(channel, ...args) {
  try {
    const data = await ipcRenderer.invoke(channel, ...args);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function on(channel, cb) {
  const handler = (_e, payload) => {
    try { cb(payload); } catch (err) { console.error(err); }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('hf', {
  /* 解析 */
  parse: (input) => call('hf:parse', input),
  load: (payload) => call('hf:load', payload),

  /* 下载 */
  enqueue: (payload) => call('dl:enqueue', payload),
  pause: (ids) => call('dl:pause', ids),
  resume: (ids) => call('dl:resume', ids),
  cancel: (ids) => call('dl:cancel', ids),
  clearDone: () => call('dl:clearDone'),
  snapshot: () => call('dl:snapshot'),
  openFolder: (id) => call('dl:openFolder', id),

  /* 设置 */
  getSettings: () => call('set:get'),
  setSettings: (patch) => call('set:set', patch),

  /* 应用 */
  pickDir: () => call('app:pickDir'),
  openPath: (p) => call('app:openPath', p),
  openDataDir: () => call('app:openDataDir'),
  openLogDir: () => call('app:openLogDir'),
  copyText: (t) => call('app:copyText', t),
  resolveUrl: (p) => call('app:resolveUrl', p),
  info: () => call('app:info'),

  /* 历史 */
  history: () => call('hist:list'),
  clearHistory: () => call('hist:clear'),

  /* 解析历史 */
  parseHistory: () => call('phist:list'),
  removeParseHistory: (repo, rev) => call('phist:remove', { repo, rev }),
  clearParseHistory: () => call('phist:clear'),

  /* 事件 */
  onProgress: (cb) => on('dl:progress', cb),
  onTask: (cb) => on('dl:task', cb),
  onRemoved: (cb) => on('dl:removed', cb),
  onLog: (cb) => on('dl:log', cb),
});
