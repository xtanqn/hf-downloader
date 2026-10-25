/*
 * 网络客户端 —— 基于 Electron 的 net 模块
 *
 * 为什么不用 Node 的 https：
 *   1) Electron net 自动走 Windows 系统代理。Clash / v2rayN 这类工具只设系统代理，
 *      Node 的 https 完全看不见，会直连失败。
 *   2) Electron net 用 Windows 证书库。公司 MITM 代理的根证书 Node 不认，
 *      得额外配 NODE_EXTRA_CA_CERTS；Chromium 网络栈天然认。
 *   3) 自带 HTTP/2 和重定向跟随。
 *
 * 关键约定：
 *   - 一律带 Accept-Encoding: identity。透明解压会让 Content-Length 与实际字节数不一致，
 *     分块的区间算术会全乱。
 *   - redirect: 'follow' 会走完 hf-mirror → 307 resolve-cache → 302 cas-bridge 这条链。
 *     注意：302 响应里的 Content-Length 是【重定向体的长度】（几百字节），不是文件大小。
 */
'use strict';

const { net } = require('electron');
const { HfError, wrapNetError } = require('./errors');

/**
 * 发起流式 GET，resolve 时已经拿到响应头，body 还没读。
 * 调用方负责消费或 destroy 掉 res。
 */
function requestStream(url, opts) {
  const o = opts || {};
  const headers = o.headers || {};
  const timeout = o.timeout || 30000;

  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({
        method: o.method || 'GET',
        url,
        redirect: 'follow',
        useSessionCookies: false,
      });
    } catch (e) {
      reject(wrapNetError(e));
      return;
    }

    req.setHeader('Accept-Encoding', 'identity');
    for (const k of Object.keys(headers)) {
      if (headers[k] != null) req.setHeader(k, String(headers[k]));
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.abort(); } catch {}
      reject(new HfError('TIMEOUT', `请求超时（${Math.round(timeout / 1000)} 秒无响应）`, {
        retryable: true,
      }));
    }, timeout);

    req.on('response', (res) => {
      clearTimeout(timer);
      if (settled) {
        // 已经超时了，把迟到的 body 丢掉，避免 socket 泄漏
        try { res.destroy(); } catch {}
        return;
      }
      settled = true;
      resolve({ res, req, status: res.statusCode, headers: res.headers });
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(wrapNetError(e));
    });

    try { req.end(); } catch (e) {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(wrapNetError(e)); }
    }
  });
}

/** 把响应体整个读成字符串（只用于 API 的小响应，几 KB） */
function readAll(res, limit) {
  const cap = limit || 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    res.on('data', (buf) => {
      total += buf.length;
      if (total > cap) {
        try { res.destroy(); } catch {}
        reject(new HfError('TOO_LARGE', `响应超过 ${Math.round(cap / 1048576)}MB 上限`));
        return;
      }
      chunks.push(buf);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', (e) => reject(wrapNetError(e)));
    res.on('aborted', () => reject(new HfError('ABORTED', '响应被中断', { retryable: true })));
  });
}

/** 便捷方法：GET 一段文本，非 200 直接抛分类后的错误 */
async function getText(url, opts) {
  const { res } = await requestStream(url, opts);
  if (res.statusCode !== 200) {
    const err = require('./errors').classifyHttp(res.statusCode, url);
    try { res.destroy(); } catch {}
    throw err;
  }
  return readAll(res);
}

module.exports = { requestStream, readAll, getText };
