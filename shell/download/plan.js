/*
 * 分块规划 / Range 探测 / 预分配
 *
 * 实测要点：
 *   hf-mirror 的【非 LFS 小文件】忽略 Range —— 307 响应头里会假装回 Content-Range，
 *   但最终 200 响应返回的是完整 body。所以探测必须看【最终响应】的状态码，
 *   不支持时降级为单流。否则分块逻辑会把整个文件写到偏移 0，静默产出损坏文件。
 */
'use strict';

const fs = require('fs');
const { requestStream } = require('../net/client');
const { HfError } = require('../net/errors');

const MB = 1048576;

/** 按文件大小决定分块数量 */
function chunkCount(size) {
  if (size < 8 * MB) return 1; // 小文件单流，别浪费连接
  const target = size < 256 * MB ? 4 * MB : size < 2048 * MB ? 8 * MB : 16 * MB;
  // 上限 64：断点粒度由 chunk.done 决定，跟分块数无关；
  // 64 已足够摊平尾部效应，状态文件也只有几 KB
  return Math.max(1, Math.min(64, Math.ceil(size / target)));
}

function planChunks(size) {
  if (!size || size <= 0) {
    return [{ index: 0, start: 0, end: -1, len: 0, done: 0 }];
  }
  const n = chunkCount(size);
  const base = Math.ceil(size / n);
  const out = [];
  let s = 0;
  for (let i = 0; i < n && s < size; i++) {
    const e = Math.min(size - 1, s + base - 1);
    out.push({ index: i, start: s, end: e, len: e - s + 1, done: 0 });
    s = e + 1;
  }
  return out;
}

/**
 * 预分配文件到指定大小。
 * NTFS 上 truncate 到更大尺寸是瞬时的（稀疏），不会真的写满磁盘，
 * 也不会像逐字节写零那样卡住。
 */
async function preallocate(file, size) {
  const fh = await fs.promises.open(file, 'w+');
  try {
    await fh.truncate(size);
  } finally {
    await fh.close();
  }
}

/**
 * 探测远端是否支持 Range。
 * 返回 { rangeable, total }
 */
async function probeRange(url, size) {
  const { res } = await requestStream(url, {
    headers: { Range: 'bytes=0-0' },
    timeout: 20000,
  });
  try {
    if (res.statusCode === 206) {
      const cr = String(res.headers['content-range'] || '');
      const m = cr.match(/bytes\s+\d+-\d+\/(\d+)/);
      return { rangeable: true, total: m ? Number(m[1]) : size };
    }
    return { rangeable: false, total: size };
  } finally {
    try { res.destroy(); } catch {}
  }
}

module.exports = { planChunks, chunkCount, preallocate, probeRange };
