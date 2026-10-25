/* 全局连接数闸门 */
'use strict';

class Semaphore {
  constructor(n) {
    this.limit = Math.max(1, n | 0);
    this.n = this.limit;
    this.waiters = [];
  }

  acquire() {
    if (this.n > 0) {
      this.n--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const w = this.waiters.shift();
    if (w) w();
    else if (this.n < this.limit) this.n++;
  }

  /** 运行时调整上限（设置里改并发） */
  resize(n) {
    const next = Math.max(1, n | 0);
    this.limit = next;
    if (next > this.n) {
      this.n = next;
      // 把等待者放行
      while (this.n > 0 && this.waiters.length) {
        this.n--;
        this.waiters.shift()();
      }
    }
  }
}

module.exports = { Semaphore };
