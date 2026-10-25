/* 下载历史记录 */
'use strict';

const fs = require('fs');
const { HISTORY_FILE } = require('./paths');

const MAX_ENTRIES = 500;

class History {
  constructor() {
    this.items = [];
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      this.items = Array.isArray(j.items) ? j.items : [];
    } catch {
      this.items = [];
    }
  }

  save() {
    const tmp = HISTORY_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 1), 'utf8');
      fs.renameSync(tmp, HISTORY_FILE);
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  add(entry) {
    if (!entry || !entry.repo || !entry.path) return;
    const at = Date.now();
    // 同一文件重复下载只更新时间，不重复插入
    const idx = this.items.findIndex(
      (x) => x.repo === entry.repo && x.path === entry.path && x.finalFile === entry.finalFile
    );
    const rec = {
      repo: entry.repo,
      rev: entry.rev || 'main',
      path: entry.path,
      size: entry.size || 0,
      finalFile: entry.finalFile,
      destDir: entry.destDir,
      at,
    };
    if (idx >= 0) this.items.splice(idx, 1);
    this.items.unshift(rec);
    if (this.items.length > MAX_ENTRIES) this.items.length = MAX_ENTRIES;
    this.save();
  }

  list() {
    return this.items.slice();
  }

  clear() {
    this.items = [];
    this.save();
    return { ok: true };
  }
}

module.exports = { History };
