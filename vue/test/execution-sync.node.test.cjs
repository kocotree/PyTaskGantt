'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSyncCoordinator,
  isoTimestamp,
  yingdaoTimestamp,
} = require('../server/services/syncCoordinator.cjs');
const { createRetentionService } = require('../server/services/retentionService.cjs');
const { EXECUTION_STATUS } = require('../server/services/executionStatus.cjs');
const { sanitizeForLog } = require('../server/services/yingdaoClient.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeRepositories(tasks) {
  const taskRows = tasks.map(task => ({ syncGeneration: 0, ...task }));
  const executions = new Map();
  const syncUpdates = [];
  const sameTimestamp = (left, right) => {
    if (left == null || right == null) return left == null && right == null;
    return Date.parse(left) === Date.parse(right);
  };
  const tasksRepository = {
    listBoundTasks: async () => taskRows.filter(task => task.scheduleUuid && !task.deletedAt),
    findBindingForScheduleAt: async (scheduleUuid, triggerTime) => {
      const trigger = Date.parse(triggerTime);
      const task = taskRows.find(item =>
        String(item.scheduleUuid) === String(scheduleUuid)
        && (!item.scheduleBoundAt || trigger >= Date.parse(item.scheduleBoundAt))
      );
      return task ? { rpaTaskId: task.id } : null;
    },
    beginSyncAttempt: async attempt => {
      const task = taskRows.find(item => String(item.id) === String(attempt.taskId));
      if (!task
        || task.deletedAt
        || String(task.scheduleUuid || '') !== String(attempt.scheduleUuid || '')
        || !sameTimestamp(task.scheduleBoundAt, attempt.scheduleBoundAt)) {
        return null;
      }
      task.syncGeneration += 1;
      return {
        taskId: String(task.id),
        scheduleUuid: task.scheduleUuid,
        scheduleBoundAt: task.scheduleBoundAt || null,
        syncGeneration: String(task.syncGeneration),
      };
    },
    updateSyncState: async update => {
      const task = taskRows.find(item => String(item.id) === String(update.taskId));
      const matches = task
        && !task.deletedAt
        && String(task.scheduleUuid || '') === String(update.scheduleUuid || '')
        && sameTimestamp(task.scheduleBoundAt, update.scheduleBoundAt)
        && String(task.syncGeneration) === String(update.syncGeneration);
      syncUpdates.push({ ...update, applied: Boolean(matches) });
      if (matches) {
        if (update.lastSyncedAt !== null) {
          const previous = task.lastSyncedAt ? Date.parse(task.lastSyncedAt) : Number.NEGATIVE_INFINITY;
          if (Date.parse(update.lastSyncedAt) >= previous) task.lastSyncedAt = update.lastSyncedAt;
        }
        task.syncError = update.syncError;
      }
      return matches ? task : null;
    },
    findById: async id => taskRows.find(item => String(item.id) === String(id)) || null,
    lockById: async id => taskRows.find(item => String(item.id) === String(id)) || null,
  };
  const executionsRepository = {
    upsertExecution: async execution => {
      const merged = { ...(executions.get(execution.taskUuid) || {}), ...execution };
      executions.set(execution.taskUuid, merged);
      return merged;
    },
    listActiveExecutions: async () => [...executions.values()].filter(execution =>
      [EXECUTION_STATUS.WAITING, EXECUTION_STATUS.RUNNING, EXECUTION_STATUS.UNKNOWN]
        .includes(execution.normalizedStatus)
    ),
    hasActiveExecution: async taskId => [...executions.values()].some(execution =>
      String(execution.rpaTaskId) === String(taskId)
      && [EXECUTION_STATUS.WAITING, EXECUTION_STATUS.RUNNING, EXECUTION_STATUS.UNKNOWN]
        .includes(execution.normalizedStatus)
    ),
    findByTaskUuid: async taskUuid => executions.get(String(taskUuid)) || null,
    deleteExpired: async () => 0,
  };
  return { taskRows, executions, syncUpdates, tasksRepository, executionsRepository };
}

function baseCoordinatorOptions(repositories, client, extra = {}) {
  return {
    client,
    tasksRepository: repositories.tasksRepository,
    executionsRepository: repositories.executionsRepository,
    now: () => new Date('2026-07-22T04:00:00.000Z'),
    sleep: async () => undefined,
    pollFastIntervalMs: 0,
    pollSlowMinIntervalMs: 0,
    pollSlowMaxIntervalMs: 0,
    ...extra,
  };
}

test('影刀无时区时间固定按 Asia/Shanghai 解析和格式化', () => {
  assert.equal(isoTimestamp('2026-07-22 12:34:56'), '2026-07-22T04:34:56.000Z');
  assert.equal(isoTimestamp('2026-07-22T12:34:56.250'), '2026-07-22T04:34:56.250Z');
  assert.equal(yingdaoTimestamp(new Date('2026-07-22T04:34:56.000Z')), '2026-07-22 12:34:56');
  assert.equal(isoTimestamp('2026-02-30 12:00:00'), null);
});

test('同步按 binding interval 归属并过滤 bound_at 之前记录，taskUuid 幂等', async () => {
  const repositories = createFakeRepositories([{
    id: '1',
    ownerUserId: 'u1',
    scheduleUuid: 'schedule-1',
    scheduleBoundAt: '2026-07-22T02:00:00.000Z',
  }]);
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {}));
  const records = [
    {
      taskUuid: 'before', sourceUuid: 'schedule-1', status: 'finish',
      createTime: '2026-07-22T01:00:00.000Z',
    },
    {
      taskUuid: 'after', sourceUuid: 'schedule-1', status: 'running',
      createTime: '2026-07-22T03:00:00.000Z',
    },
  ];

  const first = await coordinator.applyRecords(records);
  assert.deepEqual(first, { received: 2, applied: 1, skipped: 1 });
  assert.equal(repositories.executions.size, 1);
  assert.equal(repositories.executions.get('after').normalizedStatus, EXECUTION_STATUS.RUNNING);

  await coordinator.applyRecords([{
    ...records[1],
    status: 'finish',
    endTime: '2026-07-22T03:10:00.000Z',
  }]);
  assert.equal(repositories.executions.size, 1);
  assert.equal(repositories.executions.get('after').normalizedStatus, EXECUTION_STATUS.SUCCEEDED);
});

test('全局同步和同一用户同步均为 single-flight', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  const globalGate = deferred();
  const userGate = deferred();
  let globalCalls = 0;
  let userCalls = 0;
  const client = {
    fetchNewestTasks: () => {
      globalCalls += 1;
      return globalGate.promise;
    },
    listTaskHistory: () => {
      userCalls += 1;
      return userGate.promise;
    },
  };
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, client));

  const globalOne = coordinator.syncAll();
  const globalTwo = coordinator.syncAll();
  assert.strictEqual(globalOne, globalTwo);
  globalGate.resolve([]);
  await globalOne;
  assert.equal(globalCalls, 1);

  const userOne = coordinator.syncUser('u1');
  const userTwo = coordinator.syncUser('u1');
  assert.strictEqual(userOne, userTwo);
  userGate.resolve([]);
  await userOne;
  assert.equal(userCalls, 1);
});

test('仓储读取失败也会正确释放同步 running 状态', async () => {
  const repositories = createFakeRepositories([]);
  repositories.tasksRepository.listBoundTasks = async () => { throw new Error('db unavailable'); };
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {}));
  await assert.rejects(coordinator.syncAll(), /db unavailable/);
  assert.equal(coordinator.getState().running, false);
});

test('同步失败只写 sync_error，不覆盖已有有效执行状态', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  repositories.executions.set('existing', {
    taskUuid: 'existing',
    rpaTaskId: '1',
    normalizedStatus: EXECUTION_STATUS.SUCCEEDED,
  });
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {
    fetchNewestTasks: async () => { throw new Error('模拟网络失败'); },
  }));

  await assert.rejects(coordinator.syncAll(), /模拟网络失败/);
  assert.equal(repositories.executions.get('existing').normalizedStatus, EXECUTION_STATUS.SUCCEEDED);
  assert.match(repositories.taskRows[0].syncError, /模拟网络失败/);
  assert.match(coordinator.getState().lastError, /模拟网络失败/);
});

test('同步入库前清理执行状态、机器人信息和错误备注中的敏感内容', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {
    sanitize: value => sanitizeForLog(value, ['runtime-secret']),
  }));

  await coordinator.applyRecords([{
    taskUuid: 'safe-execution',
    sourceUuid: 'schedule-1',
    status: 'error',
    statusName: 'Bearer unsafe-token',
    createTime: '2026-07-22T02:00:00.000Z',
    errorRemark: 'runtime-secret accessToken=unsafe-token',
    clients: [{ robotClientName: '客户端', accessToken: 'unsafe-token' }],
  }]);

  const serialized = JSON.stringify(repositories.executions.get('safe-execution'));
  assert.equal(serialized.includes('runtime-secret'), false);
  assert.equal(serialized.includes('unsafe-token'), false);
  assert.match(serialized, /REDACTED/);
});

test('较旧的增量响应不能把终态回退为活动状态', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  repositories.executions.set('same-task', {
    taskUuid: 'same-task',
    rpaTaskId: '1',
    scheduleUuidAtRun: 'schedule-1',
    normalizedStatus: EXECUTION_STATUS.SUCCEEDED,
    rawStatus: 'finish',
    triggerTime: '2026-07-22T02:00:00.000Z',
    updatedTime: '2026-07-22T03:00:00.000Z',
    endTime: '2026-07-22T03:00:00.000Z',
  });
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {}));
  await coordinator.applyRecords([{
    taskUuid: 'same-task',
    sourceUuid: 'schedule-1',
    status: 'running',
    createTime: '2026-07-22T02:00:00.000Z',
    updateTime: '2026-07-22T02:30:00.000Z',
  }]);
  assert.equal(repositories.executions.get('same-task').normalizedStatus, EXECUTION_STATUS.SUCCEEDED);
});

test('缺少更新时间的稀疏终态仍能结束已有活动执行', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  repositories.executions.set('sparse-terminal', {
    taskUuid: 'sparse-terminal',
    rpaTaskId: '1',
    scheduleUuidAtRun: 'schedule-1',
    normalizedStatus: EXECUTION_STATUS.RUNNING,
    rawStatus: 'running',
    triggerTime: '2026-07-22T02:00:00.000Z',
    updatedTime: '2026-07-22T03:00:00.000Z',
  });
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {}));

  const result = await coordinator.applyRecords([{
    taskUuid: 'sparse-terminal',
    sourceUuid: 'schedule-1',
    status: 'finish',
    createTime: '2026-07-22T02:00:00.000Z',
  }]);

  assert.deepEqual(result, { received: 1, applied: 1, skipped: 0 });
  assert.equal(
    repositories.executions.get('sparse-terminal').normalizedStatus,
    EXECUTION_STATUS.SUCCEEDED
  );
});

test('syncTask 校验所有权并同步指定任务', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  let historyCalls = 0;
  const client = {
    listTaskHistory: async () => {
      historyCalls += 1;
      return [{
        taskUuid: 'history-1', sourceUuid: 'schedule-1', status: 'finish',
        createTime: '2026-07-22T03:00:00.000Z',
      }];
    },
  };
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, client));
  const result = await coordinator.syncTask('u1', '1');
  assert.equal(result.applied, 1);
  assert.equal(historyCalls, 1);
  const updatesBeforeUnauthorized = repositories.syncUpdates.length;
  await assert.rejects(coordinator.syncTask('other', '1'), error => {
    assert.equal(error.statusCode, 403);
    return true;
  });
  assert.equal(repositories.syncUpdates.length, updatesBeforeUnauthorized);
});

test('较旧的并发同步失败不能覆盖较新成功状态', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  const oldGate = deferred();
  const oldStarted = deferred();
  const client = {
    fetchNewestTasks: () => {
      oldStarted.resolve();
      return oldGate.promise;
    },
    listTaskHistory: async () => [],
  };
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, client));

  const oldSync = coordinator.syncAll();
  await oldStarted.promise;
  const newer = await coordinator.syncTask('u1', '1');
  assert.equal(newer.stateApplied, true);
  assert.equal(repositories.taskRows[0].syncError, null);

  const oldRejection = assert.rejects(oldSync, /旧请求失败/);
  oldGate.reject(new Error('旧请求失败'));
  await oldRejection;

  assert.equal(repositories.taskRows[0].syncError, null);
  assert.equal(repositories.taskRows[0].lastSyncedAt, newer.syncedAt);
  assert.equal(repositories.syncUpdates.at(-1).applied, false);
});

test('换绑后旧计划同步响应不会标记新绑定已同步', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1',
    scheduleBoundAt: '2026-07-22T02:00:00.000Z',
  }]);
  const historyGate = deferred();
  const historyStarted = deferred();
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {
    listTaskHistory: () => {
      historyStarted.resolve();
      return historyGate.promise;
    },
  }));

  const syncing = coordinator.syncTask('u1', '1');
  await historyStarted.promise;
  repositories.taskRows[0].scheduleUuid = 'schedule-2';
  repositories.taskRows[0].scheduleBoundAt = '2026-07-22T03:30:00.000Z';
  repositories.taskRows[0].lastSyncedAt = null;
  repositories.taskRows[0].syncError = null;
  historyGate.resolve([]);

  const result = await syncing;
  assert.equal(result.stateApplied, false);
  assert.equal(repositories.taskRows[0].lastSyncedAt, null);
  assert.equal(repositories.taskRows[0].syncError, null);
  assert.equal(repositories.syncUpdates.at(-1).applied, false);
});

test('服务重启可恢复活动执行的轮询', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  repositories.executions.set('active-1', {
    taskUuid: 'active-1',
    rpaTaskId: '1',
    scheduleUuidAtRun: 'schedule-1',
    normalizedStatus: EXECUTION_STATUS.RUNNING,
    rawStatus: 'running',
    triggerTime: '2026-07-22T03:00:00.000Z',
  });
  let queryCalls = 0;
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {
    queryTask: async () => {
      queryCalls += 1;
      return { execution: { taskUuid: 'active-1', status: 'finish', endTime: '2026-07-22T04:02:00.000Z' } };
    },
  }));

  assert.equal(await coordinator.recoverPolling(), 1);
  await coordinator.waitForPolling('active-1');
  assert.equal(queryCalls, 1);
  assert.equal(repositories.executions.get('active-1').normalizedStatus, EXECUTION_STATUS.SUCCEEDED);
});

test('服务重启后即使已超过最长轮询时长也先查询一次上游', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  repositories.executions.set('stuck-after-restart', {
    taskUuid: 'stuck-after-restart',
    rpaTaskId: '1',
    scheduleUuidAtRun: 'schedule-1',
    normalizedStatus: EXECUTION_STATUS.WAITING,
    rawStatus: 'created',
    triggerTime: '2026-07-22T01:00:00.000Z',
    updatedTime: '2026-07-22T01:00:00.000Z',
  });
  let queryCalls = 0;
  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {
    queryTask: async () => {
      queryCalls += 1;
      return { execution: { taskUuid: 'stuck-after-restart', status: 'running' } };
    },
  }, {
    now: () => new Date('2026-07-22T08:00:01.000Z'),
    maxPollDurationMs: 6 * 60 * 60 * 1000,
  }));

  assert.equal(await coordinator.recoverPolling(), 1);
  await coordinator.waitForPolling('stuck-after-restart');
  assert.equal(queryCalls, 1);
  assert.equal(
    repositories.executions.get('stuck-after-restart').normalizedStatus,
    EXECUTION_STATUS.RUN_TIMEOUT
  );
});

test('长任务在六小时上限前持续轮询，慢速间隔始终保持十五至三十秒', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  const startedAt = Date.parse('2026-07-22T04:00:00.000Z');
  const twoHours = 2 * 60 * 60 * 1000;
  const sixHours = 6 * 60 * 60 * 1000;
  const terminalAt = startedAt + sixHours - 60_000;
  const randomValues = [0, 0.5, 1];
  const sleepEvents = [];
  const queryTimes = [];
  let nowMs = startedAt;
  let randomIndex = 0;

  const coordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {
    queryTask: async () => {
      queryTimes.push(nowMs);
      const finished = nowMs >= terminalAt;
      return {
        execution: {
          taskUuid: 'long-running-task',
          status: finished ? 'finish' : 'running',
          ...(finished ? { endTime: new Date(nowMs).toISOString() } : {}),
        },
      };
    },
  }, {
    now: () => new Date(nowMs),
    sleep: async delay => {
      sleepEvents.push({ elapsed: nowMs - startedAt, delay });
      nowMs += delay;
    },
    random: () => randomValues[randomIndex++ % randomValues.length],
    pollFastDurationMs: 120_000,
    pollFastIntervalMs: 5_000,
    pollSlowMinIntervalMs: 15_000,
    pollSlowMaxIntervalMs: 30_000,
  }));

  const result = await coordinator.trackExecution({
    taskUuid: 'long-running-task',
    rpaTaskId: '1',
    scheduleUuidAtRun: 'schedule-1',
    normalizedStatus: EXECUTION_STATUS.RUNNING,
    rawStatus: 'running',
    triggerTime: new Date(startedAt).toISOString(),
    updatedTime: new Date(startedAt).toISOString(),
  });

  const slowSleeps = sleepEvents.filter(event => event.elapsed >= 120_000);
  assert.ok(queryTimes.some(time => time - startedAt > twoHours));
  assert.ok(queryTimes.at(-1) >= terminalAt);
  assert.ok(queryTimes.at(-1) - startedAt < sixHours);
  assert.ok(slowSleeps.length > 0);
  assert.ok(slowSleeps.every(({ delay }) => delay >= 15_000 && delay <= 30_000));
  assert.deepEqual(new Set(slowSleeps.map(({ delay }) => delay)), new Set([15_000, 22_500, 30_000]));
  assert.equal(result.normalizedStatus, EXECUTION_STATUS.SUCCEEDED);
  assert.doesNotMatch(String(result.errorRemark || ''), /本平台轮询超过/);
});

test('轮询容忍短暂失败，并在本地最长轮询时长后落为可清理终态', async () => {
  const repositories = createFakeRepositories([{
    id: '1', ownerUserId: 'u1', scheduleUuid: 'schedule-1', scheduleBoundAt: null,
  }]);
  let queryCalls = 0;
  const transient = createSyncCoordinator(baseCoordinatorOptions(repositories, {
    queryTask: async () => {
      queryCalls += 1;
      if (queryCalls === 1) throw new Error('temporary');
      return { execution: { taskUuid: 'transient', status: 'finish', endTime: '2026-07-22T04:01:00.000Z' } };
    },
  }, { maxConsecutivePollErrors: 2 }));
  await transient.trackExecution({
    taskUuid: 'transient',
    rpaTaskId: '1',
    scheduleUuidAtRun: 'schedule-1',
    normalizedStatus: EXECUTION_STATUS.RUNNING,
    triggerTime: '2026-07-22T04:00:00.000Z',
    updatedTime: '2026-07-22T04:00:00.000Z',
  });
  assert.equal(queryCalls, 2);
  assert.equal(repositories.executions.get('transient').normalizedStatus, EXECUTION_STATUS.SUCCEEDED);

  let nowMs = Date.parse('2026-07-22T04:00:00.000Z');
  const timeoutCoordinator = createSyncCoordinator(baseCoordinatorOptions(repositories, {
    queryTask: async () => ({ execution: { taskUuid: 'timeout-run', status: 'running' } }),
  }, {
    now: () => new Date(nowMs),
    sleep: async delay => { nowMs += delay; },
    pollFastIntervalMs: 10,
    maxPollDurationMs: 5,
  }));
  const timedOut = await timeoutCoordinator.trackExecution({
    taskUuid: 'timeout-run',
    rpaTaskId: '1',
    scheduleUuidAtRun: 'schedule-1',
    normalizedStatus: EXECUTION_STATUS.RUNNING,
    rawStatus: 'running',
    rawStatusName: '运行中',
    triggerTime: '2026-07-22T04:00:00.000Z',
    updatedTime: '2026-07-22T04:00:00.000Z',
    endTime: null,
  });
  assert.equal(timedOut.normalizedStatus, EXECUTION_STATUS.RUN_TIMEOUT);
  assert.equal(timedOut.rawStatus, 'running');
  assert.equal(timedOut.rawStatusName, '运行中');
  assert.equal(timedOut.updatedTime, '2026-07-22T04:00:00.000Z');
  assert.equal(timedOut.endTime, null);
  assert.match(timedOut.errorRemark, /本平台轮询超过/);

  await timeoutCoordinator.applyRecords([{
    taskUuid: 'timeout-run',
    sourceUuid: 'schedule-1',
    status: 'finish',
    statusName: '运行成功',
    createTime: '2026-07-22T04:00:00.000Z',
    updateTime: '2026-07-22T06:00:00.000Z',
    endTime: '2026-07-22T06:00:00.000Z',
  }]);
  const recovered = repositories.executions.get('timeout-run');
  assert.equal(recovered.normalizedStatus, EXECUTION_STATUS.SUCCEEDED);
  assert.equal(recovered.rawStatus, 'finish');
  assert.equal(recovered.endTime, '2026-07-22T06:00:00.000Z');
  assert.equal(recovered.errorRemark, '');

  const unknownTimeout = createSyncCoordinator(baseCoordinatorOptions(repositories, {
    queryTask: async () => ({ execution: { taskUuid: 'unknown-timeout', status: 'new-status' } }),
  }, {
    now: () => new Date('2026-07-22T10:00:00.000Z'),
    maxPollDurationMs: 5,
  }));
  const unknown = await unknownTimeout.trackExecution({
    taskUuid: 'unknown-timeout',
    rpaTaskId: '1',
    scheduleUuidAtRun: 'schedule-1',
    normalizedStatus: EXECUTION_STATUS.UNKNOWN,
    rawStatus: 'new-status',
    triggerTime: '2026-07-22T04:00:00.000Z',
    updatedTime: '2026-07-22T04:00:00.000Z',
  });
  assert.equal(unknown.normalizedStatus, EXECUTION_STATUS.FAILED);
  assert.equal(unknown.rawStatus, 'new-status');
});

test('30 天保留期清理接口为 single-flight 并返回删除数量', async () => {
  const gate = deferred();
  let calls = 0;
  const service = createRetentionService({
    retentionDays: 30,
    executionsRepository: {
      deleteExpired: async days => {
        calls += 1;
        assert.equal(days, 30);
        return gate.promise;
      },
    },
  });
  const first = service.runCleanup();
  const second = service.runCleanup();
  assert.strictEqual(first, second);
  gate.resolve({ rowCount: 2 });
  assert.deepEqual(await first, { deleted: 2, retentionDays: 30 });
  assert.equal(calls, 1);
  assert.equal(service.getState().lastDeleted, 2);
});
