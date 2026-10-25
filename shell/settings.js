/* 设置读写 */
'use strict';

const fs = require('fs');
const path = require('path');
const { SETTINGS_FILE, APP_ROOT } = require('./paths');

const DEFAULTS = {
  destDir: path.join(APP_ROOT, '下载'),
  layout: 'repo', // 'repo' 带仓库名 | 'flat' 扁平化 | 'comfyui' ComfyUI 分类
  comfyuiDir: '', // ComfyUI 模式下的根目录（如 E:\ComfyUI\models）
  mirror: 'https://hf-mirror.com',
  maxFiles: 3,
  chunksPerFile: 8,
  maxConnections: 16,
  theme: 'dark', // 'dark' | 'light'
};

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function normalize(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  s.destDir = String(s.destDir || DEFAULTS.destDir);
  // 兼容旧版 flatLayout 布尔值
  if (raw && raw.flatLayout === true && !raw.layout) s.layout = 'flat';
  if (!['repo', 'flat', 'comfyui'].includes(s.layout)) s.layout = 'repo';
  s.comfyuiDir = String(s.comfyuiDir || '').trim();
  s.mirror = String(s.mirror || DEFAULTS.mirror).trim().replace(/\/+$/, '') || DEFAULTS.mirror;
  if (!/^https?:\/\//i.test(s.mirror)) s.mirror = 'https://' + s.mirror;
  s.maxFiles = clampInt(s.maxFiles, 1, 8, DEFAULTS.maxFiles);
  s.chunksPerFile = clampInt(s.chunksPerFile, 1, 16, DEFAULTS.chunksPerFile);
  s.maxConnections = clampInt(s.maxConnections, 1, 32, DEFAULTS.maxConnections);
  s.theme = s.theme === 'light' ? 'light' : 'dark';
  return s;
}

class Settings {
  constructor() {
    this.data = DEFAULTS;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      this.data = normalize(JSON.parse(raw));
    } catch {
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }

  get() {
    return { ...this.data };
  }

  set(patch) {
    this.data = normalize({ ...this.data, ...(patch || {}) });
    this.save();
    return this.get();
  }

  save() {
    const tmp = SETTINGS_FILE + '.tmp';
    try {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, SETTINGS_FILE);
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    }
  }
}

module.exports = { Settings, DEFAULTS };
