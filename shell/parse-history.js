/*
 * 解析历史：记录解析成功的仓库地址
 *
 * 与下载历史（history.js）分开 —— 下载历史记的是文件，
 * 这里记的是仓库，用于主页的「最近解析」快速入口。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const FILE = path.join(DATA_DIR, 'parsed.json');
const MAX_ENTRIES = 30;

class ParseHistory {
  constructor() {
    this.items = [];
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      this.items = Array.isArray(j.items) ? j.items : [];
    } catch {
      this.items = [];
    }
  }

  save() {
    const tmp = FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 1), 'utf8');
      fs.renameSync(tmp, FILE);
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  /** 记录一次成功解析。同 repo@rev 只更新时间并提前 */
  add(entry) {
    if (!entry || !entry.repo) return;
    const at = Date.now();
    const rec = {
      repo: entry.repo,
      rev: entry.rev || 'main',
      at,
      fileCount: entry.fileCount || 0,
      totalBytes: entry.totalBytes || 0,
    };
    const idx = this.items.findIndex(
      (x) => x.repo === rec.repo && x.rev === rec.rev
    );
    if (idx >= 0) this.items.splice(idx, 1);
    this.items.unshift(rec);
    if (this.items.length > MAX_ENTRIES) this.items.length = MAX_ENTRIES;
    this.save();
  }

  remove(repo, rev) {
    const idx = this.items.findIndex(
      (x) => x.repo === repo && (x.rev || 'main') === (rev || 'main')
    );
    if (idx >= 0) {
      this.items.splice(idx, 1);
      this.save();
    }
    return { ok: true };
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

module.exports = { ParseHistory };
