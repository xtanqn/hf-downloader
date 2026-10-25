/* 滚动日志：按天分文件，保留 7 天，单文件上限 5MB */
'use strict';

const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('../paths');

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_DAYS = 7;

let stream = null;
let streamDay = '';
let written = 0;

function dayKey(d) {
  const t = d || new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function logFilePath(day) {
  return path.join(LOG_DIR, `app-${day || dayKey()}.log`);
}

/** 清掉超过 KEEP_DAYS 的日志 */
function prune() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const name of fs.readdirSync(LOG_DIR)) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const p = path.join(LOG_DIR, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

function openStream() {
  const day = dayKey();
  if (stream && streamDay === day && written < MAX_BYTES) return stream;

  if (stream) {
    try { stream.end(); } catch {}
    stream = null;
  }

  streamDay = day;
  const p = logFilePath(day);
  try {
    written = fs.existsSync(p) ? fs.statSync(p).size : 0;
  } catch {
    written = 0;
  }

  stream = fs.createWriteStream(p, { flags: 'a', encoding: 'utf8' });
  stream.on('error', () => { stream = null; });
  return stream;
}

function line(level, text) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const msg = `[${ts}] [${level}] ${text}\n`;
  try {
    const s = openStream();
    if (s) {
      s.write(msg);
      written += Buffer.byteLength(msg);
    }
  } catch {}
  // 开发态同时打到控制台
  if (!require('electron').app.isPackaged) {
    (level === 'ERROR' ? console.error : console.log)(msg.trimEnd());
  }
}

module.exports = {
  info: (t) => line('INFO', t),
  warn: (t) => line('WARN', t),
  error: (t, e) => line('ERROR', e ? `${t} :: ${e.stack || e.message || e}` : t),
  debug: (t) => line('DEBUG', t),
  prune,
  logFilePath,
  dayKey,
};
