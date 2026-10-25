/* 格式化工具 */
'use strict';

function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatSpeed(bps) {
  if (!bps || bps < 1) return '0 B/s';
  return formatBytes(bps) + '/s';
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0 || seconds > 86400 * 7) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 时 ${m % 60} 分`;
}

module.exports = { formatBytes, formatSpeed, formatEta };
