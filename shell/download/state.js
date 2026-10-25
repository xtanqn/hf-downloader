/*
 * 断点状态的原子持久化
 *
 * 写 .tmp 再 rename —— 断电最多丢 1 秒进度，不会留下半个 JSON。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { STATE_FILE } = require('../paths');

const VERSION = 1;

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (!j || j.version !== VERSION || !Array.isArray(j.tasks)) return [];
    return j.tasks;
  } catch {
    return [];
  }
}

function serialize(tasks) {
  // 只保留需要持久化的字段，避免把 FileHandle 之类的运行时对象写进去
  return {
    version: VERSION,
    savedAt: Date.now(),
    tasks: tasks.map((t) => ({
      id: t.id,
      repo: t.repo,
      rev: t.rev,
      path: t.path,
      url: t.url,
      destDir: t.destDir,
      finalFile: t.finalFile,
      partFile: t.partFile,
      size: t.size,
      oid: t.oid,
      chunks: t.chunks,
      status: t.status === 'downloading' || t.status === 'preparing' || t.status === 'finalizing'
        ? 'paused' // 上次是崩溃退出的，内存里的进度不可信，改判为暂停
        : t.status,
      error: t.error || '',
      doneBytes: t.doneBytes || 0,
      rangeable: t.rangeable,
      singleStream: !!t.singleStream,
      createdAt: t.createdAt,
      updatedAt: Date.now(),
    })),
  };
}

function writeStateAtomic(tasks) {
  const tmp = STATE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(serialize(tasks), null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

/** 启动时校验：分块文件不存在或尺寸不符的任务，重置进度 */
function validateOnLoad(tasks) {
  for (const t of tasks) {
    if (t.status === 'done') continue;
    let ok = false;
    try {
      const st = fs.statSync(t.partFile);
      ok = st.size === t.size;
    } catch {
      ok = false;
    }
    if (!ok) {
      t.chunks = null;
      t.doneBytes = 0;
      t.rangeable = undefined;
      t.singleStream = false;
      if (t.status !== 'error') t.status = 'paused';
    }
  }
  return tasks;
}

module.exports = { readState, writeStateAtomic, validateOnLoad, STATE_FILE };
