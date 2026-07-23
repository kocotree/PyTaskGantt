const test = require('node:test');
const assert = require('node:assert/strict');

const { createTasksRepository } = require('../server/db/tasksRepository.cjs');
const { createExecutionsRepository } = require('../server/db/executionsRepository.cjs');
const { createUsersRepository } = require('../server/db/usersRepository.cjs');
const { createAuditRepository } = require('../server/db/auditRepository.cjs');
const { createRunRequestsRepository } = require('../server/db/runRequestsRepository.cjs');
const { parseBatch } = require('../server/services/taskValidation.cjs');

function queueDb(responses) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response || { rows: [], rowCount: 0 };
    },
  };
}

test('task update is owner/version guarded and returns string ids', async () => {
  const db = queueDb([{ rows: [{
    id: '9007199254740993', task: '已更新', start_time: '09:00:00',
    finish_time: '10:00:00', bot: 'Bot', owner_user_id: '2', version: 4,
    tags: [], note: '', created_at: new Date(), updated_at: new Date(),
  }] }]);
  const repository = createTasksRepository(db);
  const result = await repository.updateOwnedTask({
    id: '9007199254740993',
    ownerUserId: '2',
    version: 3,
    changes: { task: '已更新', tags: [' A ', 'A'] },
  });

  assert.equal(result.id, '9007199254740993');
  assert.equal(result.version, 4);
  assert.match(db.calls[0].sql, /owner_user_id = \$2/);
  assert.match(db.calls[0].sql, /version = \$3/);
  assert.match(db.calls[0].sql, /schedule_uuid IS NOT NULL/);
  assert.match(db.calls[0].sql, /version = version \+ 1/);
  assert.deepEqual(db.calls[0].params.at(-1), ['A']);
});

test('task list summaries are scoped to the current schedule binding', async () => {
  const db = queueDb([{ rows: [] }]);
  const repository = createTasksRepository(db);
  await repository.listAll('5');
  assert.match(db.calls[0].sql, /execution\.schedule_uuid_at_run = task\.schedule_uuid/);
  assert.match(db.calls[0].sql, /execution\.trigger_time >= task\.schedule_bound_at/);
  assert.match(db.calls[0].sql, /task\.schedule_uuid IS NOT NULL[\s\S]*THEN TRUE ELSE FALSE END AS can_edit/);
  assert.deepEqual(db.calls[0].params, ['5', false]);
});

test('管理员任务列表把全部正常有效任务标记为可编辑', async () => {
  const db = queueDb([{ rows: [] }]);
  const repository = createTasksRepository(db);
  await repository.listAll('5', { currentUserIsAdmin: true });
  assert.match(db.calls[0].sql, /owner_user_id = \$1::bigint OR \$2::boolean = TRUE/);
  assert.match(db.calls[0].sql, /owner_user_id IS NOT NULL/);
  assert.deepEqual(db.calls[0].params, ['5', true]);
});

test('new task and its initial binding interval are inserted in one transaction', async () => {
  const client = queueDb([
    { rows: [] },
    { rows: [{
      id: '41', task: '新任务', start_time: '09:00:00', finish_time: '09:30:00',
      bot: 'Bot', created_by_user_id: '5', owner_user_id: '5',
      schedule_uuid: 'schedule-1', schedule_bound_at: new Date('2026-07-22T02:00:00Z'),
      tags: [], note: '', version: 1, created_at: new Date(), updated_at: new Date(),
    }] },
    { rows: [], rowCount: 1 },
    { rows: [] },
  ]);
  client.release = () => { client.released = true; };
  const pool = { query: client.query.bind(client), connect: async () => client };
  const repository = createTasksRepository(pool);
  const result = await repository.createTask({
    currentUserId: '5',
    task: '新任务', start: '09:00:00', finish: '09:30:00', bot: 'Bot',
    scheduleUuid: 'schedule-1', scheduleBoundAt: new Date('2026-07-22T02:00:00Z'),
  });
  assert.equal(result.id, '41');
  assert.equal(client.calls[0].sql, 'BEGIN');
  assert.match(client.calls[2].sql, /rpa_task_binding_history/);
  assert.equal(client.calls[3].sql, 'COMMIT');
  assert.equal(client.released, true);
});

test('sync state updates require the latest binding-scoped generation and keep timestamps monotonic', async () => {
  const boundAt = new Date('2026-07-22T02:00:00Z');
  const db = queueDb([
    { rows: [{
      id: '41', schedule_uuid: 'schedule-1', schedule_bound_at: boundAt, sync_generation: '7',
    }] },
    { rows: [{
      id: '41', task: '任务', start_time: '09:00:00', finish_time: '09:30:00', bot: 'Bot',
      owner_user_id: '5', schedule_uuid: 'schedule-1', schedule_bound_at: boundAt,
      tags: [], note: '', version: 1, last_synced_at: new Date('2026-07-22T04:00:00Z'),
      sync_error: null, created_at: new Date(), updated_at: new Date(),
    }] },
  ]);
  const repository = createTasksRepository(db);
  const attempt = await repository.beginSyncAttempt({
    taskId: '41', scheduleUuid: 'schedule-1', scheduleBoundAt: boundAt.toISOString(),
  });
  const result = await repository.updateSyncState({
    ...attempt,
    lastSyncedAt: '2026-07-22T04:00:00.000Z',
    syncError: null,
  });

  assert.equal(attempt.syncGeneration, '7');
  assert.equal(result.id, '41');
  assert.match(db.calls[0].sql, /sync_generation = sync_generation \+ 1/);
  assert.match(db.calls[0].sql, /date_trunc\('milliseconds', schedule_bound_at\)[\s\S]*IS NOT DISTINCT FROM \$3::timestamptz/);
  assert.match(db.calls[1].sql, /GREATEST\(COALESCE\(last_synced_at/);
  assert.match(db.calls[1].sql, /sync_generation = \$6::bigint/);
  assert.deepEqual(db.calls[1].params.slice(0, 3), [
    '41', 'schedule-1', '2026-07-22T02:00:00.000Z',
  ]);
});

test('execution upsert is idempotent by task_uuid and uses Chinese normalized status', async () => {
  const db = queueDb([{ rows: [{
    task_uuid: 'exec-1', rpa_task_id: '41', schedule_uuid_at_run: 'schedule-1',
    normalized_status: '等待中', trigger_time: new Date('2026-07-22T02:00:00Z'),
    job_uuid_list: [], synced_at: new Date('2026-07-22T02:00:01Z'),
  }] }]);
  const repository = createExecutionsRepository(db);
  const result = await repository.upsertExecution({
    taskUuid: 'exec-1', rpaTaskId: '41', scheduleUuidAtRun: 'schedule-1',
    normalizedStatus: '等待中', triggerTime: '2026-07-22T02:00:00Z',
  });
  assert.equal(result.normalizedStatus, '等待中');
  assert.match(db.calls[0].sql, /ON CONFLICT \(task_uuid\) DO UPDATE/);
  assert.match(db.calls[0].sql, /jsonb_array_length\(EXCLUDED\.job_uuid_list\) = 0/);
  assert.match(db.calls[0].sql, /THEN public\.rpa_task_executions\.clients/);
  assert.doesNotMatch(db.calls[0].sql, /SET\s+rpa_task_id\s*=/);
  assert.match(db.calls[0].sql, /rpa_task_executions\.rpa_task_id = EXCLUDED\.rpa_task_id/);
  assert.match(db.calls[0].sql, /schedule_uuid_at_run = EXCLUDED\.schedule_uuid_at_run/);
  assert.equal(db.calls[0].params[3], '等待中');
});

test('execution upsert refuses to move an existing task_uuid to another binding', async () => {
  const repository = createExecutionsRepository(queueDb([{ rows: [] }]));
  await assert.rejects(repository.upsertExecution({
    taskUuid: 'exec-conflict',
    rpaTaskId: '42',
    scheduleUuidAtRun: 'schedule-other',
    normalizedStatus: '运行成功',
    triggerTime: '2026-07-22T02:00:00Z',
  }), error => error && error.code === 'EXECUTION_BINDING_CONFLICT');
});

test('run request recovery includes stale dispatching leases and reclaims the same UUID', async () => {
  const idempotentUuid = '11111111-1111-4111-8111-111111111111';
  const db = queueDb([
    { rows: [{
      idempotent_uuid: idempotentUuid,
      rpa_task_id: '41',
      schedule_uuid_at_run: 'schedule-1',
      requested_by_user_id: '5',
      status: 'dispatching',
      job_uuid_list: [],
      attempt_count: 1,
      last_attempt_at: new Date('2026-07-22T01:00:00Z'),
      created_at: new Date('2026-07-22T01:00:00Z'),
      updated_at: new Date('2026-07-22T01:00:00Z'),
    }] },
    { rows: [{
      idempotent_uuid: idempotentUuid,
      rpa_task_id: '41',
      schedule_uuid_at_run: 'schedule-1',
      requested_by_user_id: '5',
      status: 'dispatching',
      job_uuid_list: [],
      attempt_count: 2,
      last_attempt_at: new Date('2026-07-22T02:00:00Z'),
      created_at: new Date('2026-07-22T01:00:00Z'),
      updated_at: new Date('2026-07-22T02:00:00Z'),
    }] },
  ]);
  const repository = createRunRequestsRepository(db);
  const due = await repository.listPendingDue({
    now: new Date('2026-07-22T02:00:00Z'),
    dispatchLeaseMs: 60_000,
  });
  assert.equal(due[0].idempotentUuid, idempotentUuid);
  assert.match(db.calls[0].sql, /status = 'dispatching'/);
  assert.match(db.calls[0].sql, /INTERVAL '1 millisecond'/);

  const reclaimed = await repository.markDispatching(
    idempotentUuid,
    new Date('2026-07-22T02:00:00Z')
  );
  assert.equal(reclaimed.idempotentUuid, idempotentUuid);
  assert.match(db.calls[1].sql, /status IN \('pending', 'dispatching'\)/);
});

test('execution repository resolves persisted job ownership and returns pagination metadata', async () => {
  const executionRow = {
    task_uuid: 'exec-2', rpa_task_id: '41', schedule_uuid_at_run: 'schedule-1',
    normalized_status: '运行成功', trigger_time: new Date('2026-07-22T02:00:00Z'),
    job_uuid_list: ['job-1'], synced_at: new Date('2026-07-22T02:00:01Z'),
  };
  const db = queueDb([
    { rows: [executionRow] },
    { rows: [{ total: '3' }] },
    { rows: [executionRow, { ...executionRow, task_uuid: 'exec-1' }] },
    { rows: [{ ...executionRow, job_uuid_list: ['job-1', 'job-2'] }] },
  ]);
  const repository = createExecutionsRepository(db);

  const owned = await repository.findByJobUuid('job-1');
  assert.equal(owned.taskUuid, 'exec-2');
  assert.match(db.calls[0].sql, /job_uuid_list \? \$1/);
  assert.deepEqual(db.calls[0].params, ['job-1']);

  const page = await repository.listForTaskPage('41', { limit: 2, offset: 0 });
  assert.equal(page.executions.length, 2);
  assert.deepEqual(page.pagination, { limit: 2, offset: 0, total: 3, hasMore: true });
  assert.match(db.calls[1].sql, /COUNT\(\*\)::bigint/);
  assert.match(db.calls[2].sql, /LIMIT \$2 OFFSET \$3/);

  const merged = await repository.mergeJobUuids('exec-2', ['job-1', 'job-2', 'job-2']);
  assert.deepEqual(merged.jobUuidList, ['job-1', 'job-2']);
  assert.match(db.calls[3].sql, /jsonb_array_elements_text/);
  assert.deepEqual(db.calls[3].params, ['exec-2', ['job-1', 'job-2']]);
});

test('user aliases and audit action validation match route contracts', async () => {
  const devUserRow = {
    id: '8', display_name: '用户 A', auth_provider: 'dev', is_active: true,
    created_at: new Date(), updated_at: new Date(),
  };
  const usersDb = queueDb([{ rows: [devUserRow] }, { rows: [devUserRow] }]);
  const users = createUsersRepository(usersDb);
  assert.equal((await users.findActiveById('8')).id, '8');
  assert.match(usersDb.calls[0].sql, /is_active = TRUE/);
  assert.equal((await users.findActiveDevById('8')).authProvider, 'dev');
  assert.match(usersDb.calls[1].sql, /auth_provider = 'dev'/);

  const audit = createAuditRepository(queueDb([]));
  await assert.rejects(
    () => audit.append({ taskId: '1', actorUserId: '8', action: 'unsafe' }),
    /Unsupported audit action/
  );
});

test('Feishu user repository binds stable identity without changing an existing dev provider', async () => {
  const row = {
    id: '8', display_name: '用户 A', avatar_url: 'https://example.invalid/avatar.png',
    auth_provider: 'dev', feishu_open_id: 'ou_8', feishu_union_id: 'on_8',
    feishu_tenant_key: 'tenant-1', is_active: true,
    created_at: new Date(), updated_at: new Date(), last_login_at: new Date(),
  };
  const db = queueDb([{ rows: [row] }, { rows: [row] }, { rows: [row] }]);
  const users = createUsersRepository(db);

  const found = await users.findByFeishuIdentity({
    openId: 'ou_8', unionId: 'on_8', tenantKey: 'tenant-1',
  });
  assert.equal(found.id, '8');
  assert.deepEqual(db.calls[0].params, ['on_8', 'tenant-1', 'ou_8']);

  await users.lockActiveById('8');
  assert.match(db.calls[1].sql, /FOR UPDATE/);

  const updated = await users.updateFeishuProfile('8', {
    displayName: '用户 A', avatarUrl: row.avatar_url,
    openId: 'ou_8', unionId: 'on_8', tenantKey: 'tenant-1',
  });
  assert.equal(updated.authProvider, 'dev');
  assert.doesNotMatch(db.calls[2].sql, /auth_provider\s*=/);
});

test('batch mutation ids reject zero, unsafe numbers, and values outside PostgreSQL BIGINT', () => {
  const body = id => ({ mutations: [{ type: 'delete', id, version: 1 }] });
  for (const id of ['0', 'abc', '9223372036854775808', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseBatch(body(id)), /任务变更数据不正确/);
  }
  assert.equal(parseBatch(body('9223372036854775807')).mutations[0].id, '9223372036854775807');
});
