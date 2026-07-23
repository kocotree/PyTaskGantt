const request = require('supertest');
const session = require('express-session');
const { createApp } = require('../server/app.cjs');
const { AuthorizationError, databaseError } = require('../server/errors.cjs');

function buildApp(overrides = {}) {
  const users = [
    { id: '1', display_name: '用户甲', avatar_url: null, auth_provider: 'dev', is_admin: true },
    { id: '2', display_name: '用户乙', avatar_url: null, auth_provider: 'dev', is_admin: false },
    { id: '3', display_name: '飞书用户', avatar_url: null, auth_provider: 'feishu', is_admin: false },
  ];
  const repositories = {
    healthCheck: async () => true,
    users: {
      listActive: async () => users,
      listActiveDevUsers: async () => users.filter(user => user.auth_provider === 'dev'),
      findActiveById: async id => users.find(user => user.id === String(id)) || null,
      findActiveDevById: async id => users.find(user =>
        user.id === String(id) && user.auth_provider === 'dev'
      ) || null,
      touchLastLogin: async () => {},
    },
    tasks: {
      listAll: async userId => [{ id: '10', task: '测试任务', can_edit: userId === '1' }],
      listMine: async userId => userId === '1' ? [{ id: '10', task: '测试任务' }] : [],
      listExecutions: async () => [],
      listExecutionsPage: async (_taskId, pagination) => ({
        executions: [],
        pagination: { ...pagination, total: 0, hasMore: false },
      }),
    },
    ...overrides.repositories,
  };
  const services = {
    taskMutation: {
      applyBatch: async actor => {
        if (actor.userId !== '1') throw new AuthorizationError('只能修改自己的任务');
        return { success: true, tasks: [], id_map: {} };
      },
    },
    taskActions: {
      rebind: async () => ({}),
      transfer: async () => ({}),
      recover: async () => ({}),
      runNow: async () => ({}),
    },
    syncCoordinator: {
      syncTask: async () => ({ started: true }),
      syncUser: async () => ({ started: true }),
    },
    scheduleDirectory: { list: async () => ({ schedules: [], page: 1, size: 20, total: 0 }) },
    executionDetails: {
      getJobs: async () => [],
      getLogs: async (_jobUuid, pagination) => ({
        logs: [],
        pagination: { ...pagination, total: 0, hasMore: false },
        cache: {},
      }),
    },
    ...overrides.services,
  };
  return createApp({
    config: {
      authMode: 'dev',
      feishuEnabled: false,
      feishuAppBaseUrl: 'http://localhost:5174',
      feishuStateTtlSeconds: 600,
      corsOrigins: ['http://localhost:5174'],
      sessionSecret: 'test-secret-test-secret-test-secret',
      sessionMaxAgeSeconds: 3600,
      secureCookies: false,
      schemaVersion: 7,
      uiRefreshSeconds: 10,
      ...overrides.config,
    },
    pool: {},
    repositories,
    services,
    sessionStore: new session.MemoryStore(),
    logger: { error() {} },
  });
}

describe('Express 会话与权限边界', () => {
  it('生产代理下的会话 Cookie 启用 HttpOnly、Secure 和 SameSite=Lax', async () => {
    const response = await request(buildApp({
      config: { secureCookies: true, trustProxy: 1 },
    }))
      .post('/api/auth/dev/switch')
      .set('X-Forwarded-Proto', 'https')
      .send({ user_id: '1' })
      .expect(200);
    const cookie = response.headers['set-cookie'] && response.headers['set-cookie'][0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('只允许匿名访问健康检查和登录相关接口', async () => {
    const app = buildApp();
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/auth/session').expect(200, {
      authenticated: false,
      user: null,
      auth_mode: 'dev',
      feishu_enabled: false,
      ui_refresh_seconds: 10,
    });
    await request(app).get('/api/auth/dev/users').expect(200);
    const response = await request(app).get('/api/tasks').expect(401);
    expect(response.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('开发切换后会话可读取全员任务和个人任务', async () => {
    const agent = request.agent(buildApp());
    await agent.post('/api/auth/dev/switch').send({ user_id: '1' }).expect(200);
    const sessionResponse = await agent.get('/api/auth/session').expect(200);
    expect(sessionResponse.body.user.display_name).toBe('用户甲');
    expect(sessionResponse.body.user.is_admin).toBe(true);
    const all = await agent.get('/api/tasks').expect(200);
    expect(all.body.tasks[0].can_edit).toBe(true);
    const mine = await agent.get('/api/my/tasks').expect(200);
    expect(mine.body.tasks).toHaveLength(1);
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/tasks').expect(401);
  });

  it('每次请求从数据库刷新管理员状态并把可信 actor 传给管理员接口', async () => {
    const actors = [];
    const app = buildApp({
      services: {
        taskActions: {
          rebind: async () => ({}),
          transfer: async () => ({}),
          runNow: async () => ({}),
          recover: async actor => {
            actors.push(actor);
            return { success: true, task: { id: '10', task: '已恢复' } };
          },
        },
      },
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/dev/switch').send({ user_id: '1' }).expect(200);
    await agent.post('/api/admin/tasks/10/recover').send({
      owner_user_id: '2', schedule_uuid: 'schedule-recover', version: 1,
    }).expect(200);
    expect(actors).toEqual([{ userId: '1', isAdmin: true }]);
  });

  it('撤销管理员或停用用户后，现有 session 从下一次 API 请求立即生效', async () => {
    const user = {
      id: '1', display_name: '用户甲', auth_provider: 'dev',
      is_active: true, is_admin: true,
    };
    const actors = [];
    const app = buildApp({
      repositories: {
        users: {
          listActive: async () => user.is_active ? [user] : [],
          listActiveDevUsers: async () => user.is_active ? [user] : [],
          findActiveById: async id => user.is_active && String(id) === user.id ? { ...user } : null,
          findActiveDevById: async id => user.is_active && String(id) === user.id ? { ...user } : null,
          touchLastLogin: async () => {},
        },
      },
      services: {
        taskMutation: {
          applyBatch: async actor => {
            actors.push(actor);
            return { success: true, tasks: [], id_map: {} };
          },
        },
      },
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/dev/switch').send({ user_id: '1' }).expect(200);
    await agent.post('/api/tasks/batch').send({ mutations: [] }).expect(200);
    user.is_admin = false;
    await agent.post('/api/tasks/batch').send({ mutations: [] }).expect(200);
    expect(actors).toEqual([
      { userId: '1', isAdmin: true },
      { userId: '1', isAdmin: false },
    ]);
    user.is_active = false;
    await agent.get('/api/tasks').expect(401);
  });

  it('导入只为当前用户新增任务，任意登录用户可导出全部可见任务元数据', async () => {
    let imported = null;
    const app = buildApp({
      repositories: {
        tasks: {
          listAll: async userId => {
            expect(userId).toBe('2');
            return [{
              id: '99',
              task: '全员可见任务',
              start: '08:00:00',
              finish: '09:00:00',
              bot: '机器人A',
              owner: { id: '1', display_name: '用户甲', auth_provider: 'dev' },
              scheduleUuid: 'schedule-export',
              tags: ['日报'],
              note: '导出备注',
              executions: [{ task_uuid: 'must-not-export' }],
            }];
          },
        },
      },
      services: {
        taskMutation: {
          applyBatch: async (userId, body) => {
            imported = { userId, body };
            return { success: true, tasks: [], id_map: { 'import:0': '100' } };
          },
        },
      },
    });

    await request(app).post('/api/import').send({ format: 'json', content: '[]' }).expect(401);
    const agent = request.agent(app);
    await agent.post('/api/auth/dev/switch').send({ user_id: '2' }).expect(200);
    await agent.post('/api/import').send({
      format: 'json',
      content: JSON.stringify([{
        Task: '导入任务', Start: '09:00:00', Finish: '10:00:00', Bot: '机器人B',
        ScheduleUuid: 'schedule-import', Tags: ['财务'], Note: '仅新增',
        owner_user_id: '1', created_by_user_id: '1', type: 'update',
      }]),
    }).expect(200);
    expect(imported).toEqual({
      userId: { userId: '2', isAdmin: false },
      body: {
        audit_action: 'import',
        mutations: [{
          type: 'create',
          temp_id: 'import:0',
          task: '导入任务',
          start: '09:00:00',
          finish: '10:00:00',
          bot: '机器人B',
          schedule_uuid: 'schedule-import',
          tags: ['财务'],
          note: '仅新增',
        }],
      },
    });

    const exported = await agent.get('/api/export/json').expect(200);
    expect(exported.headers['content-disposition']).toMatch(/tasks_\d{4}-\d{2}-\d{2}\.json/);
    expect(exported.body).toEqual([{
      Task: '全员可见任务',
      Start: '08:00:00',
      Finish: '09:00:00',
      Bot: '机器人A',
      Owner: '用户甲',
      ScheduleUuid: 'schedule-export',
      Tags: '日报',
      Note: '导出备注',
    }]);
    expect(JSON.stringify(exported.body)).not.toContain('must-not-export');
  });

  it('后端拒绝越权保存，且拒绝不在白名单中的写请求来源', async () => {
    const agent = request.agent(buildApp());
    await agent.post('/api/auth/dev/switch').send({ user_id: '2' }).expect(200);
    const forbidden = await agent
      .post('/api/tasks/batch')
      .set('Origin', 'http://localhost:5174')
      .send({ mutations: [] })
      .expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    const badOrigin = await agent
      .post('/api/tasks/batch')
      .set('Origin', 'https://evil.example')
      .send({ mutations: [] })
      .expect(403);
    expect(badOrigin.body.error.message).toContain('来源');
  });

  it('非 dev 模式不暴露用户切换', async () => {
    const app = buildApp({ config: { authMode: 'feishu' } });
    await request(app).get('/api/auth/dev/users').expect(404);
    await request(app).post('/api/auth/dev/switch').send({ user_id: '1' }).expect(404);
  });

  it('飞书 OAuth 登录校验 state、重建会话并安全跳回站内路径', async () => {
    const completeAuthorization = vi.fn(async ({ code, bindUserId }) => {
      expect(code).toBe('authorization-code');
      expect(bindUserId).toBeNull();
      return {
        id: '3', displayName: '飞书用户', avatarUrl: null,
        authProvider: 'feishu', isActive: true,
        feishuOpenId: 'open-3', feishuTenantKey: 'tenant-1',
      };
    });
    const app = buildApp({
      config: { authMode: 'feishu', feishuEnabled: true },
      services: {
        feishuAuth: {
          createAuthorizationUrl: ({ state }) => `https://accounts.feishu.cn/authorize?state=${state}`,
          completeAuthorization,
        },
      },
    });
    const agent = request.agent(app);
    const start = await agent
      .get('/api/auth/feishu/start?redirect=%2Fmy-tasks')
      .expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);

    const callback = await agent
      .get(`/api/auth/feishu/callback?state=${encodeURIComponent(state)}&code=authorization-code`)
      .expect(303);
    expect(callback.headers.location).toBe('http://localhost:5174/my-tasks');
    expect(completeAuthorization).toHaveBeenCalledOnce();

    const replay = await agent
      .get(`/api/auth/feishu/callback?state=${encodeURIComponent(state)}&code=authorization-code`)
      .expect(303);
    expect(new URL(replay.headers.location).searchParams.get('error')).toContain('状态已失效');
    expect(completeAuthorization).toHaveBeenCalledOnce();

    const sessionResponse = await agent.get('/api/auth/session').expect(200);
    expect(sessionResponse.body).toMatchObject({
      authenticated: true,
      feishu_enabled: true,
      user: { id: '3' },
    });
  });

  it('已登录用户可把飞书身份绑定到当前内部用户，错误 state 不会执行绑定', async () => {
    const completeAuthorization = vi.fn(async ({ bindUserId }) => ({
      id: bindUserId, displayName: '用户甲', authProvider: 'dev', isActive: true,
      feishuOpenId: 'open-1', feishuTenantKey: 'tenant-1',
    }));
    const app = buildApp({
      config: { feishuEnabled: true },
      services: {
        feishuAuth: {
          createAuthorizationUrl: ({ state }) => `https://accounts.feishu.cn/authorize?state=${state}`,
          completeAuthorization,
        },
      },
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/dev/switch').send({ user_id: '1' }).expect(200);
    const start = await agent
      .get('/api/auth/feishu/start?intent=bind&redirect=https%3A%2F%2Fevil.example')
      .expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');

    const invalid = await agent
      .get('/api/auth/feishu/callback?state=wrong&code=ignored')
      .expect(303);
    expect(new URL(invalid.headers.location).searchParams.get('error')).toContain('状态已失效');
    expect(completeAuthorization).not.toHaveBeenCalled();

    const callback = await agent
      .get(`/api/auth/feishu/callback?state=${encodeURIComponent(state)}&code=bind-code`)
      .expect(303);
    expect(callback.headers.location).toBe('http://localhost:5174/schedule');
    expect(completeAuthorization).toHaveBeenCalledWith({ code: 'bind-code', bindUserId: '1' });
  });

  it('开发切换不能伪装成未来的飞书身份', async () => {
    const app = buildApp();
    await request(app).get('/api/auth/dev/users').expect(200).expect(response => {
      expect(response.body.users.map(user => user.id)).toEqual(['1', '2']);
    });
    await request(app).post('/api/auth/dev/switch').send({ user_id: '3' }).expect(400);
  });

  it('所有 task id 路由统一拒绝非数字和越界 BIGINT', async () => {
    const agent = request.agent(buildApp());
    await agent.post('/api/auth/dev/switch').send({ user_id: '1' }).expect(200);
    const invalidPaths = [
      () => agent.post('/api/tasks/not-a-number/rebind').send({ schedule_uuid: 'schedule-1', version: 1 }),
      () => agent.post('/api/tasks/not-a-number/transfer').send({ target_user_id: '2', version: 1 }),
      () => agent.post('/api/tasks/not-a-number/run').send({}),
      () => agent.post('/api/tasks/not-a-number/sync').send({}),
      () => agent.get('/api/tasks/not-a-number/executions'),
      () => agent.delete('/api/tasks/not-a-number').send({ version: 1 }),
      () => agent.get('/api/tasks/9223372036854775808/executions'),
      () => agent.post('/api/tasks/10/transfer').send({ target_user_id: 'abc', version: 1 }),
    ];
    for (const createRequest of invalidPaths) {
      const response = await createRequest().expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(databaseError({ code: '22P02' })).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(databaseError({ code: '22003' })).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('执行历史和日志返回兼容的分页元数据，并保留新旧日志路径', async () => {
    const calls = [];
    const app = buildApp({
      repositories: {
        tasks: {
          listAll: async () => [],
          listMine: async () => [],
          listExecutions: async () => [],
          listExecutionsPage: async (taskId, pagination) => {
            calls.push({ type: 'executions', taskId, pagination });
            return {
              executions: [{ task_uuid: 'exec-1', rpa_task_id: taskId, normalized_status: '运行成功' }],
              pagination: { ...pagination, total: 3, hasMore: true },
            };
          },
        },
      },
      services: {
        executionDetails: {
          getJobs: async () => [],
          getLogs: async (jobUuid, options) => {
            calls.push({ type: 'logs', jobUuid, options });
            return {
              logs: [{ message: 'ok' }],
              pagination: { page: options.page, size: options.size, total: 11, hasMore: true },
              cache: { hit: true, stale: true, ageMs: 2_000 },
            };
          },
        },
      },
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/dev/switch').send({ user_id: '1' }).expect(200);

    const history = await agent.get('/api/tasks/10/executions?limit=1&offset=1').expect(200);
    expect(history.body.pagination).toEqual({ limit: 1, offset: 1, total: 3, has_more: true });
    expect(calls[0]).toMatchObject({ taskId: '10', pagination: { limit: 1, offset: 1 } });

    const preferred = await agent.get('/api/yingdao/jobs/job-1/logs?page=2&size=10').expect(200);
    expect(preferred.body.pagination).toEqual({ page: 2, size: 10, total: 11, has_more: true });
    expect(preferred.body.cached).toBe(true);
    expect(preferred.body.stale).toBe(true);
    expect(calls[1]).toMatchObject({ jobUuid: 'job-1', options: { page: 2, size: 10, currentUserId: '1' } });
    await agent.get('/api/jobs/job-1/logs?page=1&size=10').expect(200);
  });
});
