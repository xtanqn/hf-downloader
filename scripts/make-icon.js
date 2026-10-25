/*
 * 生成 icon.ico（零依赖，纯 Node）
 *
 * electron-builder 要求 ico 里含 256×256，否则直接拒绝构建。
 *
 * 两个细节：
 *   - 面积平均缩放（不是最近邻），边缘才干净
 *   - 预乘 alpha 平均，否则透明区底下残留的白色会在边缘染一圈白边
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT_ICO = path.join(ROOT, 'resources', 'icon.ico');
const OUT_PNG = path.join(ROOT, 'resources', 'logo.png');

const SIZES = [16, 32, 48, 64, 128, 256];
const INSET = 0.04;

/* ---------- 画一个图标（返回 RGBA 浮点数组） ---------- */
function drawIcon(size) {
  const px = new Float64Array(size * size * 4);

  const pad = size * INSET;
  const r = size * 0.22; // 圆角半径
  const w = size - pad * 2;
  const h = size - pad * 2;

  // 渐变：橙 → 琥珀（HF 的品牌色）
  const c1 = [255, 184, 77];
  const c2 = [245, 147, 0];

  const inRoundRect = (x, y) => {
    const lx = x - pad;
    const ly = y - pad;
    if (lx < 0 || ly < 0 || lx > w || ly > h) return false;
    const rr = Math.min(r, w / 2, h / 2);
    // 四角圆弧
    const corners = [
      [rr, rr],
      [w - rr, rr],
      [rr, h - rr],
      [w - rr, h - rr],
    ];
    if (lx > rr && lx < w - rr) return true;
    if (ly > rr && ly < h - rr) return true;
    for (const [cx, cy] of corners) {
      const dx = lx - cx;
      const dy = ly - cy;
      if ((dx < 0) === (cx < w / 2) && (dy < 0) === (cy < h / 2)) {
        return dx * dx + dy * dy <= rr * rr;
      }
    }
    return true;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRoundRect(x + 0.5, y + 0.5)) {
        px[i + 3] = 0;
        continue;
      }
      // 对角渐变
      const t = (x / size) * 0.5 + (y / size) * 0.5;
      px[i] = c1[0] + (c2[0] - c1[0]) * t;
      px[i + 1] = c1[1] + (c2[1] - c1[1]) * t;
      px[i + 2] = c1[2] + (c2[2] - c1[2]) * t;
      px[i + 3] = 255;
    }
  }

  // 画一个向下的箭头（下载）
  const cx = size / 2;
  const shaftW = size * 0.105;
  const shaftTop = size * 0.245;
  const shaftBot = size * 0.545;
  const headTop = size * 0.475;
  const headBot = size * 0.735;
  const headW = size * 0.20;

  const setDark = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    if (px[i + 3] < 128) return;
    px[i] = 45;
    px[i + 1] = 52;
    px[i + 2] = 64;
    px[i + 3] = 255;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      // 箭杆
      if (fy >= shaftTop && fy <= shaftBot && Math.abs(fx - cx) <= shaftW / 2) {
        setDark(x, y);
        continue;
      }
      // 箭头三角
      if (fy >= headTop && fy <= headBot) {
        const prog = (fy - headTop) / (headBot - headTop);
        const halfW = headW * (1 - prog);
        if (Math.abs(fx - cx) <= halfW) {
          setDark(x, y);
          continue;
        }
      }
      // 底部托盘
      if (fy >= size * 0.775 && fy <= size * 0.845) {
        if (Math.abs(fx - cx) <= size * 0.235) setDark(x, y);
      }
    }
  }

  return px;
}

/* ---------- 面积平均缩放（预乘 alpha） ---------- */
function resize(src, srcSize, dstSize) {
  if (srcSize === dstSize) return src;
  const out = new Float64Array(dstSize * dstSize * 4);
  const ratio = srcSize / dstSize;

  for (let y = 0; y < dstSize; y++) {
    const y0 = Math.floor(y * ratio);
    const y1 = Math.min(srcSize, Math.ceil((y + 1) * ratio));
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * ratio);
      const x1 = Math.min(srcSize, Math.ceil((x + 1) * ratio));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcSize + sx) * 4;
          const al = src[i + 3];
          // 预乘 alpha 后再平均，否则透明区的颜色会渗进来
          const w = al / 255;
          r += src[i] * w;
          g += src[i + 1] * w;
          b += src[i + 2] * w;
          a += al;
          n++;
        }
      }
      const o = (y * dstSize + x) * 4;
      if (n === 0) continue;
      const avgA = a / n;
      if (avgA < 0.5) {
        out[o + 3] = 0;
        continue;
      }
      const wsum = a / 255;
      out[o] = wsum > 0 ? r / wsum : 0;
      out[o + 1] = wsum > 0 ? g / wsum : 0;
      out[o + 2] = wsum > 0 ? b / wsum : 0;
      out[o + 3] = avgA;
    }
  }
  return out;
}

/* ---------- 编码 PNG ---------- */
function encodePNG(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      raw[p++] = Math.max(0, Math.min(255, Math.round(rgba[i])));
      raw[p++] = Math.max(0, Math.min(255, Math.round(rgba[i + 1])));
      raw[p++] = Math.max(0, Math.min(255, Math.round(rgba[i + 2])));
      raw[p++] = Math.max(0, Math.min(255, Math.round(rgba[i + 3])));
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/* ---------- 编码 ICO ---------- */
function buildIco() {
  const master = drawIcon(256);
  const images = [];

  for (const size of SIZES) {
    const rgba = size === 256 ? master : resize(master, 256, size);
    const png = encodePNG(rgba, size);
    images.push({ size, png });
  }

  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dirs = [];
  let offset = 6 + count * 16;
  for (const im of images) {
    const d = Buffer.alloc(16);
    d[0] = im.size >= 256 ? 0 : im.size;
    d[1] = im.size >= 256 ? 0 : im.size;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(im.png.length, 8);
    d.writeUInt32LE(offset, 12);
    dirs.push(d);
    offset += im.png.length;
  }

  return {
    ico: Buffer.concat([header, ...dirs, ...images.map((i) => i.png)]),
    png256: images.find((i) => i.size === 256).png,
  };
}

const { ico, png256 } = buildIco();
fs.mkdirSync(path.dirname(OUT_ICO), { recursive: true });
fs.writeFileSync(OUT_ICO, ico);
fs.writeFileSync(OUT_PNG, png256);
console.log(`已生成 ${OUT_ICO}（${SIZES.join('/')} 六档，${(ico.length / 1024).toFixed(1)} KB）`);
console.log(`已生成 ${OUT_PNG}`);
