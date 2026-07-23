const test = require('node:test');
const assert = require('node:assert/strict');

const { createTaskActionService } = require('../server/services/taskActionService.cjs');

function cloneState(value) {
  return structuredClone(value);
}

function createHarness({
  initialRequests = [],
  initialExecutions = [],
  failAuditOnce = false,
  startError = null,
  taskOverrides = {},
  mutateTaskAfterPrepare = null,
} = {}) {
  let state = {
    task: {
      id: '1',
      owner_user_id: '7',
      schedule_uuid: 'schedule-1',
      schedule_bound_at: '2026-07-22T01:00:00.000Z',
      deleted_at: null,
      ...taskOverrides,
    },
    requests: new Map(initialRequests.map(request => [request.idempotentUuid, { ...request }])),
    executions: new Map(initialExecutions.map(execution => [execution.task_uuid, { ...execution }])),
    audits: [],
  };
  let shouldFailAudit = failAuditOnce;
  let auditSequence = 0;
  let openTransactions = 0;
  let taskMutatedAfterPrepare = false;

  function selectedState(executor) {
    return executor && executor.transactionState ? executor.transactionState : state;
  }

  const pool = {
    async connect() {
      const client = {
        transactionState: null,
        async query(sql, params = []) {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          if (text === 'BEGIN') {
            client.transactionState = cloneState(state);
            openTransactions += 1;
            return { rows: [] };
          }
          if (text === 'COMMIT') {
            state = client.transactionState;
            client.transactionState = null;
            openTransactions -= 1;
            if (
              !taskMutatedAfterPrepare
              && typeof mutateTaskAfterPrepare === 'function'
              && [...state.requests.values()].some(request =>
                request.status === 'pending' && request.attemptCount === 0
              )
            ) {
              mutateTaskAfterPrepare(state.task);
              taskMutatedAfterPrepare = true;
            }
            return { rows: [] };
          }
          if (text === 'ROLLBACK') {
            client.transactionState = null;
            openTransactions -= 1;
            return { rows: [] };
          }

          const transactionState = selectedState(client);
          if (text.includes('FROM rpa_tasks WHERE id = $1') && text.includes('FOR UPDATE')) {
            const includeDeleted = !text.includes('deleted_at IS NULL');
            const task = transactionState.task;
            return {
              rows: task && String(task.id) === String(params[0]) && (includeDeleted || !task.deleted_at)
                ? [{ ...task }]
                : [],
            };
          }
          if (text.includes('FROM rpa_task_executions') && text.includes('normalized_status = ANY')) {
            const requestedIdempotentUuid = params[4] == null ? null : String(params[4]);
            const execution = [...transactionState.executions.values()]
              .filter(row =>
                String(row.rpa_task_id) === String(params[0])
                && params[1].includes(row.normalized_status)
                && (!params[2] || String(row.schedule_uuid_at_run) === String(params[2]))
                && (!params[3] || Date.parse(row.trigger_time) >= Date.parse(params[3]))
              )
              .sort((left, right) => {
                const leftMatches = requestedIdempotentUuid != null
                  && String(left.idempotent_uuid) === requestedIdempotentUuid;
                const rightMatches = requestedIdempotentUuid != null
                  && String(right.idempotent_uuid) === requestedIdempotentUuid;
                if (leftMatches !== rightMatches) return leftMatches ? -1 : 1;
                const leftUpdatedAt = Date.parse(left.updated_time || left.trigger_time || '') || 0;
                const rightUpdatedAt = Date.parse(right.updated_time || right.trigger_time || '') || 0;
                return rightUpdatedAt - leftUpdatedAt;
              })[0];
            return { rows: execution ? [{ ...execution }] : [] };
          }
          if (text.startsWith('INSERT INTO rpa_task_executions')) {
            const taskUuid = String(params[0]);
            const existing = transactionState.executions.get(taskUuid);
            const incomingJobUuidList = JSON.parse(params[4]);
            if (existing) {
              const idempotentMatches = existing.idempotent_uuid == null
                || String(existing.idempotent_uuid) === String(params[5]);
              const contextMatches = String(existing.rpa_task_id) === String(params[1])
                && String(existing.schedule_uuid_at_run) === String(params[2]);
              if (!idempotentMatches || !contextMatches) return { rows: [], rowCount: 0 };
              Object.assign(existing, {
                rpa_task_id: String(params[1]),
                schedule_uuid_at_run: params[2],
                job_uuid_list: Array.isArray(existing.job_uuid_list)
                  && existing.job_uuid_list.length > 0
                  ? existing.job_uuid_list
                  : incomingJobUuidList,
                idempotent_uuid: existing.idempotent_uuid || params[5],
                started_by_user_id: existing.started_by_user_id
                  || (params[6] == null ? null : String(params[6])),
              });
              return { rows: [{ task_uuid: taskUuid }], rowCount: 1 };
            }
            transactionState.executions.set(taskUuid, {
              task_uuid: taskUuid,
              rpa_task_id: String(params[1]),
              schedule_uuid_at_run: params[2],
              normalized_status: params[7],
              raw_status: 'created',
              raw_status_name: '已创建',
              trigger_time: params[3],
              updated_time: params[3],
              job_uuid_list: incomingJobUuidList,
              idempotent_uuid: params[5],
              started_by_user_id: params[6] == null ? null : String(params[6]),
            });
            return { rows: [{ task_uuid: taskUuid }], rowCount: 1 };
          }
          if (text.startsWith('INSERT INTO rpa_task_audit_log')) {
            if (shouldFailAudit) {
              shouldFailAudit = false;
              throw new Error('simulated audit write failure after remote success');
            }
            auditSequence += 1;
            transactionState.audits.push({
              id: auditSequence,
              task_id: String(params[0]),
              actor_user_id: String(params[1]),
              action: params[2],
              new_value: JSON.parse(params[4]),
            });
            return { rows: [{ id: auditSequence }], rowCount: 1 };
          }
          throw new Error(`Unexpected SQL in run request harness: ${text}`);
        },
        release() {},
      };
      return client;
    },
    async query(sql, params) {
      const client = await pool.connect();
      return client.query(sql, params);
    },
  };

  const runRequestsRepository = {
    async createPending(request, options = {}) {
      const target = selectedState(options.executor);
      const saved = {
        ...request,
        status: 'pending',
        taskUuid: null,
        jobUuidList: [],
        auditLogId: null,
        attemptCount: 0,
        lastAttemptAt: null,
        nextAttemptAt: null,
        lastError: null,
        completedAt: null,
        createdAt: '2026-07-22T02:00:00.000Z',
      };
      target.requests.set(saved.idempotentUuid, saved);
      return { ...saved };
    },
    async findOpenForTask(taskId, options = {}) {
      const target = selectedState(options.executor);
      const request = [...target.requests.values()].find(item =>
        String(item.rpaTaskId) === String(taskId)
        && ['pending', 'dispatching'].includes(item.status)
      );
      return request ? { ...request } : null;
    },
    async findByIdempotentUuid(idempotentUuid, options = {}) {
      const request = selectedState(options.executor).requests.get(idempotentUuid);
      return request ? { ...request } : null;
    },
    async markDispatching(idempotentUuid, attemptedAt, options = {}) {
      const target = selectedState(options.executor);
      const request = target.requests.get(idempotentUuid);
      if (!request || !['pending', 'dispatching'].includes(request.status)) return null;
      Object.assign(request, {
        status: 'dispatching',
        attemptCount: request.attemptCount + 1,
        lastAttemptAt: attemptedAt.toISOString(),
        nextAttemptAt: null,
        lastError: null,
      });
      return { ...request };
    },
    async markRemoteAccepted(idempotentUuid, result, options = {}) {
      const target = selectedState(options.executor);
      const request = target.requests.get(idempotentUuid);
      if (
        !request
        || request.status !== 'dispatching'
        || (request.taskUuid != null && String(request.taskUuid) !== String(result.taskUuid))
      ) {
        return null;
      }
      Object.assign(request, {
        taskUuid: result.taskUuid,
        jobUuidList: [...(result.jobUuidList || [])],
        nextAttemptAt: null,
        lastError: null,
      });
      return { ...request };
    },
    async markSucceeded(idempotentUuid, result, options = {}) {
      const target = selectedState(options.executor);
      const request = target.requests.get(idempotentUuid);
      if (!request || request.status !== 'dispatching') return null;
      Object.assign(request, {
        status: 'succeeded',
        taskUuid: result.taskUuid,
        jobUuidList: [...result.jobUuidList],
        auditLogId: String(result.auditLogId),
        completedAt: result.completedAt.toISOString(),
        nextAttemptAt: null,
        lastError: null,
      });
      return { ...request };
    },
    async recordFailure(idempotentUuid, failure, options = {}) {
      const target = selectedState(options.executor);
      const request = target.requests.get(idempotentUuid);
      if (!request || !['pending', 'dispatching'].includes(request.status)) return null;
      Object.assign(request, {
        status: failure.rejected ? 'rejected' : 'pending',
        lastAttemptAt: request.taskUuid == null
          ? failure.attemptedAt.toISOString()
          : request.lastAttemptAt,
        nextAttemptAt: failure.nextAttemptAt && failure.nextAttemptAt.toISOString(),
        lastError: failure.errorMessage,
        completedAt: failure.rejected ? failure.attemptedAt.toISOString() : null,
      });
      return { ...request };
    },
    async listPendingDue() {
      return [...state.requests.values()]
        .filter(request => ['pending', 'dispatching'].includes(request.status))
        .map(request => ({ ...request }));
    },
  };

  const startCalls = [];
  const remoteExecutions = new Map();
  const yingdaoClient = {
    async startTask(scheduleUuid, options) {
      const request = state.requests.get(options.idempotentUuid);
      assert.ok(request, 'run request must be committed before remote dispatch');
      assert.equal(request.status, 'dispatching');
      assert.equal(openTransactions, 0, 'remote start must run outside a database transaction');
      startCalls.push({ scheduleUuid, idempotentUuid: options.idempotentUuid });
      if (startError) throw startError;
      if (!remoteExecutions.has(options.idempotentUuid)) {
        remoteExecutions.set(options.idempotentUuid, `remote-${remoteExecutions.size + 1}`);
      }
      return {
        taskUuid: remoteExecutions.get(options.idempotentUuid),
        jobUuidList: ['job-1'],
      };
    },
  };

  const service = createTaskActionService({
    pool,
    scheduleDirectory: {},
    yingdaoClient,
    pollingCoordinator: { trackExecution: async () => {} },
    runRequestsRepository,
    logger: { error() {}, warn() {} },
    uuid: () => '11111111-1111-4111-8111-111111111111',
    now: () => new Date('2026-07-22T03:00:00.000Z'),
  });

  return {
    service,
    startCalls,
    getState: () => state,
    remoteExecutions,
  };
}

test('remote success survives a local finalize rollback and retry does not start twice', async () => {
  const harness = createHarness({ failAuditOnce: true });

  await assert.rejects(
    harness.service.runNow('7', '1'),
    /simulated audit write failure/
  );
  const failedState = harness.getState();
  const pending = [...failedState.requests.values()][0];
  assert.equal(pending.status, 'pending');
  assert.equal(pending.taskUuid, 'remote-1');
  assert.deepEqual(pending.jobUuidList, ['job-1']);
  assert.equal(pending.lastAttemptAt, '2026-07-22T03:00:00.000Z');
  assert.equal(failedState.executions.size, 0);
  assert.equal(failedState.audits.length, 0);

  const retry = await harness.service.runNow('7', '1');
  assert.equal(retry.task_uuid, 'remote-1');
  assert.deepEqual(
    harness.startCalls.map(call => call.idempotentUuid),
    ['11111111-1111-4111-8111-111111111111']
  );
  assert.equal(harness.remoteExecutions.size, 1);

  const completed = harness.getState().requests.get('11111111-1111-4111-8111-111111111111');
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.taskUuid, 'remote-1');
  assert.equal(harness.getState().executions.size, 1);
  assert.equal(harness.getState().audits.length, 1);
});

test('an active execution from an earlier binding does not block the current schedule', async () => {
  const harness = createHarness({
    initialExecutions: [{
      task_uuid: 'old-binding-active',
      rpa_task_id: '1',
      schedule_uuid_at_run: 'schedule-old',
      normalized_status: '运行中',
      trigger_time: '2026-07-22T00:30:00.000Z',
      updated_time: '2026-07-22T00:45:00.000Z',
      job_uuid_list: ['old-job'],
      idempotent_uuid: null,
    }],
  });

  const result = await harness.service.runNow('7', '1');
  assert.equal(result.task_uuid, 'remote-1');
  assert.equal(harness.startCalls.length, 1);
  assert.equal(harness.startCalls[0].scheduleUuid, 'schedule-1');
});

test('restart recovery reclaims a stale dispatching request with the same UUID', async () => {
  const idempotentUuid = '22222222-2222-4222-8222-222222222222';
  const harness = createHarness({
    taskOverrides: {
      owner_user_id: '99',
      schedule_uuid: 'schedule-rebound',
      deleted_at: '2026-07-22T02:30:00.000Z',
    },
    initialRequests: [{
      idempotentUuid,
      rpaTaskId: '1',
      scheduleUuidAtRun: 'schedule-1',
      scheduleBoundAtAtRequest: '2026-07-22T01:00:00.000Z',
      requestedByUserId: '7',
      status: 'dispatching',
      taskUuid: null,
      jobUuidList: [],
      auditLogId: null,
      attemptCount: 1,
      lastAttemptAt: '2026-07-22T02:00:00.000Z',
      nextAttemptAt: null,
      lastError: null,
      completedAt: null,
      createdAt: '2026-07-22T02:00:00.000Z',
    }],
  });

  const recovered = await harness.service.recoverPendingRuns();
  assert.deepEqual(recovered, { scanned: 1, succeeded: 1, failed: 0 });
  assert.equal(harness.startCalls[0].idempotentUuid, idempotentUuid);
  assert.equal(harness.startCalls[0].scheduleUuid, 'schedule-1');
  assert.equal(harness.getState().requests.get(idempotentUuid).status, 'succeeded');
});

test('restart recovery uses the saved remote task UUID without starting again', async () => {
  const idempotentUuid = '55555555-5555-4555-8555-555555555555';
  const harness = createHarness({
    taskOverrides: {
      owner_user_id: '99',
      schedule_uuid: 'schedule-rebound',
      deleted_at: '2026-07-22T02:30:00.000Z',
    },
    initialRequests: [{
      idempotentUuid,
      rpaTaskId: '1',
      scheduleUuidAtRun: 'schedule-1',
      scheduleBoundAtAtRequest: '2026-07-22T01:00:00.000Z',
      requestedByUserId: '7',
      status: 'pending',
      taskUuid: 'remote-before-restart',
      jobUuidList: ['remote-job'],
      auditLogId: null,
      attemptCount: 1,
      lastAttemptAt: '2026-07-22T02:00:00.000Z',
      nextAttemptAt: '2026-07-22T02:15:00.000Z',
      lastError: 'simulated local finalize failure',
      completedAt: null,
      createdAt: '2026-07-22T02:00:00.000Z',
    }],
  });

  const recovered = await harness.service.recoverPendingRuns();
  assert.deepEqual(recovered, { scanned: 1, succeeded: 1, failed: 0 });
  assert.equal(harness.startCalls.length, 0);
  const request = harness.getState().requests.get(idempotentUuid);
  assert.equal(request.status, 'succeeded');
  assert.equal(request.taskUuid, 'remote-before-restart');
  assert.equal(harness.getState().executions.get('remote-before-restart').idempotent_uuid, idempotentUuid);
});

test('recovery prefers an older active execution with the same idempotency UUID', async () => {
  const idempotentUuid = '66666666-6666-4666-8666-666666666666';
  const harness = createHarness({
    initialRequests: [{
      idempotentUuid,
      rpaTaskId: '1',
      scheduleUuidAtRun: 'schedule-1',
      scheduleBoundAtAtRequest: '2026-07-22T01:00:00.000Z',
      requestedByUserId: '7',
      status: 'dispatching',
      taskUuid: null,
      jobUuidList: [],
      auditLogId: null,
      attemptCount: 1,
      lastAttemptAt: '2026-07-22T02:00:00.000Z',
      nextAttemptAt: null,
      lastError: null,
      completedAt: null,
      createdAt: '2026-07-22T02:00:00.000Z',
    }],
    initialExecutions: [
      {
        task_uuid: 'newer-unrelated-active',
        rpa_task_id: '1',
        schedule_uuid_at_run: 'schedule-1',
        normalized_status: '运行中',
        trigger_time: '2026-07-22T02:40:00.000Z',
        updated_time: '2026-07-22T02:50:00.000Z',
        job_uuid_list: ['unrelated-job'],
        idempotent_uuid: '77777777-7777-4777-8777-777777777777',
      },
      {
        task_uuid: 'matching-active',
        rpa_task_id: '1',
        schedule_uuid_at_run: 'schedule-1',
        normalized_status: '运行中',
        trigger_time: '2026-07-22T02:10:00.000Z',
        updated_time: '2026-07-22T02:20:00.000Z',
        job_uuid_list: ['matching-job'],
        idempotent_uuid: idempotentUuid,
      },
    ],
  });

  const recovered = await harness.service.recoverPendingRuns();
  assert.deepEqual(recovered, { scanned: 1, succeeded: 1, failed: 0 });
  assert.equal(harness.startCalls.length, 0);
  const request = harness.getState().requests.get(idempotentUuid);
  assert.equal(request.status, 'succeeded');
  assert.equal(request.taskUuid, 'matching-active');
  assert.equal(harness.getState().audits.length, 1);
});

test('saved task UUID adopts a synced execution whose idempotency UUID is still null', async () => {
  const idempotentUuid = '88888888-8888-4888-8888-888888888888';
  const harness = createHarness({
    initialRequests: [{
      idempotentUuid,
      rpaTaskId: '1',
      scheduleUuidAtRun: 'schedule-1',
      scheduleBoundAtAtRequest: '2026-07-22T01:00:00.000Z',
      requestedByUserId: '7',
      status: 'pending',
      taskUuid: 'synced-after-crash',
      jobUuidList: ['remote-job'],
      auditLogId: null,
      attemptCount: 1,
      lastAttemptAt: '2026-07-22T02:00:00.000Z',
      nextAttemptAt: '2026-07-22T02:15:00.000Z',
      lastError: 'simulated local finalize failure',
      completedAt: null,
      createdAt: '2026-07-22T02:00:00.000Z',
    }],
    initialExecutions: [{
      task_uuid: 'synced-after-crash',
      rpa_task_id: '1',
      schedule_uuid_at_run: 'schedule-1',
      normalized_status: '运行中',
      trigger_time: '2026-07-22T02:05:00.000Z',
      updated_time: '2026-07-22T02:45:00.000Z',
      job_uuid_list: ['synced-job'],
      idempotent_uuid: null,
      started_by_user_id: null,
    }],
  });

  const recovered = await harness.service.recoverPendingRuns();
  assert.deepEqual(recovered, { scanned: 1, succeeded: 1, failed: 0 });
  assert.equal(harness.startCalls.length, 0);
  const request = harness.getState().requests.get(idempotentUuid);
  assert.equal(request.status, 'succeeded');
  assert.equal(request.taskUuid, 'synced-after-crash');
  const execution = harness.getState().executions.get('synced-after-crash');
  assert.equal(execution.idempotent_uuid, idempotentUuid);
  assert.equal(execution.started_by_user_id, '7');
  assert.deepEqual(execution.job_uuid_list, ['synced-job']);
});

test('a request without task UUID never attaches an unrelated active execution', async () => {
  const idempotentUuid = '33333333-3333-4333-8333-333333333333';
  const harness = createHarness({
    initialRequests: [{
      idempotentUuid,
      rpaTaskId: '1',
      scheduleUuidAtRun: 'schedule-1',
      scheduleBoundAtAtRequest: '2026-07-22T01:00:00.000Z',
      requestedByUserId: '7',
      status: 'dispatching',
      taskUuid: null,
      jobUuidList: [],
      auditLogId: null,
      attemptCount: 1,
      lastAttemptAt: '2026-07-22T02:00:00.000Z',
      nextAttemptAt: null,
      lastError: null,
      completedAt: null,
      createdAt: '2026-07-22T02:00:00.000Z',
    }],
    initialExecutions: [{
      task_uuid: 'unrelated-active',
      rpa_task_id: '1',
      schedule_uuid_at_run: 'schedule-1',
      normalized_status: '运行中',
      trigger_time: '2026-07-22T02:30:00.000Z',
      updated_time: '2026-07-22T02:40:00.000Z',
      job_uuid_list: ['unrelated-job'],
      idempotent_uuid: '44444444-4444-4444-8444-444444444444',
    }],
  });

  const recovered = await harness.service.recoverPendingRuns();
  assert.deepEqual(recovered, { scanned: 1, succeeded: 0, failed: 1 });
  assert.equal(harness.startCalls.length, 0);
  const request = harness.getState().requests.get(idempotentUuid);
  assert.equal(request.status, 'pending');
  assert.equal(request.taskUuid, null);
  assert.equal(harness.getState().audits.length, 0);
});

test('a never-dispatched request is rejected if delete, transfer, or rebind wins before claim', async () => {
  const changes = [
    task => { task.deleted_at = '2026-07-22T02:30:00.000Z'; },
    task => { task.owner_user_id = '99'; },
    task => { task.schedule_uuid = 'schedule-rebound'; },
    task => { task.schedule_bound_at = '2026-07-22T02:30:00.000Z'; },
  ];

  for (const mutateTaskAfterPrepare of changes) {
    const harness = createHarness({ mutateTaskAfterPrepare });
    await assert.rejects(
      harness.service.runNow('7', '1'),
      error => error && error.code === 'RUN_REQUEST_CONTEXT_CHANGED'
    );
    assert.equal(harness.startCalls.length, 0);
    assert.equal([...harness.getState().requests.values()][0].status, 'rejected');
  }
});

test('an explicit upstream 4xx rejection closes the request instead of retrying it forever', async () => {
  const rejection = new Error('schedule rejected');
  rejection.status = 400;
  const harness = createHarness({ startError: rejection });

  await assert.rejects(harness.service.runNow('7', '1'), /schedule rejected/);
  const request = [...harness.getState().requests.values()][0];
  assert.equal(request.status, 'rejected');
  assert.equal(request.nextAttemptAt, null);
  assert.ok(request.completedAt);
});
