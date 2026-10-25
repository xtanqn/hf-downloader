/* Windows 文件名净化 + 长路径 */
'use strict';

const path = require('path');

const ILLEGAL = /[<>:"|?*\x00-\x1f]/g;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/** 净化单个路径段（不含分隔符） */
function safeSegment(name) {
  let s = String(name).replace(ILLEGAL, '_');
  // Windows 不允许结尾的点和空格："a." 会被静默截断成 "a"，导致路径对不上
  s = s.replace(/[. ]+$/, '');
  if (RESERVED.test(s)) s = '_' + s;
  if (!s) s = '_';
  return s;
}

/** 把仓库内的相对路径（用 / 分隔）转成本地安全的路径 */
function safeRelPath(rel) {
  return String(rel)
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map(safeSegment)
    .join(path.sep);
}

/**
 * 校验 dest 落在 root 之内，防路径穿越。
 * 仓库里理论上不会有 ../，但不能只靠"理论上"。
 */
function isInside(root, dest) {
  const r = path.resolve(root);
  const d = path.resolve(dest);
  if (d === r) return true;
  return d.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** 超长路径加 \\?\ 前缀，否则 Win32 API 会报 ENAMETOOLONG */
function longPath(p) {
  const abs = path.resolve(p);
  if (process.platform !== 'win32') return abs;
  if (abs.startsWith('\\\\?\\')) return abs;
  return abs.length > 250 ? '\\\\?\\' + abs : abs;
}

module.exports = { safeSegment, safeRelPath, isInside, longPath };
