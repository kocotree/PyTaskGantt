'use strict';

/**
 * 影刀开放 API 的进程内全局调度器。
 *
 * 采用“均匀间隔”而不是突发令牌桶：8 次/秒会被平滑为每 125ms 一次，
 * 因而在任意短窗口内都不会贴着官方上限突发。每个 endpoint bucket 独立，
 * 同一 client 实例内的所有调用共享队列。
 */

const DEFAULT_ENDPOINT_RATES = Object.freeze({
  '/oapi/dispatch/v2/task/newest/list': 4, // 官方 5/s 的 80%
  '/oapi/dispatch/v2/task/list': 8,        // 官方 10/s 的 80%
  '/oapi/dispatch/v2/task/query': 8,       // 官方 10/s 的 80%
  '/oapi/dispatch/v2/task/start': 8,       // 官方 10/s 的 80%
  '/oapi/dispatch/v2/job/log/search': 4,   // 官方 5/s 的 80%

  // 文档未列出更低限制的接口也统一保守控制，避免无限并发。
  '/oapi/dispatch/v2/schedule/list': 8,
  '/oapi/dispatch/v2/schedule/detail': 8,
  '/oapi/dispatch/v2/task/process/detail': 8,
  '/oapi/token/v2/token/create': 4,
});

function defaultSleep(delayMs) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, delayMs)));
}

class EndpointRateLimiter {
  constructor({
    endpointRates = DEFAULT_ENDPOINT_RATES,
    defaultRatePerSecond = 8,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = {}) {
    this.endpointRates = { ...endpointRates };
    this.defaultRatePerSecond = defaultRatePerSecond;
    this.now = now;
    this.sleep = sleep;
    this.buckets = new Map();
  }

  rateFor(endpoint) {
    const configured = Number(this.endpointRates[endpoint]);
    const rate = Number.isFinite(configured) && configured > 0
      ? configured
      : Number(this.defaultRatePerSecond);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new TypeError(`无效的 API 限流速率：${String(rate)}`);
    }
    return rate;
  }

  schedule(endpoint, operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('rateLimiter.schedule 需要 operation 函数');
    }

    const key = String(endpoint || 'default');
    const intervalMs = Math.ceil(1000 / this.rateFor(key));
    const bucket = this.buckets.get(key) || {
      tail: Promise.resolve(),
      nextStartAt: 0,
    };
    this.buckets.set(key, bucket);

    const startSlot = bucket.tail.then(async () => {
      const waitMs = Math.max(0, bucket.nextStartAt - this.now());
      if (waitMs > 0) await this.sleep(waitMs);

      const startedAt = Math.max(this.now(), bucket.nextStartAt);
      bucket.nextStartAt = startedAt + intervalMs;
    });

    // 队列只串行化“取得启动时隙”，不等待慢 HTTP 完成；调用仍拿到 operation 结果。
    bucket.tail = startSlot.then(
      () => undefined,
      () => undefined
    );
    return startSlot.then(operation);
  }

  clear() {
    this.buckets.clear();
  }
}

function createRateLimiter(options) {
  return new EndpointRateLimiter(options);
}

module.exports = {
  DEFAULT_ENDPOINT_RATES,
  EndpointRateLimiter,
  createRateLimiter,
  defaultSleep,
};
