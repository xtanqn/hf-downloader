/* 速度测量：3 秒滑动窗口，比 1 秒稳、比 10 秒跟手 */
'use strict';

class SpeedMeter {
  constructor(windowMs) {
    this.win = windowMs || 3000;
    this.samples = [];
  }

  add(n) {
    if (!n) return;
    this.samples.push([Date.now(), n]);
    this._trim();
  }

  _trim() {
    const cut = Date.now() - this.win;
    while (this.samples.length && this.samples[0][0] < cut) this.samples.shift();
  }

  speed() {
    this._trim();
    if (this.samples.length < 2) return 0;
    const span = (Date.now() - this.samples[0][0]) / 1000;
    if (span <= 0.2) return 0;
    let total = 0;
    for (const s of this.samples) total += s[1];
    return total / span;
  }

  reset() {
    this.samples.length = 0;
  }
}

module.exports = { SpeedMeter };
