const test = require('node:test');
const assert = require('node:assert/strict');

const { assertOwner } = require('../server/services/taskMutationService.cjs');
const { TASK_SELECT } = require('../server/services/taskQueries.cjs');
const { createTaskActionService } = require('../server/services/taskActionService.cjs');

test('已设置 owner 但尚未完整绑定的历史任务仍然只读', () => {
  assert.throws(
    () => assertOwner({ owner_user_id: '7', schedule_uuid: null, schedule_bound_at: null }, '7'),
    error => error.status === 403 && /只读/.test(error.message)
  );
  assert.doesNotThrow(() => assertOwner({
    owner_user_id: '7',
    schedule_uuid: 'schedule-1',
    schedule_bound_at: new Date('2026-07-22T04:00:00.000Z'),
  }, '7'));
});

test('service task summary ignores executions from earlier bindings', () => {
  assert.match(TASK_SELECT, /e\.schedule_uuid_at_run = t\.schedule_uuid/);
  assert.match(TASK_SELECT, /e\.trigger_time >= t\.schedule_bound_at/);
});

test('非所有者换绑在查询影刀计划前即被拒绝', async () => {
  let scheduleChecks = 0;
  let connections = 0;
  const service = createTaskActionService({
    pool: {
      async query() {
        return {
          rows: [{
            id: '1',
            owner_user_id: '8',
            schedule_uuid: 'schedule-1',
            schedule_bound_at: new Date('2026-07-22T04:00:00.000Z'),
            version: 3,
            deleted_at: null,
          }],
        };
      },
      async connect() {
        connections += 1;
        throw new Error('不应开启写事务');
      },
    },
    scheduleDirectory: {
      async assertBindable() { scheduleChecks += 1; },
    },
    yingdaoClient: {},
  });

  await assert.rejects(
    service.rebind('7', '1', { schedule_uuid: 'schedule-2', version: 3 }),
    error => error && error.status === 403
  );
  assert.equal(scheduleChecks, 0);
  assert.equal(connections, 0);
});
