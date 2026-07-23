const test = require('node:test');
const assert = require('node:assert/strict');

const { createTaskActionService } = require('../server/services/taskActionService.cjs');
const {
  assertOwner,
  createTaskMutationService,
  withAdminAudit,
} = require('../server/services/taskMutationService.cjs');
const { parseArgs } = require('../storage/setAdmin.cjs');

function createRecoveryHarness({
  task = {},
  targetUserActive = true,
  occupied = false,
  scheduleError = null,
  auditError = null,
} = {}) {
  let state = {
    task: {
      id: '10',
      task: '历史任务',
      start_time: '09:00:00',
      finish_time: '10:00:00',
      bot: '机器人A',
      owner_user_id: null,
      created_by_user_id: null,
      schedule_uuid: null,
      schedule_bound_at: null,
      version: 1,
      deleted_at: null,
      tags: [],
      note: '',
      ...task,
    },
    history: [],
    audits: [],
  };
  let connections = 0;
  const pool = {
    async connect() {
      connections += 1;
      const client = {
        tx: null,
        async query(sql, params = []) {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          if (text === 'BEGIN') {
            client.tx = structuredClone(state);
            return { rows: [] };
          }
          if (text === 'COMMIT') {
            state = client.tx;
            client.tx = null;
            return { rows: [] };
          }
          if (text === 'ROLLBACK') {
            client.tx = null;
            return { rows: [] };
          }
          const target = client.tx || state;
          if (text.startsWith('SELECT * FROM rpa_tasks')) {
            return { rows: target.task && !target.task.deleted_at ? [{ ...target.task }] : [] };
          }
          if (text.includes('SELECT id FROM app_users') && text.includes('FOR SHARE')) {
            return { rows: targetUserActive ? [{ id: String(params[0]) }] : [] };
          }
          if (text.startsWith('SELECT id FROM rpa_tasks') && text.includes('schedule_uuid = $1')) {
            return { rows: occupied ? [{ id: '99' }] : [] };
          }
          if (text.startsWith('UPDATE rpa_task_binding_history')) {
            for (const history of target.history) {
              if (history.unbound_at == null) history.unbound_at = params[1];
            }
            return { rows: [] };
          }
          if (text.startsWith('INSERT INTO rpa_task_binding_history')) {
            target.history.push({
              rpa_task_id: String(params[0]),
              schedule_uuid: params[1],
              bound_at: params[2],
              actor_user_id: String(params[3]),
              unbound_at: null,
            });
            return { rows: [{ id: '1' }] };
          }
          if (text.startsWith('UPDATE rpa_tasks')) {
            if (Number(target.task.version) !== Number(params[4])) return { rows: [] };
            Object.assign(target.task, {
              owner_user_id: String(params[1]),
              schedule_uuid: params[2],
              schedule_bound_at: params[3],
              version: Number(target.task.version) + 1,
            });
            return { rows: [{ id: target.task.id }] };
          }
          if (text.startsWith('INSERT INTO rpa_task_audit_log')) {
            if (auditError) throw auditError;
            target.audits.push({
              task_id: String(params[0]),
              actor_user_id: String(params[1]),
              action: params[2],
              old_value: JSON.parse(params[3]),
              new_value: JSON.parse(params[4]),
            });
            return { rows: [{ id: '1' }] };
          }
          if (text.includes('FROM rpa_tasks t')) {
            return {
              rows: [{
                id: target.task.id,
                task: target.task.task,
                start: target.task.start_time,
                finish: target.task.finish_time,
                bot: target.task.bot,
                tags: target.task.tags,
                note: target.task.note,
                owner_user_id: target.task.owner_user_id,
                created_by_user_id: target.task.created_by_user_id,
                schedule_uuid: target.task.schedule_uuid,
                schedule_bound_at: target.task.schedule_bound_at,
                version: target.task.version,
                owner: { id: target.task.owner_user_id, display_name: '目标用户' },
                can_edit: true,
                is_legacy_unbound: false,
              }],
            };
          }
          throw new Error(`Unexpected SQL: ${text}`);
        },
        release() {},
      };
      return client;
    },
  };
  const scheduleChecks = [];
  const service = createTaskActionService({
    pool,
    scheduleDirectory: {
      async assertBindable(scheduleUuid, context) {
        scheduleChecks.push({ scheduleUuid, context });
        if (scheduleError) throw scheduleError;
      },
    },
    yingdaoClient: {},
    runRequestsRepository: {},
    now: () => new Date('2026-07-23T08:00:00.000Z'),
  });
  return {
    service,
    getState: () => state,
    getConnections: () => connections,
    scheduleChecks,
  };
}

test('管理员可管理其他用户的有效任务，但历史未绑定任务仍必须走恢复流程', () => {
  const active = {
    owner_user_id: '8',
    schedule_uuid: 'schedule-1',
    schedule_bound_at: new Date('2026-07-23T01:00:00.000Z'),
  };
  assert.throws(() => assertOwner(active, { userId: '7', isAdmin: false }), /只能修改自己的任务/);
  assert.doesNotThrow(() => assertOwner(active, { userId: '7', isAdmin: true }));
  assert.throws(
    () => assertOwner({ ...active, schedule_uuid: null, schedule_bound_at: null }, { userId: '7', isAdmin: true }),
    /只读/
  );
  assert.deepEqual(withAdminAudit({ note: '已维护' }, { userId: '7', isAdmin: true }, '8'), {
    note: '已维护',
    admin_override: true,
    task_owner_user_id: '8',
  });
});

test('管理员批量更新其他用户任务时保持所有者不变并写入 override 审计', async () => {
  const calls = [];
  const current = {
    id: '10', task: '其他用户任务', start_time: '09:00:00', finish_time: '10:00:00',
    bot: '机器人A', owner_user_id: '8', created_by_user_id: '8',
    schedule_uuid: 'schedule-1', schedule_bound_at: new Date('2026-07-23T01:00:00.000Z'),
    version: 3, deleted_at: null, tags: [], note: '旧备注',
  };
  const responses = [
    { rows: [] },
    { rows: [current] },
    { rows: [{ ...current, note: '管理员维护', version: 4 }] },
    { rows: [{ id: '1' }] },
    { rows: [{
      id: '10', task: current.task, start: current.start_time, finish: current.finish_time,
      bot: current.bot, owner_user_id: '8', created_by_user_id: '8',
      schedule_uuid: current.schedule_uuid, schedule_bound_at: current.schedule_bound_at,
      version: 4, tags: [], note: '管理员维护', can_edit: true, is_legacy_unbound: false,
    }] },
    { rows: [] },
  ];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      return responses.shift() || { rows: [] };
    },
    release() {},
  };
  const service = createTaskMutationService({
    pool: { connect: async () => client },
    scheduleDirectory: {},
  });
  const result = await service.applyBatch({ userId: '7', isAdmin: true }, {
    mutations: [{ type: 'update', id: '10', version: 3, changes: { note: '管理员维护' } }],
  });
  assert.equal(result.tasks[0].owner_user_id, '8');
  const updateCall = calls.find(call => /UPDATE rpa_tasks/.test(call.sql));
  assert.doesNotMatch(updateCall.sql, /owner_user_id\s*=/);
  const auditCall = calls.find(call => /INSERT INTO rpa_task_audit_log/.test(call.sql));
  assert.equal(auditCall.params[1], '7');
  assert.deepEqual(JSON.parse(auditCall.params[4]), {
    note: '管理员维护',
    admin_override: true,
    task_owner_user_id: '8',
  });
});

test('管理员恢复历史任务在单一事务内写入所有者、绑定区间和真实审计身份', async () => {
  const harness = createRecoveryHarness();
  const result = await harness.service.recover(
    { userId: '7', isAdmin: true },
    '10',
    { owner_user_id: '8', schedule_uuid: 'schedule-recovered', version: 1 }
  );
  assert.equal(result.task.owner_user_id, '8');
  assert.equal(result.task.schedule_uuid, 'schedule-recovered');
  assert.equal(result.task.version, 2);
  assert.deepEqual(harness.scheduleChecks, [{
    scheduleUuid: 'schedule-recovered',
    context: { actorUserId: '7', excludeTaskId: '10' },
  }]);
  const state = harness.getState();
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].actor_user_id, '7');
  assert.equal(state.audits[0].action, 'admin_recover');
  assert.equal(state.audits[0].actor_user_id, '7');
  assert.equal(state.audits[0].new_value.admin_override, true);
  assert.equal(state.audits[0].new_value.version, 2);
});

test('普通用户、正常有效任务、无效目标用户和占用计划都不能通过恢复接口改写数据', async () => {
  const nonAdmin = createRecoveryHarness();
  await assert.rejects(
    nonAdmin.service.recover(
      { userId: '7', isAdmin: false },
      '10',
      { owner_user_id: '8', schedule_uuid: 'schedule-2', version: 1 }
    ),
    error => error.code === 'ADMIN_REQUIRED'
  );
  assert.equal(nonAdmin.getConnections(), 0);

  const active = createRecoveryHarness({
    task: {
      owner_user_id: '8',
      schedule_uuid: 'schedule-active',
      schedule_bound_at: '2026-07-23T01:00:00.000Z',
    },
  });
  await assert.rejects(
    active.service.recover(
      { userId: '7', isAdmin: true },
      '10',
      { owner_user_id: '8', schedule_uuid: 'schedule-2', version: 1 }
    ),
    error => error.code === 'TASK_ALREADY_ACTIVE'
  );

  for (const harness of [
    createRecoveryHarness({ targetUserActive: false }),
    createRecoveryHarness({ occupied: true }),
    createRecoveryHarness({ auditError: new Error('审计写入失败') }),
  ]) {
    await assert.rejects(
      harness.service.recover(
        { userId: '7', isAdmin: true },
        '10',
        { owner_user_id: '8', schedule_uuid: 'schedule-2', version: 1 }
      ),
      error => ['NOT_FOUND', 'SCHEDULE_ALREADY_BOUND'].includes(error.code) || /审计写入失败/.test(error.message)
    );
    assert.equal(harness.getState().task.owner_user_id, null);
    assert.equal(harness.getState().history.length, 0);
    assert.equal(harness.getState().audits.length, 0);
  }
});

test('管理员运维命令只接受精确用户 ID 和显式布尔值', () => {
  assert.deepEqual(parseArgs(['--user-id', '9007199254740993', '--enabled', 'true']), {
    userId: '9007199254740993', enabled: true,
  });
  assert.deepEqual(parseArgs(['--enabled', 'false', '--user-id', '7']), {
    userId: '7', enabled: false,
  });
  for (const argv of [
    ['--user-id', 'name', '--enabled', 'true'],
    ['--user-id', '7', '--enabled', '1'],
    ['--user-id', '9223372036854775808', '--enabled', 'false'],
    ['--name', '用户甲', '--enabled', 'true'],
  ]) {
    assert.throws(() => parseArgs(argv));
  }
});
