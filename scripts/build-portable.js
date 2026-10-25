/*
 * 免安装版打包脚本
 *
 * 为什么不用 electron-builder 的 portable 目标 / NSIS：
 *   - portable 目标产出单文件自解压 exe，运行时解压到 %TEMP% 随机目录，
 *     于是 process.execPath 指向临时目录，程序旁边的 _数据/ 根本读不到 ——
 *     整个「数据放 exe 同级」的方案会被破坏。
 *   - NSIS 安装版已决定不做。
 *   所以走 target:"dir" 产出文件夹，再自己打 zip。
 *
 * 五个阶段：
 *   0. 版本号递增 + 失败回滚
 *   1. electron-builder --dir
 *   2. 手工组装 dist/HF下载器/
 *   3. 自检（含 asar 内源码逐字节比对）
 *   4. 自写 zip（必须写 UTF-8 标记，否则中文文件名换工具就乱码）
 *   5. 清理中间产物
 *
 * 调试开关：
 *   HF_SKIP_BUMP=1  跳过版本号递增
 *   HF_SKIP_PACK=1  跳过 electron-builder，复用已有 dist/win-unpacked
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');
const PRODUCT = 'HF下载器';
const STAGE = path.join(DIST, PRODUCT);
const PKG_PATH = path.join(ROOT, 'package.json');

/* ================= 工具函数 ================= */

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rmDirWithRetry(dir, tries) {
  const n = tries || 5;
  for (let i = 0; i < n; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (i === n - 1) {
        console.error(`\n[错误] 无法删除 ${dir}`);
        console.error('  可能是上一次打包的成品正在运行。');
        console.error('  请关掉所有「HF下载器」窗口后重跑本脚本。\n');
        return false;
      }
      console.log(`  目录被占用，${i + 1}/${n} 次重试…`);
      sleepSync(1500);
    }
  }
  return false;
}

function tryRemove(p, label) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`  已清理 ${label || p}`);
  } catch {
    console.warn(`  [警告] 未能清理 ${label || p}（可能被占用），不影响成品`);
  }
}

function copyDir(src, dst, opts) {
  const skip = (opts && opts.skip) || (() => false);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, opts);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/** 递归列出目录下所有文件（相对路径用 / 分隔） */
function listFiles(dir, base) {
  const root = base || dir;
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

/* ================= asar 读取（用于自检） ================= */

function readAsarIndex(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const size = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const root = JSON.parse(jsonBuf.toString('utf8'));

    const entries = [];
    (function walk(node, pref) {
      for (const k of Object.keys(node.files || {})) {
        const v = node.files[k];
        const name = pref + k;
        if (v.files) walk(v, name + '/');
        else entries.push({ name, offset: Number(v.offset) || 0, size: Number(v.size) || 0 });
      }
    })(root, '');

    // 注意：数据区起点是 8 + size，不是 16 + jsonSize（中间有对齐填充）
    return { entries, dataOffset: 8 + size, fd };
  } catch (e) {
    try { fs.closeSync(fd); } catch {}
    throw e;
  }
}

function readAsarEntry(idx, entry) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(idx.fd, buf, 0, entry.size, idx.dataOffset + entry.offset);
  return buf;
}

/* ================= 自写 zip ================= */

function zipDir(srcDir, zipPath, prefix) {
  const files = listFiles(srcDir);
  console.log(`  打包 ${files.length} 个文件…`);

  const fd = fs.openSync(zipPath, 'w');
  const central = [];
  let offset = 0;

  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  try {
    for (const rel of files) {
      const abs = path.join(srcDir, rel);
      const data = fs.readFileSync(abs);
      const nameStr = prefix ? `${prefix}/${rel}` : rel;
      const nameBuf = Buffer.from(nameStr, 'utf8');

      const deflated = zlib.deflateRawSync(data, { level: 9 });
      const useDeflate = deflated.length < data.length;
      const payload = useDeflate ? deflated : data;
      const method = useDeflate ? 8 : 0;
      const crc = crc32(data);

      /* 本地文件头 */
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0800, 6); // 通用位标记 11：文件名为 UTF-8
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(dosTime, 10);
      lh.writeUInt16LE(dosDate, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(payload.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      lh.writeUInt16LE(0, 28);

      fs.writeSync(fd, lh);
      fs.writeSync(fd, nameBuf);
      fs.writeSync(fd, payload);

      central.push({ nameBuf, method, crc, csize: payload.length, usize: data.length, offset });
      offset += lh.length + nameBuf.length + payload.length;
    }

    /* 中央目录 */
    const cdStart = offset;
    for (const c of central) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8); // 中央目录里也要写 UTF-8 标记
      cd.writeUInt16LE(c.method, 10);
      cd.writeUInt16LE(dosTime, 12);
      cd.writeUInt16LE(dosDate, 14);
      cd.writeUInt32LE(c.crc, 16);
      cd.writeUInt32LE(c.csize, 20);
      cd.writeUInt32LE(c.usize, 24);
      cd.writeUInt16LE(c.nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(c.offset, 42);

      fs.writeSync(fd, cd);
      fs.writeSync(fd, c.nameBuf);
      offset += cd.length + c.nameBuf.length;
    }

    /* EOCD */
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeSync(fd, eocd);
  } finally {
    fs.closeSync(fd);
  }
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

/* ================= 阶段 0：版本号 ================= */

const pkgRawOld = fs.readFileSync(PKG_PATH, 'utf8');
const pkg = JSON.parse(pkgRawOld);
const verOld = String(pkg.version);
let verBumped = false;

function rollbackVersion(code) {
  if (!verBumped) return;
  try {
    fs.writeFileSync(PKG_PATH, pkgRawOld, 'utf8');
    console.log(`\n[回滚] 版本号已退回 ${verOld}（打包失败，不白吃一个版本号）`);
  } catch {}
}

function bumpVersion() {
  if (process.env.HF_SKIP_BUMP === '1') {
    console.log(`  [跳过] 版本号保持 ${verOld}`);
    return verOld;
  }
  const m = verOld.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    console.log(`  [跳过] 版本号格式非 x.y.z，保持 ${verOld}`);
    return verOld;
  }
  const verNew = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  // 只替换 version 的值，其余字节原样保留
  const pkgRawNew = pkgRawOld.replace(/("version"\s*:\s*")[^"]*(")/, `$1${verNew}$2`);
  fs.writeFileSync(PKG_PATH, pkgRawNew, 'utf8');
  verBumped = true;
  console.log(`  版本号 ${verOld} → ${verNew}`);
  return verNew;
}

process.on('exit', (code) => {
  if (code !== 0) rollbackVersion(code);
});

/* ================= 主流程 ================= */

function main() {
  console.log('');
  console.log('========================================');
  console.log(`  ${PRODUCT} · 免安装版打包`);
  console.log('========================================');
  console.log('');

  /* ---- 阶段 0 ---- */
  console.log('[0/5] 版本号');
  const version = bumpVersion();
  console.log('');

  /* ---- 阶段 1 ---- */
  console.log('[1/5] electron-builder');
  if (process.env.HF_SKIP_PACK === '1') {
    console.log('  [跳过] 复用已有 dist/win-unpacked');
  } else {
    const ebPkgPath = path.join(ROOT, 'node_modules', 'electron-builder', 'package.json');
    if (!fs.existsSync(ebPkgPath)) {
      console.error('[错误] 找不到 electron-builder，请先安装依赖');
      process.exit(1);
    }
    const ebPkg = JSON.parse(fs.readFileSync(ebPkgPath, 'utf8'));
    const ebBinRel = typeof ebPkg.bin === 'string' ? ebPkg.bin : ebPkg.bin['electron-builder'];
    const ebBin = path.join(ROOT, 'node_modules', 'electron-builder', ebBinRel);

    // 不用 npm.cmd + shell:true，避免 Node 24 的 DEP0190 参数转义问题
    const r = spawnSync(
      process.execPath,
      [ebBin, '--config', path.join('config', 'electron-builder.json'), '--dir'],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: Object.assign({}, process.env, {
          ELECTRON_MIRROR:
            process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
          ELECTRON_BUILDER_BINARIES_MIRROR:
            process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
            'https://npmmirror.com/mirrors/electron-builder-binaries/',
        }),
      }
    );

    if (r.status !== 0) {
      console.error(`\n[错误] electron-builder 失败，退出码 ${r.status}`);
      process.exit(1);
    }
  }
  console.log('');

  /* ---- 阶段 2 ---- */
  console.log('[2/5] 组装');
  if (!fs.existsSync(UNPACKED)) {
    console.error(`[错误] 找不到 ${UNPACKED}`);
    process.exit(1);
  }

  if (!rmDirWithRetry(STAGE)) process.exit(1);
  fs.mkdirSync(STAGE, { recursive: true });

  copyDir(UNPACKED, STAGE);
  console.log('  程序本体已复制');

  // 说明文档
  const doc = path.join(ROOT, '使用说明.md');
  if (fs.existsSync(doc)) {
    fs.copyFileSync(doc, path.join(STAGE, '使用说明.md'));
    console.log('  使用说明.md 已复制');
  }

  // 注意：不预置 _数据 —— 首次运行时由 paths.js 自建，
  // 避免分发包里带上打包者自己的下载记录和设置。
  console.log('  _数据 将由首次运行时自动创建');
  console.log('');

  /* ---- 阶段 3 ---- */
  console.log('[3/5] 自检');
  const problems = [];
  const ASAR = path.join(STAGE, 'resources', 'app.asar');

  if (!fs.existsSync(path.join(STAGE, PRODUCT + '.exe'))) problems.push('缺少主程序 exe');
  if (!fs.existsSync(ASAR)) problems.push('缺少 resources/app.asar');

  const asarSize = fs.existsSync(ASAR) ? fs.statSync(ASAR).size : 0;
  if (asarSize > 20 * 1024 * 1024) {
    problems.push(
      `app.asar 达 ${(asarSize / 1048576).toFixed(1)}MB，node_modules 或 node/ 可能被打进去了`
    );
  }

  for (const bad of ['_数据', 'node', 'node_modules', 'scripts', 'config', 'dist']) {
    if (fs.existsSync(path.join(STAGE, bad))) problems.push(`包里不该出现 ${bad}/`);
  }

  // asar 内源码逐字节核对 —— 抓"改了源码忘重打包"
  if (asarSize > 0) {
    let idx = null;
    try {
      idx = readAsarIndex(ASAR);
      const checks = [
        'shell/main.js',
        'shell/paths.js',
        'shell/download/chunk.js',
        'shell/download/task.js',
        'preload.js',
        'renderer/index.html',
        'renderer/js/model.js',
        'renderer/js/app.js',
      ];
      for (const rel of checks) {
        const e = idx.entries.find((x) => x.name === rel);
        if (!e) {
          problems.push(`asar 里没有 ${rel}`);
          continue;
        }
        const inPack = crypto.createHash('sha1').update(readAsarEntry(idx, e)).digest('hex');
        const onDisk = crypto
          .createHash('sha1')
          .update(fs.readFileSync(path.join(ROOT, rel)))
          .digest('hex');
        if (inPack !== onDisk) {
          problems.push(`asar 里的 ${rel} 与源码不一致（拿旧内容打的包？）`);
        }
      }
      console.log(`  asar 内 ${idx.entries.length} 个条目，关键源码已逐字节核对`);
    } catch (e) {
      problems.push('asar 读取失败：' + e.message);
    } finally {
      if (idx) {
        try { fs.closeSync(idx.fd); } catch {}
      }
    }
  }

  if (problems.length) {
    console.error('\n[自检失败]');
    for (const p of problems) console.error('  ✗ ' + p);
    console.error('');
    process.exit(1);
  }
  console.log('  ✓ 全部检查通过');
  console.log('');

  /* ---- 阶段 4 ---- */
  console.log('[4/5] 打包 zip');
  const zipName = `${PRODUCT}-免安装版-v${version}.zip`;
  const zipPath = path.join(DIST, zipName);
  try { fs.unlinkSync(zipPath); } catch {}

  zipDir(STAGE, zipPath, PRODUCT);
  const zipMb = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  console.log(`  ${zipName}（${zipMb} MB）`);
  console.log('');

  /* ---- 阶段 5 ---- */
  console.log('[5/5] 清理');
  if (process.env.HF_SKIP_PACK === '1') {
    console.log('  [跳过] 保留了 win-unpacked 供调试');
  } else {
    tryRemove(UNPACKED, 'dist/win-unpacked');
    tryRemove(path.join(DIST, 'builder-debug.yml'), 'dist/builder-debug.yml');
  }
  console.log('');

  console.log('========================================');
  console.log('  打包完成');
  console.log('========================================');
  console.log(`  文件夹：${STAGE}`);
  console.log(`  zip   ：${zipPath}`);
  console.log(`  版本  ：${version}`);
  console.log('');
  console.log('  验证方式：把 zip 解压到任意新目录，双击');
  console.log(`  ${PRODUCT}.exe 即可运行，无需安装任何东西。`);
  console.log('');
}

main();
