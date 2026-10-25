/* 网络错误分类与可重试判定 */
'use strict';

class HfError extends Error {
  constructor(code, message, opts) {
    super(message);
    this.name = 'HfError';
    this.code = code;
    const o = opts || {};
    this.retryable = !!o.retryable;
    this.reset = !!o.reset; // 需要重置任务（远端文件变了）
    this.fallbackSingle = !!o.fallbackSingle; // 不支持 Range，降级单流
    this.retryAfterMs = o.retryAfterMs || 0;
    this.detail = o.detail || '';
  }
}

/* 这些底层网络错误值得重试 */
const RETRY_NET = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_TIMED_OUT',
  'ERR_EMPTY_RESPONSE',
  'ERR_SOCKET_NOT_CONNECTED',
  'ERR_NAME_NOT_RESOLVED',
]);

function wrapNetError(e) {
  const raw = (e && (e.code || e.message)) || 'NETWORK';
  const code = String(raw).replace(/^net::/, '');
  const retryable = RETRY_NET.has(code) || /ECONN|ETIMEDOUT|EPIPE|network/i.test(String(raw));
  return new HfError(code, `网络错误：${raw}`, { retryable });
}

/** HTTP 状态码 → HfError */
function classifyHttp(status, extra) {
  const d = extra || '';
  if (status === 401) {
    return new HfError('NOT_FOUND', '仓库不存在，或该仓库需要登录', { retryable: false });
  }
  if (status === 403) {
    return new HfError('GATED', '该仓库需要授权（gated），请先在 Hugging Face 网站同意协议', {
      retryable: false,
    });
  }
  if (status === 404) {
    return new HfError('FILE_GONE', '文件不存在' + (d ? `：${d}` : ''), { retryable: false });
  }
  if (status === 416) {
    return new HfError('RANGE_416', '区间越界，远端文件可能已变化', { retryable: false });
  }
  if (status === 429) {
    return new HfError('RATE_LIMIT', '触发镜像站限流，稍后重试', { retryable: true });
  }
  if (status >= 500) {
    return new HfError('SERVER', `服务器错误 ${status}`, { retryable: true });
  }
  return new HfError('HTTP_' + status, `HTTP ${status}`, { retryable: false });
}

function isRetryable(e) {
  return !!(e && (e.retryable === true));
}

module.exports = { HfError, wrapNetError, classifyHttp, isRetryable, RETRY_NET };
