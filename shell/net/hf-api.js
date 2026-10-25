/*
 * Hugging Face API 封装（走镜像站）
 *
 * 已实测的关键事实：
 *   - 递归 tree：?recursive=true&expand=false 返回扁平数组，SDXL 67 项 / 71.63GB，响应 <5KB
 *   - API 限流：500 次 / 300 秒。所以 tree 必须缓存，不能每展开一个目录就打一次
 *   - 目录项的 size 恒为 0，算体积必须递归累加文件项
 *   - 仓库改名会 307（runwayml/stable-diffusion-v1-5 → stable-diffusion-v1-5/...），
 *     redirect:'follow' 自动处理，但要记住解析后的真实 id
 *   - gated 仓库：tree 能读，文件 403，repoInfo.gated === "manual"
 */
'use strict';

const { requestStream, readAll } = require('./client');
const { HfError, classifyHttp } = require('./errors');

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map(); // `${mirror}|${repo}@${rev}` -> { at, entries, repoInfo }

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return v;
}

function cacheSet(key, val) {
  cache.set(key, { at: Date.now(), ...val });
  // 简单容量控制，避免长时间运行内存膨胀
  if (cache.size > 50) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

function cacheClear() {
  cache.clear();
}

/**
 * 从用户输入解析出仓库信息。
 * 支持：
 *   https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0
 *   https://hf-mirror.com/stabilityai/stable-diffusion-xl-base-1.0/tree/main/vae
 *   stabilityai/stable-diffusion-xl-base-1.0
 *   stabilityai/stable-diffusion-xl-base-1.0@v1.0
 */
function parseRepoInput(input) {
  let s = String(input || '').trim();
  if (!s) throw new HfError('BAD_INPUT', '请输入模型地址或 用户名/仓库名');

  let rev = 'main';
  let subPath = '';

  if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new HfError('BAD_INPUT', '地址格式不正确');
    }
    const host = u.hostname.toLowerCase();
    if (!/(^|\.)(huggingface\.co|hf\.co|hf-mirror\.com)$/.test(host)) {
      throw new HfError('BAD_INPUT', `不支持的域名：${host}（请用 huggingface.co 或 hf-mirror.com）`);
    }
    const parts = u.pathname.split('/').filter(Boolean);
    // 支持 /models/xxx 前缀
    if (parts[0] === 'models' || parts[0] === 'datasets' || parts[0] === 'spaces') parts.shift();
    if (parts.length < 2) throw new HfError('BAD_INPUT', '地址里缺少 用户名/仓库名');
    s = parts[0] + '/' + parts[1];
    if (parts[2] === 'tree' && parts[3]) {
      rev = decodeURIComponent(parts[3]);
      subPath = parts.slice(4).map(decodeURIComponent).join('/');
    } else if (parts[2] === 'blob' && parts[3]) {
      rev = decodeURIComponent(parts[3]);
      subPath = parts.slice(4).map(decodeURIComponent).join('/');
    }
  } else {
    // 允许 用户名/仓库名@分支
    const at = s.lastIndexOf('@');
    if (at > 0) {
      rev = s.slice(at + 1);
      s = s.slice(0, at);
    }
  }

  const segs = s.split('/').filter(Boolean);
  if (segs.length !== 2) {
    throw new HfError('BAD_INPUT', '格式应为 用户名/仓库名，例如 stabilityai/stable-diffusion-xl-base-1.0');
  }

  return { owner: segs[0], repo: segs[1], id: `${segs[0]}/${segs[1]}`, rev, subPath };
}

function mirrorBase(mirror) {
  const m = String(mirror || 'https://hf-mirror.com').trim().replace(/\/+$/, '');
  return m || 'https://hf-mirror.com';
}

/** 拼下载地址。注意每次请求都要重新走一遍重定向拿新签名（X-Amz-Expires=3600） */
function resolveUrl(mirror, repo, rev, filePath) {
  const encoded = String(filePath).split('/').map(encodeURIComponent).join('/');
  return `${mirrorBase(mirror)}/${repo}/resolve/${encodeURIComponent(rev)}/${encoded}`;
}

/** 拉仓库元信息（只要我们真正用到的字段） */
async function fetchRepoInfo(mirror, repo) {
  const url = `${mirrorBase(mirror)}/api/models/${repo}`;
  const { res } = await requestStream(url, { timeout: 30000 });
  if (res.statusCode !== 200) {
    const e = classifyHttp(res.statusCode, repo);
    try { res.destroy(); } catch {}
    throw e;
  }
  const text = await readAll(res);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new HfError('BAD_JSON', '仓库信息解析失败，镜像站可能返回了错误页', { retryable: true });
  }
  return {
    id: j.id || repo,
    sha: j.sha || '',
    gated: j.gated === undefined ? false : j.gated,
    private: !!j.private,
    downloads: j.downloads || 0,
    likes: j.likes || 0,
    pipelineTag: j.pipeline_tag || '',
    libraryName: j.library_name || '',
    lastModified: j.lastModified || '',
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 30) : [],
  };
}

/** 拉递归文件树 */
async function fetchTree(mirror, repo, rev) {
  // 显式 limit=1000：默认虽无分页，但传了更保险，避免默认上限带来的隐性截断
  const url = `${mirrorBase(mirror)}/api/models/${repo}/tree/${encodeURIComponent(rev)}`
    + '?recursive=true&expand=false&limit=1000';
  const { res } = await requestStream(url, { timeout: 30000 });
  if (res.statusCode !== 200) {
    const e = classifyHttp(res.statusCode, repo);
    try { res.destroy(); } catch {}
    throw e;
  }
  const text = await readAll(res);
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new HfError('BAD_JSON', '文件树解析失败，镜像站可能返回了错误页', { retryable: true });
  }
  if (!Array.isArray(arr)) {
    throw new HfError('BAD_JSON', '文件树格式异常');
  }
  return arr;
}

/** 带缓存的加载 */
async function loadRepo(mirror, repo, rev, force) {
  const key = `${mirrorBase(mirror)}|${repo}@${rev}`;
  if (!force) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }

  const [repoInfo, entries] = await Promise.all([
    fetchRepoInfo(mirror, repo),
    fetchTree(mirror, repo, rev),
  ]);

  // 目录项 size 恒为 0，体积只能从文件项累加
  const files = entries.filter((x) => x.type === 'file');
  const totalBytes = files.reduce((n, f) => n + (Number(f.size) || 0), 0);

  const result = {
    repoInfo,
    entries,
    stats: { fileCount: files.length, dirCount: entries.length - files.length, totalBytes },
  };
  cacheSet(key, result);
  return result;
}

module.exports = {
  parseRepoInput,
  loadRepo,
  resolveUrl,
  mirrorBase,
  cacheClear,
};
