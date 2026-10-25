/*
 * 路径常量 —— 绿色版（免安装）能成立的前提
 *
 * 这个文件必须【最先】被 require，因为 app.setPath('userData') 有时序要求：
 * 必须在 whenReady 之前调用，且目标目录要先存在。
 *
 * 两个根目录必须分开，不能合并：
 *
 *   CODE_ROOT  代码根。开发态 = 项目目录；打包后 = .../resources/app.asar（只读）
 *   APP_ROOT   数据根。开发态 = 项目目录；打包后 = exe 所在目录（可写）
 *
 * 为什么必须分开：打包后 __dirname 在 asar 虚拟路径内部，那是只读的，
 * 往里面写 _数据 必然失败。而用户期望的"绿色"语义是——数据就在 exe 旁边，
 * 整个文件夹拷走就带着配置和下载记录。
 *
 * 这也是 electron-builder 必须用 target:"dir" 的原因：
 * portable 目标产出单文件自解压 exe，运行时会解压到 %TEMP% 随机目录，
 * process.execPath 跟着指向临时目录，exe 同级的 _数据 就彻底找不到了。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/* 代码根：shell/ 的上一级 */
const CODE_ROOT = path.resolve(__dirname, '..');

/* 数据根：打包后是 exe 所在目录 */
const APP_ROOT = app.isPackaged ? path.dirname(process.execPath) : CODE_ROOT;

const DATA_DIR = path.join(APP_ROOT, '_数据');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const STATE_FILE = path.join(DATA_DIR, 'downloads.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

/* Chromium 自己的缓存/配置也塞进 _数据，避免污染 %APPDATA% */
const ELECTRON_DATA = path.join(DATA_DIR, 'electron');

for (const d of [DATA_DIR, LOG_DIR, ELECTRON_DATA]) {
  fs.mkdirSync(d, { recursive: true });
}

app.setPath('userData', ELECTRON_DATA);

module.exports = {
  CODE_ROOT,
  APP_ROOT,
  DATA_DIR,
  LOG_DIR,
  STATE_FILE,
  SETTINGS_FILE,
  HISTORY_FILE,
  ELECTRON_DATA,
};
