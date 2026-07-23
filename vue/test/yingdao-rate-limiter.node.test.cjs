'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_ENDPOINT_RATES,
  EndpointRateLimiter,
} = require('../server/services/rateLimiter.cjs');

test('端点限流使用官方上限约 80% 并均匀排队', async () => {
  let now = 0;
  const waits = [];
  const starts = [];
  const limiter = new EndpointRateLimiter({
    now: () => now,
    sleep: async delay => {
      waits.push(delay);
      now += delay;
    },
  });

  await Promise.all([
    limiter.schedule('/oapi/dispatch/v2/task/query', async () => starts.push(now)),
    limiter.schedule('/oapi/dispatch/v2/task/query', async () => starts.push(now)),
    limiter.schedule('/oapi/dispatch/v2/task/query', async () => starts.push(now)),
  ]);

  assert.equal(DEFAULT_ENDPOINT_RATES['/oapi/dispatch/v2/task/query'], 8);
  assert.deepEqual(starts, [0, 125, 250]);
  assert.deepEqual(waits, [125, 125]);
});

test('100+ 任务产生的 120 次查询仍按 8 次每秒平滑排队', async () => {
  let now = 0;
  const starts = [];
  const limiter = new EndpointRateLimiter({
    now: () => now,
    sleep: async delay => { now += delay; },
  });

  await Promise.all(Array.from({ length: 120 }, () =>
    limiter.schedule('/oapi/dispatch/v2/task/query', async () => starts.push(now))
  ));

  assert.equal(starts.length, 120);
  assert.equal(starts[0], 0);
  assert.equal(starts.at(-1), 119 * 125);
  for (let index = 1; index < starts.length; index += 1) {
    assert.equal(starts[index] - starts[index - 1], 125);
  }
});

test('不同 endpoint 使用独立 bucket', async () => {
  let now = 0;
  const starts = [];
  const limiter = new EndpointRateLimiter({
    now: () => now,
    sleep: async delay => { now += delay; },
  });

  await Promise.all([
    limiter.schedule('/oapi/dispatch/v2/task/query', async () => starts.push(['query', now])),
    limiter.schedule('/oapi/dispatch/v2/job/log/search', async () => starts.push(['log', now])),
  ]);

  assert.deepEqual(starts, [['query', 0], ['log', 0]]);
});

test('一次操作失败不会毒死后续限流队列', async () => {
  let now = 0;
  const limiter = new EndpointRateLimiter({
    now: () => now,
    sleep: async delay => { now += delay; },
  });
  await assert.rejects(
    limiter.schedule('/oapi/dispatch/v2/task/newest/list', async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  const result = await limiter.schedule('/oapi/dispatch/v2/task/newest/list', async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(now, 250);
});

test('慢请求不会阻塞后续请求按时取得启动时隙', async () => {
  let now = 0;
  let finishFirst;
  const firstPending = new Promise(resolve => { finishFirst = resolve; });
  const starts = [];
  const limiter = new EndpointRateLimiter({
    now: () => now,
    sleep: async delay => { now += delay; },
  });

  const first = limiter.schedule('/oapi/dispatch/v2/task/query', async () => {
    starts.push(now);
    await firstPending;
    return 'first';
  });
  const second = limiter.schedule('/oapi/dispatch/v2/task/query', async () => {
    starts.push(now);
    return 'second';
  });

  assert.equal(await second, 'second');
  assert.deepEqual(starts, [0, 125]);
  finishFirst();
  assert.equal(await first, 'first');
});
