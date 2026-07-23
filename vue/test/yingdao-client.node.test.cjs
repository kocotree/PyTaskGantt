'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  YingdaoApiError,
  createYingdaoClient,
  createScheduleDirectory,
  createExecutionDetails,
  redactSensitive,
} = require('../server/services/yingdaoClient.cjs');

const immediateLimiter = { schedule: (_endpoint, operation) => operation() };

function jsonResponse(status, body, headers = {}) {
  const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: key => normalizedHeaders.get(String(key).toLowerCase()) || null },
    text: async () => JSON.stringify(body),
  };
}

function sequenceFetch(sequence, calls = []) {
  let index = 0;
  return async (url, init) => {
    calls.push({ url, init });
    if (index >= sequence.length) throw new Error('fake fetch response exhausted');
    const value = sequence[index++];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(url, init) : value;
  };
}

function tokenResponse(token, expiresIn = 3600) {
  return jsonResponse(200, {
    success: true,
    code: 200,
    data: { accessToken: token, expiresIn },
  });
}

function clientOptions(fetchImpl, extra = {}) {
  return {
    accessKeyId: 'ak-id',
    accessKeySecret: 'ak-secret',
    fetchImpl,
    rateLimiter: immediateLimiter,
    retryJitterRatio: 0,
    ...extra,
  };
}

test('Token single-flight 且提前 60 秒过期', async () => {
  let now = 0;
  const calls = [];
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('token-1', 120),
    tokenResponse('token-2', 120),
  ], calls), { now: () => now }));

  const [first, second] = await Promise.all([
    client.getAccessToken(),
    client.getAccessToken(),
  ]);
  assert.equal(first, 'token-1');
  assert.equal(second, 'token-1');
  assert.equal(calls.length, 1);

  now = 59_999;
  assert.equal(await client.getAccessToken(), 'token-1');
  assert.equal(calls.length, 1);

  now = 60_000;
  assert.equal(await client.getAccessToken(), 'token-2');
  assert.equal(calls.length, 2);
});

test('401 强制刷新 Token 并只重试原请求一次', async () => {
  const calls = [];
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('old-token'),
    jsonResponse(401, { success: false, code: 401, msg: 'expired' }),
    tokenResponse('new-token'),
    jsonResponse(200, { success: true, code: 200, data: { taskUuid: 'task-1', status: 'running' } }),
  ], calls)));

  const result = await client.queryTask('task-1');
  assert.equal(result.execution.status, 'running');
  assert.equal(calls.length, 4);
  assert.match(calls[1].init.headers.Authorization, /old-token/);
  assert.match(calls[3].init.headers.Authorization, /new-token/);
});

test('第二次 401 不会无限刷新', async () => {
  const calls = [];
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('old-token'),
    jsonResponse(401, { success: false, code: 401, msg: 'expired' }),
    tokenResponse('new-token'),
    jsonResponse(401, { success: false, code: 401, msg: 'still expired' }),
  ], calls)));

  await assert.rejects(client.queryTask('task-1'), error => {
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(calls.filter(call => call.url.includes('/token/create')).length, 2);
  assert.equal(calls.length, 4);
});

test('429、5xx 和网络错误按有限次数退避重试，400 不重试', async () => {
  const waits = [];
  const retryCalls = [];
  const retryClient = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('token'),
    jsonResponse(429, { success: false, code: 429, msg: 'slow down' }),
    jsonResponse(503, { success: false, code: 503, msg: 'busy' }),
    jsonResponse(200, { success: true, code: 200, data: { taskUuid: 'task-1', status: 'finish' } }),
  ], retryCalls), {
    maxRetries: 2,
    sleep: async delay => waits.push(delay),
  }));
  assert.equal((await retryClient.queryTask('task-1')).execution.status, 'finish');
  assert.deepEqual(waits, [250, 500]);
  assert.equal(retryCalls.length, 4);

  const networkCalls = [];
  const networkClient = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('token'),
    new Error('socket closed'),
    jsonResponse(200, { success: true, code: 200, data: { taskUuid: 'task-2' } }),
  ], networkCalls), {
    maxRetries: 1,
    sleep: async () => undefined,
  }));
  await networkClient.queryTask('task-2');
  assert.equal(networkCalls.length, 3);

  const badRequestCalls = [];
  const badRequestClient = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('token'),
    jsonResponse(400, { success: false, code: 400, msg: 'bad payload' }),
  ], badRequestCalls), { maxRetries: 3 }));
  await assert.rejects(badRequestClient.queryTask('task-3'), /bad payload/);
  assert.equal(badRequestCalls.length, 2);
});

test('429 Retry-After 优先于普通 5 秒退避上限', async () => {
  const waits = [];
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('token'),
    jsonResponse(429, { success: false, code: 429, msg: 'later' }, { 'retry-after': '30' }),
    jsonResponse(200, { success: true, code: 200, data: { taskUuid: 'task-1' } }),
  ]), {
    maxRetries: 1,
    retryMaxDelayMs: 5_000,
    sleep: async delay => waits.push(delay),
  }));
  await client.queryTask('task-1');
  assert.deepEqual(waits, [30_000]);
});

test('普通错误、日志文本不会泄露凭证和 Token', async () => {
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('top-secret-token'),
    jsonResponse(400, {
      success: false,
      code: 400,
      msg: 'ak-secret Bearer top-secret-token accessKeySecret=ak-secret',
    }),
  ])));
  await assert.rejects(client.queryTask('task-1'), error => {
    assert.equal(error.message.includes('ak-secret'), false);
    assert.equal(error.message.includes('top-secret-token'), false);
    assert.match(error.message, /REDACTED/);
    return true;
  });
  assert.equal(redactSensitive('Authorization: Bearer abc accessKeySecret=xyz').includes('abc'), false);
});

test('返回浏览器的作业日志会清理凭证、Token 和敏感字段', async () => {
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('top-secret-token'),
    jsonResponse(200, {
      success: true,
      code: 200,
      data: {
        logs: [{
          message: 'Authorization: Bearer top-secret-token; credential=ak-secret',
          accessToken: 'top-secret-token',
          nested: { accessKeySecret: 'ak-secret', note: 'ak-id' },
        }],
      },
    }),
  ])));

  const result = await client.getJobLogs('job-1');
  const serialized = JSON.stringify(result.logs);
  assert.equal(serialized.includes('top-secret-token'), false);
  assert.equal(serialized.includes('ak-secret'), false);
  assert.equal(serialized.includes('ak-id'), false);
  assert.match(serialized, /REDACTED/);
});

test('返回浏览器的应用执行明细也会清理凭证、Token 和敏感字段', async () => {
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('top-secret-token'),
    jsonResponse(200, {
      success: true,
      code: 200,
      data: {
        jobList: [{
          jobUuid: 'job-1',
          remark: 'Bearer top-secret-token / ak-secret / ak-id',
          accessToken: 'top-secret-token',
          nested: { accessKeySecret: 'ak-secret' },
        }],
      },
    }),
  ])));

  const jobs = await client.getExecutionJobs('task-1');
  const serialized = JSON.stringify(jobs);
  assert.equal(serialized.includes('top-secret-token'), false);
  assert.equal(serialized.includes('ak-secret'), false);
  assert.equal(serialized.includes('ak-id'), false);
  assert.match(serialized, /REDACTED/);
});

test('计划缓存 60 秒，接口失败时仅回退到 5 分钟内可信缓存', async () => {
  let now = 0;
  const calls = [];
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('token'),
    jsonResponse(200, {
      success: true,
      code: 200,
      data: [{ scheduleUuid: 'schedule-1', scheduleName: '日报' }],
      page: { pages: 1 },
    }),
    new Error('offline'),
    new Error('still offline'),
  ], calls), {
    now: () => now,
    maxRetries: 0,
  }));

  const fresh = await client.listSchedules({ page: 1, size: 20 });
  assert.equal(fresh.cache.hit, false);
  assert.equal((await client.listSchedules({ page: 1, size: 20 })).cache.hit, true);
  assert.equal(calls.length, 2);

  now = 61_000;
  const stale = await client.listSchedules({ page: 1, size: 20 });
  assert.equal(stale.cache.stale, true);
  assert.equal(stale.schedules[0].scheduleUuid, 'schedule-1');

  now = 301_000;
  await assert.rejects(client.listSchedules({ page: 1, size: 20 }), /无法连接影刀接口/);
});

test('同一缓存 key 的并发 miss 合并为一次影刀请求', async () => {
  let releaseSchedule;
  const scheduleResponse = new Promise(resolve => { releaseSchedule = resolve; });
  let scheduleCalls = 0;
  const fetchImpl = async url => {
    if (url.includes('/token/create')) return tokenResponse('token');
    scheduleCalls += 1;
    return scheduleResponse;
  };
  const client = createYingdaoClient(clientOptions(fetchImpl));
  const first = client.listSchedules({ page: 1, size: 20 });
  const second = client.listSchedules({ page: 1, size: 20 });
  await Promise.resolve();
  releaseSchedule(jsonResponse(200, {
    success: true,
    code: 200,
    data: [{ scheduleUuid: 's-1', scheduleName: '日报' }],
  }));
  assert.equal((await first).schedules.length, 1);
  assert.equal((await second).schedules.length, 1);
  assert.equal(scheduleCalls, 1);
});

test('计划搜索由目录在完整分页结果上执行，不向上游发送未知 query 字段', async () => {
  const calls = [];
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('token'),
    jsonResponse(200, {
      success: true,
      code: 200,
      data: [{ scheduleUuid: 's-1', scheduleName: '日报' }],
      page: { pages: 1 },
    }),
  ], calls)));
  const directory = createScheduleDirectory({ client });
  const result = await directory.list({ query: '日报', page: 1, size: 20 });
  assert.equal(result.schedules[0].schedule_uuid, 's-1');
  const upstreamPayload = JSON.parse(calls[1].init.body);
  assert.equal(Object.hasOwn(upstreamPayload, 'query'), false);
});

test('日志缓存五分钟，并提供 scheduleDirectory/executionDetails 接入门面', async () => {
  let now = 0;
  const calls = [];
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('token'),
    jsonResponse(200, {
      success: true,
      code: 200,
      data: {
        logs: [{ time: '2026-07-22 10:00:00', message: 'ok' }],
        page: 1,
        size: 100,
        total: 120,
        hasData: true,
      },
    }),
  ], calls), { now: () => now }));

  const firstLogs = await client.getJobLogs('job-1');
  assert.equal(firstLogs.logs.length, 1);
  assert.deepEqual(firstLogs.pagination, { page: 1, size: 100, total: 120, hasMore: true });
  assert.equal(Object.hasOwn(firstLogs, 'raw'), false);
  now = 299_999;
  assert.equal((await client.getJobLogs('job-1')).cache.hit, true);
  assert.equal(calls.length, 2);
  client.request = async () => { throw new Error('temporary log outage'); };
  const staleLogs = await client.getJobLogs('job-1', { forceRefresh: true });
  assert.equal(staleLogs.cache.stale, true);
  assert.deepEqual(staleLogs.pagination, firstLogs.pagination);
  client.getTaskProcessDetail = async (_taskUuid, robotClientUuid) => ({
    jobs: [{ jobUuid: 'job-fallback', robotClientUuid: robotClientUuid || null }],
  });
  assert.equal((await client.getExecutionJobs('task-no-clients', []))[0].jobUuid, 'job-fallback');

  const fakeClient = {
    listSchedules: async () => ({
      schedules: [{ scheduleUuid: 's-1', scheduleName: '月报' }],
      page: {},
      cache: { hit: false, stale: false },
    }),
    ensureScheduleExists: async uuid => ({ schedule: { scheduleUuid: uuid } }),
    getExecutionJobs: async (_taskUuid, clients) => clients.map(client => ({ jobUuid: client.robotClientUuid })),
    getJobLogs: async () => ({ logs: [{ message: 'log' }], cache: {} }),
  };
  const directory = createScheduleDirectory({
    client: fakeClient,
    listBindings: async () => [{ scheduleUuid: 's-1', taskId: '10', task: '平台任务' }],
    findBinding: async () => ({ scheduleUuid: 's-1', taskId: '10' }),
  });
  assert.equal((await directory.list({ include_bound: true })).schedules[0].bound, true);
  assert.equal((await directory.list({ query: '月报', include_bound: false })).schedules[0].bound, true);
  await assert.rejects(directory.assertBindable('s-1', { taskId: '11' }), /已绑定/);
  assert.equal((await directory.assertBindable('s-1', { taskId: '10' })).schedule.scheduleUuid, 's-1');

  const mergedJobs = [];
  const persistedJobs = new Set(['job-1']);
  const details = createExecutionDetails({
    client: fakeClient,
    executionsRepository: {
      findByTaskUuid: async () => ({ clients: [{ robotClientUuid: 'robot-1' }] }),
      findByJobUuid: async (jobUuid, options) => {
        assert.equal(options.currentUserId, 'user-1');
        return persistedJobs.has(jobUuid)
          ? { taskUuid: 'task-1', jobUuidList: [...persistedJobs] }
          : null;
      },
      mergeJobUuids: async (taskUuid, jobUuids) => {
        mergedJobs.push({ taskUuid, jobUuids });
        jobUuids.forEach(jobUuid => persistedJobs.add(jobUuid));
      },
    },
  });
  assert.equal((await details.getJobs('task-1'))[0].jobUuid, 'robot-1');
  assert.deepEqual(mergedJobs, [{ taskUuid: 'task-1', jobUuids: ['robot-1'] }]);
  assert.equal((await details.getLogs('job-1', { currentUserId: 'user-1' })).logs[0].message, 'log');
  assert.equal((await details.getLogs('robot-1', { currentUserId: 'user-1' })).logs[0].message, 'log');
  assert.equal(Object.hasOwn(await details.getLogs('job-1', { currentUserId: 'user-1' }), 'raw'), false);

  const missingDetails = createExecutionDetails({
    client: fakeClient,
    executionsRepository: { findByTaskUuid: async () => null },
  });
  await assert.rejects(missingDetails.getJobs('missing'), error => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, 'EXECUTION_NOT_FOUND');
    return true;
  });

  let upstreamLogCalls = 0;
  const unauthorizedLogs = createExecutionDetails({
    client: { getJobLogs: async () => { upstreamLogCalls += 1; return { logs: [] }; } },
    executionsRepository: { findByJobUuid: async () => null },
  });
  await assert.rejects(unauthorizedLogs.getLogs('foreign-job'), error => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, 'JOB_NOT_FOUND');
    return true;
  });
  assert.equal(upstreamLogCalls, 0);
});

test('计划详情成功但 data 为空时明确返回 404', async () => {
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('token'),
    jsonResponse(200, { success: true, code: 200, data: {} }),
  ])));
  await assert.rejects(client.ensureScheduleExists('missing-schedule'), error => {
    assert.equal(error.name, 'YingdaoApiError');
    assert.equal(error.status, 404);
    assert.equal(error.code, 'SCHEDULE_NOT_FOUND');
    return true;
  });
});

test('鉴权或业务 4xx 不得使用计划缓存绕过绑定校验', async () => {
  const client = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('old-token'),
    jsonResponse(200, {
      success: true,
      code: 200,
      data: [{ scheduleUuid: 'cached-schedule', scheduleName: '缓存计划' }],
    }),
    jsonResponse(401, { success: false, code: 401, msg: 'expired' }),
    tokenResponse('new-token'),
    jsonResponse(401, { success: false, code: 401, msg: 'denied' }),
  ])));
  await client.listSchedules({ page: 1, size: 20 });
  await assert.rejects(client.ensureScheduleExists('cached-schedule'), error => {
    assert.equal(error.status, 401);
    return true;
  });

  const businessErrorClient = createYingdaoClient(clientOptions(sequenceFetch([
    tokenResponse('token'),
    jsonResponse(200, {
      success: true,
      code: 200,
      data: { scheduleUuid: 'cached-detail', scheduleName: '曾经存在的计划' },
    }),
    jsonResponse(200, { success: false, code: 404, msg: 'schedule deleted' }),
  ])));
  await businessErrorClient.getScheduleDetail('cached-detail', { forceRefresh: true });
  await assert.rejects(businessErrorClient.ensureScheduleExists('cached-detail'), error => {
    assert.equal(error.code, 404);
    return true;
  });
});

test('短期缓存有数量上限，避免任意查询和 jobUuid 无限占用内存', async () => {
  const client = createYingdaoClient(clientOptions(async () => tokenResponse('unused'), {
    maxJobLogCacheEntries: 2,
  }));
  client.request = async (_path, payload) => ({
    success: true,
    code: 200,
    data: { logs: [{ jobUuid: payload.jobUuid }] },
  });
  await client.getJobLogs('job-1');
  await client.getJobLogs('job-2');
  await client.getJobLogs('job-3');
  assert.equal(client.jobLogCache.size, 2);
  for (const entry of client.jobLogCache.values()) {
    assert.equal(Object.hasOwn(entry.value, 'raw'), false);
  }
});

test('YingdaoApiError 保留结构化状态但不暴露内部响应', () => {
  const error = new YingdaoApiError('bad', { status: 429, code: 429, retryable: true });
  assert.equal(error.status, 429);
  assert.equal(error.code, 429);
  assert.equal(error.retryable, true);
});
