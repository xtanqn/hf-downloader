/*
 * 开发态启动器
 *
 * 本机没有系统 Node，所以用项目自带的便携 node.exe 拉起 electron。
 * 直接 spawn node_modules/electron/dist/electron.exe，不经过 npm。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(electronExe)) {
  console.error('[错误] 找不到 Electron：' + electronExe);
  console.error('请先安装依赖：');
  console.error('  .\\node\\node.exe .\\node\\node_modules\\npm\\bin\\npm-cli.js install');
  process.exit(1);
}

const args = [ROOT];
if (process.argv.includes('--devtools')) args.push('--devtools');

const child = spawn(electronExe, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code || 0));
