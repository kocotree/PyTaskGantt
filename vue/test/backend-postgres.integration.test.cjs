const request = require('supertest');
const { createPool } = require('../server/db/pool.cjs');
const { initializeRepositories } = require('../server/db/index.cjs');
const { createTaskMutationService } = require('../server/services/taskMutationService.cjs');
const { createTaskActionService } = require('../server/services/taskActionService.cjs');
const { createApp } = require('../server/app.cjs');
const { ConflictError, NotFoundError } = require('../server/errors.cjs');
const { backfillLegacyTask } = require('../storage/backfillLegacyTask.cjs');
const { importLegacyTasks } = require('../storage/importLegacyTasks.cjs');

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('PostgreSQL 真实事务与权限集成', () => {
  let pool;
  let repositories;
  let app;
  let executionCounter = 0;

  beforeAll(async () => {
    pool = createPool({ database: { url: databaseUrl } });
    ({ repositories } = await initializeRepositories(pool));
    const scheduleDirectory = {
      async assertBindable(scheduleUuid, context = {}) {
        if (!String(scheduleUuid).startsWith('schedule-')) throw new NotFoundError('影刀计划不存在');
        const binding = await repositories.tasks.isScheduleBound(scheduleUuid, {
          excludeTaskId: context.excludeTaskId || context.taskId,
        });
        if (binding) throw new ConflictError('SCHEDULE_ALREADY_BOUND', '该影刀计划已被其他任务绑定');
        return { schedule: { scheduleUuid } };
      },
      async list() {
        return { schedules: [], page: 1, size: 20, total: 0 };
      },
    };
    const yingdaoClient = {
      async startTask() {
        executionCounter += 1;
        return { taskUuid: `execution-${executionCounter}`, jobUuidList: [`job-${executionCounter}`] };
      },
    };
    const syncCoordinator = {
      async syncTask() { return { started: true }; },
      async syncUser() { return { started: true }; },
      trackExecution() { return Promise.resolve(); },
    };
    const services = {
      taskMutation: createTaskMutationService({ pool, scheduleDirectory }),
      taskActions: createTaskActionService({
        pool,
        scheduleDirectory,
        yingdaoClient,
        pollingCoordinator: syncCoordinator,
        syncCoordinator,
        runRequestsRepository: repositories.runRequests,
        logger: { error() {}, warn() {} },
      }),
      syncCoordinator,
      scheduleDirectory,
      executionDetails: { async getJobs() { return []; }, async getLogs() { return []; } },
    };
    app = createApp({
      config: {
        authMode: 'dev',
        corsOrigins: ['http://localhost:5174'],
        sessionSecret: 'postgres-integration-session-secret',
        sessionMaxAgeSeconds: 3600,
        sessionCookieName: 'pytaskgantt.test.sid',
        sessionTableName: 'app_sessions',
        secureCookies: false,
        schemaVersion: 6,
      },
      pool,
      repositories,
      services,
      logger: { error() {} },
    });
  });

  beforeEach(async () => {
    executionCounter = 0;
    await pool.query(`
      TRUNCATE TABLE
        app_sessions,
        rpa_task_audit_log,
        rpa_task_run_requests,
        rpa_task_executions,
        rpa_task_binding_history,
        rpa_tasks,
        app_users
      RESTART IDENTITY CASCADE
    `);
    await pool.query(
      `INSERT INTO app_users (display_name, auth_provider)
       VALUES ('用户甲', 'dev'), ('用户乙', 'dev')`
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function login(userId) {
    const agent = request.agent(app);
    await agent.post('/api/auth/dev/switch').send({ user_id: String(userId) }).expect(200);
    return agent;
  }

  async function createTask(agent, scheduleUuid, tempId = `tmp:${scheduleUuid}`) {
    const response = await agent.post('/api/tasks/batch').send({
      mutations: [{
        type: 'create',
        temp_id: tempId,
        task: `任务 ${scheduleUuid}`,
        start: '09:00:00',
        finish: '10:00:00',
        bot: '机器人A',
        schedule_uuid: scheduleUuid,
        tags: ['日报', ' 日报 ', '财务'],
        note: '集成测试',
      }],
    }).expect(200);
    return response.body.tasks[0];
  }

  it('会话、唯一绑定、越权与整批回滚均由后端和数据库保证', async () => {
    await request(app).get('/api/tasks').expect(401);
    const userA = await login(1);
    const userB = await login(2);
    const taskA = await createTask(userA, 'schedule-1');
    expect(taskA.owner.display_name).toBe('用户甲');
    expect(taskA.owner_user_id).toBe('1');
    expect(taskA.created_by_user_id).toBe('1');
    expect(taskA.tags).toEqual(['日报', '财务']);

    const duplicate = await userB.post('/api/tasks/batch').send({
      mutations: [{
        type: 'create', temp_id: 'tmp:duplicate', task: '重复绑定',
        start: '10:00:00', finish: '11:00:00', bot: '机器人B',
        schedule_uuid: 'schedule-1', tags: [], note: '',
      }],
    }).expect(409);
    expect(duplicate.body.error.code).toBe('SCHEDULE_ALREADY_BOUND');

    const taskB = await createTask(userB, 'schedule-2');
    const rollback = await userA.post('/api/tasks/batch').send({
      mutations: [
        {
          type: 'create', temp_id: 'tmp:rolled-back', task: '不应落库',
          start: '11:00:00', finish: '12:00:00', bot: '机器人A',
          schedule_uuid: 'schedule-3', tags: [], note: '',
        },
        { type: 'update', id: taskB.id, version: taskB.version, changes: { note: '越权' } },
      ],
    }).expect(403);
    expect(rollback.body.error.code).toBe('FORBIDDEN');
    const rolledBack = await pool.query(`SELECT id FROM rpa_tasks WHERE schedule_uuid = 'schedule-3'`);
    expect(rolledBack.rowCount).toBe(0);
  });

  it('并发绑定同一 scheduleUuid 时数据库只允许一个请求成功', async () => {
    const userA = await login(1);
    const userB = await login(2);
    const mutation = owner => ({
      mutations: [{
        type: 'create', temp_id: `tmp:concurrent-${owner}`, task: `并发任务 ${owner}`,
        start: '09:00:00', finish: '10:00:00', bot: '机器人',
        schedule_uuid: 'schedule-concurrent', tags: [], note: '',
      }],
    });
    const [left, right] = await Promise.all([
      userA.post('/api/tasks/batch').send(mutation('A')),
      userB.post('/api/tasks/batch').send(mutation('B')),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const rows = await pool.query(
      `SELECT id FROM rpa_tasks
        WHERE schedule_uuid = 'schedule-concurrent' AND deleted_at IS NULL`
    );
    expect(rows.rowCount).toBe(1);
  });

  it('新任务与初始绑定历史复用数据库中的精确绑定时间', async () => {
    const userA = await login(1);
    const task = await createTask(userA, 'schedule-exact-bound-at');
    const { rows } = await pool.query(
      `SELECT task.schedule_bound_at,
              history.bound_at,
              task.schedule_bound_at IS NOT DISTINCT FROM history.bound_at AS exact_match
         FROM rpa_tasks task
         JOIN rpa_task_binding_history history
           ON history.rpa_task_id = task.id
          AND history.unbound_at IS NULL
        WHERE task.id = $1`,
      [task.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].exact_match).toBe(true);
  });

  it('历史部分绑定回填保留数据库微秒精度并补齐活动历史和审计', async () => {
    const inserted = await pool.query(
      `INSERT INTO rpa_tasks (
         task, start_time, finish_time, bot,
         created_by_user_id, owner_user_id, schedule_uuid, schedule_bound_at
       ) VALUES (
         '历史部分绑定', '09:00:00', '10:00:00', '机器人A',
         1, 1, 'schedule-backfill-exact', TIMESTAMPTZ '2026-07-22 04:00:00.123456+00'
       )
       RETURNING id`
    );
    const taskId = String(inserted.rows[0].id);
    const result = await backfillLegacyTask(pool, {
      taskId,
      ownerUserId: '1',
      actorUserId: '1',
      scheduleUuid: 'schedule-backfill-exact',
      boundAt: null,
    });
    expect(result).toMatchObject({
      taskId,
      changed: false,
      historyInserted: true,
    });

    const { rows } = await pool.query(
      `SELECT task.schedule_bound_at IS NOT DISTINCT FROM history.bound_at AS exact_match,
              audit.action
         FROM rpa_tasks task
         JOIN rpa_task_binding_history history
           ON history.rpa_task_id = task.id AND history.unbound_at IS NULL
         JOIN rpa_task_audit_log audit
           ON audit.task_id = task.id AND audit.action = 'import'
        WHERE task.id = $1`,
      [taskId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ exact_match: true, action: 'import' });

    const attempt = await repositories.tasks.beginSyncAttempt({
      taskId,
      scheduleUuid: 'schedule-backfill-exact',
      scheduleBoundAt: result.scheduleBoundAt,
    });
    expect(attempt).toBeTruthy();
    const syncState = await repositories.tasks.updateSyncState({
      ...attempt,
      lastSyncedAt: '2026-07-22T06:00:00.000Z',
      syncError: null,
    });
    expect(syncState.lastSyncedAt).toBe('2026-07-22T06:00:00.000Z');
  });

  it('旧任务迁移保留显式 ID、保持只读，并推进序列避免后续创建冲突', async () => {
    const imported = await importLegacyTasks(pool, [
      { id: '9001', task: '历史任务 A', start: '08:00:00', finish: '09:00:00', bot: '旧机器人' },
      { id: null, task: '历史任务 B', start: '09:00:00', finish: '10:00:00', bot: '旧机器人' },
    ]);
    expect(imported).toEqual({ total: 2, inserted: 2, skipped: 0 });

    const userA = await login(1);
    const all = await userA.get('/api/tasks').expect(200);
    expect(all.body.tasks).toHaveLength(2);
    expect(all.body.tasks.every(task => (
      task.owner === null
      && task.schedule_uuid === null
      && task.can_edit === false
      && task.is_legacy_unbound === true
    ))).toBe(true);
    expect(all.body.tasks.find(task => task.id === '9001')?.task).toBe('历史任务 A');
    expect((await userA.get('/api/my/tasks').expect(200)).body.tasks).toHaveLength(0);

    const created = await createTask(userA, 'schedule-after-legacy-import', 'tmp:after-legacy');
    expect(BigInt(created.id)).toBeGreaterThan(9001n);
  });

  it('微秒绑定边界下换绑、立即执行和删除时间不会倒退', async () => {
    const insertBoundTask = async (task, scheduleUuid, boundAt) => {
      const inserted = await pool.query(
        `INSERT INTO rpa_tasks (
           task, start_time, finish_time, bot,
           created_by_user_id, owner_user_id, schedule_uuid, schedule_bound_at
         ) VALUES ($1, '09:00:00', '10:00:00', '机器人A', 1, 1, $2, $3::timestamptz)
         RETURNING id`,
        [task, scheduleUuid, boundAt]
      );
      await pool.query(
        `INSERT INTO rpa_task_binding_history (rpa_task_id, schedule_uuid, bound_at, actor_user_id)
         SELECT id, schedule_uuid, schedule_bound_at, owner_user_id
           FROM rpa_tasks WHERE id = $1`,
        [inserted.rows[0].id]
      );
      return String(inserted.rows[0].id);
    };

    const taskId = await insertBoundTask(
      '微秒换绑任务', 'schedule-micro-old', '2026-07-22T04:00:00.123456Z'
    );
    const deterministicActions = createTaskActionService({
      pool,
      scheduleDirectory: { async assertBindable() {} },
      yingdaoClient: {
        async startTask() {
          return { taskUuid: 'microsecond-boundary-run', jobUuidList: [] };
        },
      },
      pollingCoordinator: { trackExecution() { return Promise.resolve(); } },
      syncCoordinator: { syncTask() { return Promise.resolve(); } },
      runRequestsRepository: repositories.runRequests,
      uuid: () => '11111111-1111-4111-8111-111111111111',
      now: () => new Date('2026-07-22T04:00:00.123Z'),
      logger: { error() {}, warn() {} },
    });

    const rebound = await deterministicActions.rebind('1', taskId, {
      schedule_uuid: 'schedule-micro-new',
      version: 1,
    });
    expect(rebound.task.schedule_bound_at.toISOString()).toBe('2026-07-22T04:00:00.124Z');
    await deterministicActions.runNow('1', taskId);
    const execution = await pool.query(
      `SELECT execution.trigger_time >= task.schedule_bound_at AS after_binding
         FROM rpa_task_executions execution
         JOIN rpa_tasks task ON task.id = execution.rpa_task_id
        WHERE execution.task_uuid = 'microsecond-boundary-run'`
    );
    expect(execution.rows[0].after_binding).toBe(true);

    const deleteTaskId = await insertBoundTask(
      '微秒删除任务', 'schedule-micro-delete', '2099-01-01T00:00:00.123456Z'
    );
    const userA = await login(1);
    await userA.post('/api/tasks/batch').send({
      mutations: [{ type: 'delete', id: deleteTaskId, version: 1 }],
    }).expect(200);
    const deleted = await pool.query(
      `SELECT task.deleted_at,
              history.unbound_at,
              history.unbound_at >= history.bound_at AS valid_interval,
              task.deleted_at IS NOT DISTINCT FROM history.unbound_at AS exact_match
         FROM rpa_tasks task
         JOIN rpa_task_binding_history history ON history.rpa_task_id = task.id
        WHERE task.id = $1`,
      [deleteTaskId]
    );
    expect(deleted.rows[0]).toMatchObject({ valid_interval: true, exact_match: true });
  });

  it('真实版本冲突会让同批新增与更新全部回滚', async () => {
    const userA = await login(1);
    const first = await createTask(userA, 'schedule-version-a');
    await createTask(userA, 'schedule-version-b');
    await userA.post('/api/tasks/batch').send({
      mutations: [{
        type: 'update', id: first.id, version: first.version,
        changes: { note: '先到达的更新' },
      }],
    }).expect(200);

    const stale = await userA.post('/api/tasks/batch').send({
      mutations: [
        {
          type: 'create', temp_id: 'tmp:must-rollback', task: '不应创建',
          start: '11:00:00', finish: '12:00:00', bot: '机器人',
          schedule_uuid: 'schedule-version-rollback', tags: [], note: '',
        },
        {
          type: 'update', id: first.id, version: first.version,
          changes: { note: '过期版本' },
        },
      ],
    }).expect(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const rolledBack = await pool.query(
      `SELECT id FROM rpa_tasks WHERE schedule_uuid = 'schedule-version-rollback'`
    );
    expect(rolledBack.rowCount).toBe(0);
  });

  it('转交、换绑、立即执行、软删除和历史保留形成完整事务链', async () => {
    const userA = await login(1);
    const userB = await login(2);
    let task = await createTask(userA, 'schedule-10');

    const transfer = await userA.post(`/api/tasks/${task.id}/transfer`).send({
      target_user_id: '2', version: task.version,
    }).expect(200);
    expect(transfer.body.task.can_edit).toBe(false);
    expect(transfer.body.task.owner_user_id).toBe('2');
    expect(transfer.body.task.created_by_user_id).toBe('1');
    const transferredVersion = transfer.body.task.version;
    await userA.post('/api/tasks/batch').send({
      mutations: [{
        type: 'update', id: task.id, version: transferredVersion,
        changes: { note: '旧所有者不得继续修改' },
      }],
    }).expect(403);
    await userA.delete(`/api/tasks/${task.id}`).send({ version: transferredVersion }).expect(403);
    await userA.post(`/api/tasks/${task.id}/rebind`).send({
      schedule_uuid: 'schedule-old-owner-rebind', version: transferredVersion,
    }).expect(403);
    await userA.post(`/api/tasks/${task.id}/transfer`).send({
      target_user_id: '2', version: transferredVersion,
    }).expect(403);
    await userA.post(`/api/tasks/${task.id}/run`).send({}).expect(403);
    task = (await userB.get('/api/my/tasks').expect(200)).body.tasks[0];
    expect(task.owner.display_name).toBe('用户乙');

    const rebind = await userB.post(`/api/tasks/${task.id}/rebind`).send({
      schedule_uuid: 'schedule-11', version: task.version,
    }).expect(200);
    task = rebind.body.task;
    expect(task.schedule_uuid).toBe('schedule-11');
    expect(task.owner_user_id).toBe('2');
    expect(task.created_by_user_id).toBe('1');

    const run = await userB.post(`/api/tasks/${task.id}/run`).send({}).expect(202);
    expect(run.body.normalized_status).toBe('等待中');
    await userB.post(`/api/tasks/${task.id}/run`).send({}).expect(409);

    const deletion = await userB.post('/api/tasks/batch').send({
      mutations: [{ type: 'delete', id: task.id, version: task.version }],
    }).expect(200);
    expect(deletion.body.deleted).toBe(1);
    expect((await userB.get('/api/my/tasks').expect(200)).body.tasks).toHaveLength(0);

    const executionRows = await pool.query(
      'SELECT task_uuid FROM rpa_task_executions WHERE rpa_task_id = $1',
      [task.id]
    );
    expect(executionRows.rowCount).toBe(1);
    const history = await pool.query(
      'SELECT schedule_uuid, unbound_at FROM rpa_task_binding_history WHERE rpa_task_id = $1 ORDER BY bound_at',
      [task.id]
    );
    expect(history.rows.map(row => row.schedule_uuid)).toEqual(['schedule-10', 'schedule-11']);
    expect(history.rows.every(row => row.unbound_at)).toBe(true);

    const rebound = await createTask(userA, 'schedule-11', 'tmp:released');
    expect(rebound.schedule_uuid).toBe('schedule-11');
    const audit = await pool.query(
      'SELECT action FROM rpa_task_audit_log WHERE task_id = $1 ORDER BY created_at',
      [task.id]
    );
    expect(audit.rows.map(row => row.action)).toEqual(['create', 'transfer', 'rebind', 'run_now', 'delete']);
  });

  it('影刀已受理但本地完成事务回滚时，重试复用远端 task UUID 且不再次启动', async () => {
    const userA = await login(1);
    const task = await createTask(userA, 'schedule-crash-recovery');
    const constraintName = 'test_reject_run_now_audit';

    await pool.query(
      `ALTER TABLE rpa_task_audit_log
         ADD CONSTRAINT ${constraintName} CHECK (action <> 'run_now')`
    );
    try {
      await userA.post(`/api/tasks/${task.id}/run`).send({}).expect(500);
    } finally {
      await pool.query(
        `ALTER TABLE rpa_task_audit_log DROP CONSTRAINT IF EXISTS ${constraintName}`
      );
    }

    const accepted = await pool.query(
      `SELECT status, task_uuid, job_uuid_list, attempt_count
         FROM rpa_task_run_requests
        WHERE rpa_task_id = $1`,
      [task.id]
    );
    expect(accepted.rows[0]).toMatchObject({
      status: 'pending',
      task_uuid: 'execution-1',
      job_uuid_list: ['job-1'],
      attempt_count: 1,
    });
    expect(executionCounter).toBe(1);
    expect((await pool.query(
      'SELECT task_uuid FROM rpa_task_executions WHERE rpa_task_id = $1',
      [task.id]
    )).rowCount).toBe(0);

    const retried = await userA.post(`/api/tasks/${task.id}/run`).send({}).expect(202);
    expect(retried.body.task_uuid).toBe('execution-1');
    expect(executionCounter).toBe(1);

    const completed = await pool.query(
      `SELECT status, task_uuid, attempt_count, audit_log_id
         FROM rpa_task_run_requests
        WHERE rpa_task_id = $1`,
      [task.id]
    );
    expect(completed.rows[0]).toMatchObject({
      status: 'succeeded',
      task_uuid: 'execution-1',
      attempt_count: 2,
    });
    expect(completed.rows[0].audit_log_id).toBeTruthy();
    expect((await pool.query(
      'SELECT task_uuid FROM rpa_task_executions WHERE rpa_task_id = $1',
      [task.id]
    )).rows).toEqual([{ task_uuid: 'execution-1' }]);
  });

  it('换绑后当前状态重置，旧绑定活动实例不阻止新计划立即执行', async () => {
    const userA = await login(1);
    let task = await createTask(userA, 'schedule-old-binding');
    const executionTime = new Date(Date.parse(task.schedule_bound_at) + 1).toISOString();
    await repositories.executions.upsertExecution({
      taskUuid: 'old-binding-active',
      rpaTaskId: task.id,
      scheduleUuidAtRun: 'schedule-old-binding',
      normalizedStatus: '运行中',
      rawStatus: 'running',
      triggerTime: executionTime,
      updatedTime: executionTime,
      jobUuidList: ['old-job'],
      clients: [],
      syncedAt: executionTime,
    });
    const before = await userA.get('/api/my/tasks').expect(200);
    expect(before.body.tasks[0].normalized_status).toBe('运行中');

    const rebound = await userA.post(`/api/tasks/${task.id}/rebind`).send({
      schedule_uuid: 'schedule-new-binding', version: task.version,
    }).expect(200);
    task = rebound.body.task;
    expect(task.normalized_status).toBe('待运行');
    const run = await userA.post(`/api/tasks/${task.id}/run`).send({}).expect(202);
    expect(run.body.normalized_status).toBe('等待中');
  });

  it('单批 120 个任务可原子写入并由全员页和个人页完整读取', async () => {
    const userA = await login(1);
    const mutations = Array.from({ length: 120 }, (_, index) => ({
      type: 'create',
      temp_id: `tmp:bulk-${index}`,
      task: `批量任务 ${String(index + 1).padStart(3, '0')}`,
      start: '08:00:00',
      finish: '08:30:00',
      bot: `机器人${index % 10}`,
      schedule_uuid: `schedule-bulk-${index}`,
      tags: [`分组${index % 5}`],
      note: '',
    }));
    const saved = await userA.post('/api/tasks/batch').send({ mutations }).expect(200);
    expect(saved.body.inserted).toBe(120);
    expect(Object.keys(saved.body.id_map)).toHaveLength(120);
    expect(saved.body.tasks.every(task => typeof task.id === 'string')).toBe(true);

    const all = await userA.get('/api/tasks').expect(200);
    const mine = await userA.get('/api/my/tasks').expect(200);
    expect(all.body.tasks).toHaveLength(120);
    expect(mine.body.tasks).toHaveLength(120);
  });

  it('10 个开发用户并发创建 120 个任务时个人页严格隔离且全员页完整可见', async () => {
    await pool.query(
      `INSERT INTO app_users (display_name, auth_provider)
       SELECT '开发用户' || LPAD(sequence::text, 2, '0'), 'dev'
         FROM generate_series(3, 10) AS sequence`
    );
    const { rows: users } = await pool.query(
      `SELECT id::text AS id, display_name
         FROM app_users
        ORDER BY app_users.id`
    );
    expect(users).toHaveLength(10);

    const agents = await Promise.all(users.map(user => login(user.id)));
    const tasksPerUser = 12;
    const totalTasks = users.length * tasksPerUser;
    const writes = await Promise.all(agents.map((agent, userIndex) => {
      const mutations = Array.from({ length: tasksPerUser }, (_, taskIndex) => ({
        type: 'create',
        temp_id: `tmp:multi-user-${userIndex}-${taskIndex}`,
        task: `用户 ${userIndex + 1} 的任务 ${taskIndex + 1}`,
        start: `${String(8 + (taskIndex % 10)).padStart(2, '0')}:00:00`,
        finish: `${String(8 + (taskIndex % 10)).padStart(2, '0')}:30:00`,
        bot: `机器人${userIndex + 1}`,
        schedule_uuid: `schedule-multi-user-${userIndex}-${taskIndex}`,
        tags: [`用户组${userIndex + 1}`],
        note: '多用户并发集成测试',
      }));
      return agent.post('/api/tasks/batch').send({ mutations }).expect(200);
    }));

    writes.forEach((response, userIndex) => {
      const ownerUserId = users[userIndex].id;
      expect(response.body.inserted).toBe(tasksPerUser);
      expect(Object.keys(response.body.id_map)).toHaveLength(tasksPerUser);
      expect(response.body.tasks).toHaveLength(tasksPerUser);
      expect(response.body.tasks.every(task => (
        task.owner_user_id === ownerUserId
        && task.created_by_user_id === ownerUserId
        && task.can_edit === true
      ))).toBe(true);
    });

    const [allResponses, mineResponses] = await Promise.all([
      Promise.all(agents.map(agent => agent.get('/api/tasks').expect(200))),
      Promise.all(agents.map(agent => agent.get('/api/my/tasks').expect(200))),
    ]);
    const canonicalAllIds = allResponses[0].body.tasks.map(task => task.id).sort();
    const combinedMineIds = new Set();

    allResponses.forEach((response, userIndex) => {
      const currentUserId = users[userIndex].id;
      const tasks = response.body.tasks;
      expect(tasks).toHaveLength(totalTasks);
      expect(tasks.map(task => task.id).sort()).toEqual(canonicalAllIds);
      expect(tasks.filter(task => task.can_edit)).toHaveLength(tasksPerUser);
      expect(tasks.every(task => task.can_edit === (task.owner_user_id === currentUserId))).toBe(true);
    });
    expect(new Set(canonicalAllIds).size).toBe(totalTasks);

    mineResponses.forEach((response, userIndex) => {
      const currentUserId = users[userIndex].id;
      const tasks = response.body.tasks;
      expect(tasks).toHaveLength(tasksPerUser);
      expect(tasks.every(task => (
        task.owner_user_id === currentUserId
        && task.created_by_user_id === currentUserId
        && task.can_edit === true
      ))).toBe(true);
      tasks.forEach(task => {
        expect(combinedMineIds.has(task.id)).toBe(false);
        combinedMineIds.add(task.id);
      });
    });
    expect(combinedMineIds.size).toBe(totalTasks);
    expect([...combinedMineIds].sort()).toEqual(canonicalAllIds);

    const { rows: ownerCounts } = await pool.query(
      `SELECT owner_user_id::text AS owner_user_id, COUNT(*)::int AS task_count
         FROM rpa_tasks
        WHERE deleted_at IS NULL
        GROUP BY owner_user_id
        ORDER BY rpa_tasks.owner_user_id`
    );
    expect(ownerCounts).toEqual(users.map(user => ({
      owner_user_id: user.id,
      task_count: tasksPerUser,
    })));
  });

  it('稀疏同步不会擦除立即执行已保存的 Job 与客户端元数据', async () => {
    const userA = await login(1);
    const task = await createTask(userA, 'schedule-metadata');
    const base = {
      taskUuid: 'metadata-execution',
      rpaTaskId: task.id,
      scheduleUuidAtRun: 'schedule-metadata',
      normalizedStatus: '运行中',
      rawStatus: 'running',
      triggerTime: '2026-07-22T04:00:00.000Z',
      updatedTime: '2026-07-22T04:01:00.000Z',
      jobUuidList: ['job-kept'],
      clients: [{ robotClientUuid: 'client-kept', robotClientName: '客户端 A' }],
      syncedAt: '2026-07-22T04:01:00.000Z',
    };
    await repositories.executions.upsertExecution(base);
    await repositories.executions.upsertExecution({
      ...base,
      normalizedStatus: '运行成功',
      rawStatus: 'finish',
      updatedTime: '2026-07-22T04:02:00.000Z',
      endTime: '2026-07-22T04:02:00.000Z',
      jobUuidList: [],
      clients: [],
      syncedAt: '2026-07-22T04:02:00.000Z',
    });
    const saved = await repositories.executions.findByTaskUuid('metadata-execution');
    expect(saved.jobUuidList).toEqual(['job-kept']);
    expect(saved.clients).toEqual([{ robotClientUuid: 'client-kept', robotClientName: '客户端 A' }]);
    expect(saved.normalizedStatus).toBe('运行成功');
  });

  it('执行记录过期清理不会删除或破坏已完成的立即执行请求关联', async () => {
    const userA = await login(1);
    const task = await createTask(userA, 'schedule-retention');
    const run = await userA.post(`/api/tasks/${task.id}/run`).send({}).expect(202);

    await pool.query(
      `UPDATE rpa_task_executions
          SET normalized_status = '运行成功',
              trigger_time = NOW() - INTERVAL '31 days',
              end_time = NOW() - INTERVAL '31 days'
        WHERE task_uuid = $1`,
      [run.body.task_uuid]
    );
    await repositories.executions.upsertExecution({
      taskUuid: 'recent-retained',
      rpaTaskId: task.id,
      scheduleUuidAtRun: 'schedule-retention',
      normalizedStatus: '运行成功',
      rawStatus: 'finish',
      triggerTime: new Date().toISOString(),
      updatedTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      jobUuidList: [],
      clients: [],
      syncedAt: new Date().toISOString(),
    });
    expect(await repositories.executions.deleteExpired(30)).toBe(1);

    const execution = await pool.query(
      'SELECT task_uuid FROM rpa_task_executions WHERE task_uuid = $1',
      [run.body.task_uuid]
    );
    expect(execution.rowCount).toBe(0);
    expect(await repositories.executions.findByTaskUuid('recent-retained')).toBeTruthy();
    const requestRow = await pool.query(
      `SELECT status, task_uuid, audit_log_id
         FROM rpa_task_run_requests
        WHERE idempotent_uuid = (
          SELECT (new_value ->> 'idempotent_uuid')::uuid
            FROM rpa_task_audit_log
           WHERE task_id = $1 AND action = 'run_now'
           ORDER BY created_at DESC
           LIMIT 1
        )`,
      [task.id]
    );
    expect(requestRow.rows[0]).toMatchObject({
      status: 'succeeded',
      task_uuid: run.body.task_uuid,
    });
    expect(requestRow.rows[0].audit_log_id).toBeTruthy();
  });
});
