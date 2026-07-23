const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArguments, backfillLegacyTask } = require('../storage/backfillLegacyTask.cjs');

function fakePool(responses) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      const response = responses.shift();
      return response || { rows: [] };
    },
    release() {},
  };
  return {
    calls,
    connect: async () => client,
    query: (sql, params) => client.query(sql, params),
  };
}

test('历史任务补齐参数要求精确 ID 和带时区的绑定时间', () => {
  assert.deepEqual(parseArguments([
    '--task-id', '41',
    '--owner-user-id', '7',
    '--schedule-uuid', 'schedule-1',
    '--bound-at', '2026-07-22T12:00:00+08:00',
  ], {}), {
    taskId: '41',
    ownerUserId: '7',
    actorUserId: '7',
    scheduleUuid: 'schedule-1',
    boundAt: new Date('2026-07-22T04:00:00.000Z'),
  });
  assert.throws(() => parseArguments([
    '--task-id', '41', '--owner-user-id', '7', '--schedule-uuid', 'schedule-1',
    '--bound-at', '2026-07-22 12:00:00',
  ], {}), /UTC 偏移/);
});

test('历史任务所有者、绑定区间和审计在同一事务补齐', async () => {
  const boundAt = new Date('2026-07-22T04:00:00.000Z');
  const pool = fakePool([
    { rows: [{
      id: '41', owner_user_id: null, schedule_uuid: null, schedule_bound_at: null,
      deleted_at: null, version: 1,
    }] },
    { rows: [{ id: '7' }] },
    { rows: [] },
    { rows: [] },
    { rows: [{
      id: '41', owner_user_id: '7', schedule_uuid: 'schedule-1',
      schedule_bound_at: boundAt, version: 2,
    }] },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);

  const result = await backfillLegacyTask(pool, {
    taskId: '41', ownerUserId: '7', actorUserId: '7',
    scheduleUuid: 'schedule-1', boundAt,
  });
  assert.deepEqual(result, {
    taskId: '41', ownerUserId: '7', scheduleUuid: 'schedule-1',
    scheduleBoundAt: '2026-07-22T04:00:00.000Z',
    version: 2, changed: true, historyInserted: true,
  });
  assert.equal(pool.calls[0].sql, 'BEGIN');
  assert.match(pool.calls[5].sql, /UPDATE public\.rpa_tasks/);
  assert.match(pool.calls[6].sql, /rpa_task_binding_history/);
  assert.match(pool.calls[7].sql, /rpa_task_audit_log/);
  assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});

test('历史回填使用数据库精度识别活动绑定时间不一致', async () => {
  const boundAt = new Date('2026-07-22T04:00:00.123Z');
  const pool = fakePool([
    { rows: [{
      id: '41', owner_user_id: '7', schedule_uuid: 'schedule-1',
      schedule_bound_at: boundAt, deleted_at: null, version: 2,
    }] },
    { rows: [{ id: '7' }] },
    { rows: [] },
    { rows: [{
      id: '5', schedule_uuid: 'schedule-1', bound_at: boundAt,
      matches_task_bound_at: false,
    }] },
  ]);

  await assert.rejects(
    backfillLegacyTask(pool, {
      taskId: '41', ownerUserId: '7', actorUserId: '7',
      scheduleUuid: 'schedule-1', boundAt,
    }),
    /schedule_bound_at 与活动绑定历史不一致/
  );
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});
