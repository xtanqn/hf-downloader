/* 渲染进程的格式化工具 */
'use strict';

const Fmt = (() => {
  function bytes(n) {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }

  function speed(bps) {
    if (!bps || bps < 1) return '0 B/s';
    return bytes(bps) + '/s';
  }

  function eta(sec) {
    if (!isFinite(sec) || sec <= 0 || sec > 86400 * 7) return '—';
    const s = Math.round(sec);
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${s % 60} 秒`;
    const h = Math.floor(m / 60);
    return `${h} 时 ${m % 60} 分`;
  }

  function count(n) {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  function time(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 按扩展名给徽章分类 */
  function extInfo(name) {
    const i = name.lastIndexOf('.');
    const ext = i >= 0 ? name.slice(i + 1).toLowerCase() : '';
    const map = {
      safetensors: ['ST', 'st'],
      ckpt: ['CKPT', 'bin'],
      pt: ['PT', 'bin'],
      pth: ['PTH', 'bin'],
      bin: ['BIN', 'bin'],
      json: ['{}', 'json'],
      txt: ['TXT', 'txt'],
      md: ['MD', 'txt'],
      yaml: ['YML', 'txt'],
      yml: ['YML', 'txt'],
      py: ['PY', 'txt'],
      onnx: ['ONNX', 'onnx'],
      gguf: ['GGUF', 'gguf'],
      msgpack: ['MP', 'bin2'],
      model: ['MDL', 'bin2'],
      png: ['IMG', 'img'],
      jpg: ['IMG', 'img'],
      jpeg: ['IMG', 'img'],
      webp: ['IMG', 'img'],
      gif: ['IMG', 'img'],
      mp4: ['VID', 'img'],
      sft: ['ST', 'st'],
    };
    if (map[ext]) return { text: map[ext][0], kind: map[ext][1], ext };
    if (!ext) return { text: '—', kind: 'bin2', ext: '' };
    return { text: ext.slice(0, 3).toUpperCase(), kind: 'bin2', ext };
  }

  function typeLabel(name, isDir) {
    if (isDir) return '文件夹';
    const { ext } = extInfo(name);
    if (!ext) return '文件';
    return ext.toUpperCase() + ' 文件';
  }

  return { bytes, speed, eta, count, time, extInfo, typeLabel };
})();
