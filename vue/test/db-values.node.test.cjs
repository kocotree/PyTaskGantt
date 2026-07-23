const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toApiId,
  timestampAfter,
  normalizeTags,
  mapTaskRow,
  mapExecutionRow,
  mapRunRequestRow,
} = require('../server/db/values.cjs');
const { presentExecution } = require('../server/presenters.cjs');

test('BIGINT values are exposed as strings and never coerced to Number', () => {
  assert.equal(toApiId(9223372036854775807n), '9223372036854775807');
  assert.equal(toApiId('9007199254740993'), '9007199254740993');
  assert.equal(toApiId(null), null);
});

test('tags are trimmed, empty values removed, and order-preserving duplicates removed', () => {
  assert.deepEqual(normalizeTags([' 月报 ', '', '月报', null, '财务']), ['月报', '财务']);
});

test('timestamps generated after PostgreSQL bindings clear hidden microsecond precision', () => {
  const exposedBinding = new Date('2026-07-22T04:00:00.123Z');
  assert.equal(
    timestampAfter(exposedBinding, new Date('2026-07-22T04:00:00.123Z')).toISOString(),
    '2026-07-22T04:00:00.124Z'
  );
  assert.equal(
    timestampAfter(exposedBinding, new Date('2026-07-22T04:00:00.130Z')).toISOString(),
    '2026-07-22T04:00:00.130Z'
  );
});

test('task and execution row mappers expose stable camelCase API objects', () => {
  const task = mapTaskRow({
    id: '9007199254740993',
    task: '月报',
    start_time: '23:00:00',
    finish_time: '01:00:00',
    bot: 'Bot A',
    owner_user_id: '7',
    tags: ['财务'],
    version: 2,
    can_edit: true,
  });
  assert.equal(task.id, '9007199254740993');
  assert.equal(task.ownerUserId, '7');
  assert.equal(task.canEdit, true);
  assert.equal(task.currentStatus, '待运行');

  const execution = mapExecutionRow({
    task_uuid: 'task-1',
    rpa_task_id: '9007199254740993',
    schedule_uuid_at_run: 'schedule-1',
    normalized_status: '运行中',
    trigger_time: new Date('2026-07-22T01:00:00.000Z'),
    job_uuid_list: ['job-1'],
  });
  assert.equal(execution.rpaTaskId, '9007199254740993');
  assert.equal(execution.triggerTime, '2026-07-22T01:00:00.000Z');
  assert.deepEqual(execution.jobUuidList, ['job-1']);

  const runRequest = mapRunRequestRow({
    idempotent_uuid: '11111111-1111-4111-8111-111111111111',
    rpa_task_id: '9007199254740993',
    schedule_uuid_at_run: 'schedule-1',
    schedule_bound_at_at_request: new Date('2026-07-22T00:30:00.000Z'),
    requested_by_user_id: '7',
    status: 'dispatching',
    job_uuid_list: [],
    attempt_count: 2,
    last_attempt_at: new Date('2026-07-22T01:01:00.000Z'),
  });
  assert.equal(runRequest.rpaTaskId, '9007199254740993');
  assert.equal(runRequest.status, 'dispatching');
  assert.equal(runRequest.scheduleBoundAtAtRequest, '2026-07-22T00:30:00.000Z');
  assert.equal(runRequest.attemptCount, 2);
});

test('execution presenter applies a final credential redaction boundary', () => {
  const output = presentExecution({
    taskUuid: 'task-1',
    rpaTaskId: '1',
    normalizedStatus: '运行失败',
    rawStatusName: 'Authorization: Bearer unsafe-token',
    errorRemark: 'accessToken=unsafe-token',
    clients: [{ accessKeySecret: 'unsafe-secret' }],
  });
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes('unsafe-token'), false);
  assert.equal(serialized.includes('unsafe-secret'), false);
  assert.match(serialized, /REDACTED/);
});
