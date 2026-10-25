/*
 * 分块下载 —— 整个项目最关键的一段
 *
 * 三个要点：
 *
 * 1) 断点续传在【分块内部】也生效。
 *    pos 在 catch 里不重置，网络断了 3 秒，重连后从 pos 继续发 Range，
 *    而不是重下整个 16MB 分块。对弱网是决定性差异。
 *
 * 2) 显式偏移写同一个 fd。
 *    fh.write(buf, off, len, pos+off) 在 libuv 层是 pwrite，多个分块并发写
 *    同一个文件句柄是安全的，靠 position 隔离。不需要"分块临时文件 + 合并"，
 *    省 2 倍磁盘和一次全文件拷贝（10GB 拷贝要好几分钟）。
 *
 * 3) 用 Content-Range 的分母免费校验远端是否变过。
 *    如果远端文件被更新，总大小会变，直接判 REMOTE_CHANGED 重置任务，
 *    不需要额外 API 请求。
 */
'use strict';

const { requestStream } = require('../net/client');
const { HfError, classifyHttp, isRetryable } = require('../net/errors');

const MAX_ATTEMPTS = 6;
const IDLE_TIMEOUT = 30000; // 30 秒没数据就认为卡死

function sleep(ms, task) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      task._sleepResolve = null;
      resolve();
    }, ms);
    // 允许暂停时立刻打断退避，别让用户干等 30 秒
    task._sleepResolve = () => {
      clearTimeout(t);
      task._sleepResolve = null;
      resolve();
    };
  });
}

/** 把响应体按显式偏移写进共享的预分配文件 */
async function pump(res, task, chunk, ctx, startPos) {
  let pos = startPos;
  for await (const buf of res) {
    if (task.abortReason) {
      try { res.destroy(); } catch {}
      throw task.abortReason;
    }
    if (task.pauseRequested) {
      try { res.destroy(); } catch {}
      throw new HfError('PAUSED', '已暂停');
    }

    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await ctx.fh.write(buf, off, buf.length - off, pos + off);
      if (!bytesWritten) throw new HfError('WRITE_ZERO', '写入 0 字节，磁盘可能已满', { retryable: true });
      off += bytesWritten;
    }
    pos += buf.length;

    chunk.done += buf.length;
    if (chunk.done > chunk.len) {
      throw new HfError('OVERRUN', '写入超出分块范围，远端文件可能已变化', { reset: true });
    }
    task.doneBytes += buf.length;
    ctx.meter.add(buf.length);
    ctx.onDirty(task);
  }
}

async function downloadChunk(task, chunk, ctx) {
  let pos = chunk.start + chunk.done; // 断点续传的精髓
  let attempt = 0;

  while (pos <= chunk.end) {
    if (task.abortReason) throw task.abortReason;
    if (task.pauseRequested) throw new HfError('PAUSED', '已暂停');

    await ctx.sem.acquire();
    let res = null;
    try {
      ({ res } = await requestStream(ctx.url, {
        headers: { Range: `bytes=${pos}-${chunk.end}` },
        timeout: IDLE_TIMEOUT,
      }));

      /* ---- 206：正常分段 ---- */
      if (res.statusCode === 206) {
        const cr = String(res.headers['content-range'] || '');
        const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
        if (!m || Number(m[1]) !== pos) {
          try { res.destroy(); } catch {}
          throw new HfError(
            'RANGE_MISMATCH',
            `服务器返回的区间与请求不符（请求 ${pos}，返回 ${m ? m[1] : '?'}）`,
            { retryable: true }
          );
        }
        const total = Number(m[3]);
        if (total !== task.size) {
          try { res.destroy(); } catch {}
          throw new HfError(
            'REMOTE_CHANGED',
            `远端文件已变化（${task.size} → ${total} 字节），需要重新下载`,
            { reset: true }
          );
        }
        await pump(res, task, chunk, ctx, pos);
        return; // 本分块完成
      }

      /* ---- 200：不支持 Range，交给上层降级为单流 ---- */
      if (res.statusCode === 200) {
        try { res.destroy(); } catch {}
        throw new HfError('NO_RANGE', '远端不支持分段下载', { fallbackSingle: true });
      }

      /* ---- 416：可能已下完，也可能远端变小 ---- */
      if (res.statusCode === 416) {
        try { res.destroy(); } catch {}
        if (pos > chunk.end) return;
        throw new HfError('RANGE_416', '区间越界，远端文件可能已变化', { reset: true });
      }

      /* ---- 其他状态码 ---- */
      const status = res.statusCode;
      try { res.destroy(); } catch {}
      throw classifyHttp(status, task.path);
    } catch (e) {
      if (e && e.code === 'PAUSED') throw e;
      if (e && (e.reset || e.fallbackSingle)) throw e;

      attempt++;
      if (!isRetryable(e) || attempt > MAX_ATTEMPTS) throw e;

      const base = e.retryAfterMs || Math.min(30000, 1000 * Math.pow(2, attempt - 1));
      const delay = base + Math.random() * 500;
      ctx.log(
        task,
        `分块 #${chunk.index} 第 ${attempt}/${MAX_ATTEMPTS} 次重试`
          + `（${e.code || e.message}），${(delay / 1000).toFixed(1)} 秒后继续`
      );
      await sleep(delay, task);
      // pos 保持不变：下次请求从断点继续，而不是重下整个分块
    } finally {
      ctx.sem.release();
    }
  }
}

module.exports = { downloadChunk, pump, sleep, MAX_ATTEMPTS, IDLE_TIMEOUT };
