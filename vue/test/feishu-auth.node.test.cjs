const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFeishuClient,
  createFeishuAuthService,
} = require('../server/services/feishuAuthService.cjs');

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test('Feishu OAuth client builds authorization URL, exchanges code, and reads stable identity', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/open-apis/authen/v2/oauth/token')) {
      return jsonResponse({ code: 0, access_token: 'user-access-token' });
    }
    return jsonResponse({
      code: 0,
      data: {
        name: '张三',
        avatar_url: 'https://example.invalid/avatar.png',
        open_id: 'ou_123',
        union_id: 'on_123',
        tenant_key: 'tenant-1',
      },
    });
  };
  const client = createFeishuClient({
    appId: 'cli_test',
    appSecret: 'app-secret',
    redirectUri: 'https://tasks.example.com/api/auth/feishu/callback',
    authorizationUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    apiBaseUrl: 'https://open.feishu.cn',
    fetchImpl,
  });

  const authorizationUrl = new URL(client.createAuthorizationUrl({ state: 'state-1' }));
  assert.equal(authorizationUrl.searchParams.get('app_id'), 'cli_test');
  assert.equal(authorizationUrl.searchParams.get('state'), 'state-1');
  assert.equal(
    authorizationUrl.searchParams.get('redirect_uri'),
    'https://tasks.example.com/api/auth/feishu/callback'
  );

  const token = await client.exchangeCode('code-1');
  const account = await client.getUserInfo(token);
  assert.equal(token, 'user-access-token');
  assert.deepEqual(account, {
    identity: { openId: 'ou_123', unionId: 'on_123', tenantKey: 'tenant-1' },
    profile: { displayName: '张三', avatarUrl: 'https://example.invalid/avatar.png' },
  });
  const tokenBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(tokenBody, {
    grant_type: 'authorization_code',
    client_id: 'cli_test',
    client_secret: 'app-secret',
    code: 'code-1',
    redirect_uri: 'https://tasks.example.com/api/auth/feishu/callback',
  });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer user-access-token');
});

test('Feishu binding never merges by display name and refuses identities owned by another user', async () => {
  const target = {
    id: '1', displayName: '同名用户', authProvider: 'dev', isActive: true,
    feishuOpenId: null, feishuUnionId: null, feishuTenantKey: null,
  };
  let existing = null;
  const usersRepository = {
    findByFeishuIdentity: async () => existing,
    lockActiveById: async () => target,
    updateFeishuProfile: async (id, data) => ({
      ...target,
      id,
      displayName: data.displayName,
      feishuOpenId: data.openId,
      feishuUnionId: data.unionId,
      feishuTenantKey: data.tenantKey,
    }),
    createFeishuUser: async () => { throw new Error('must not auto-create during binding'); },
  };
  const service = createFeishuAuthService({
    pool: { query: async () => ({ rows: [] }) },
    usersRepository,
    client: {},
  });
  const account = {
    identity: { openId: 'ou_1', unionId: 'on_1', tenantKey: 'tenant-1' },
    profile: { displayName: '同名用户', avatarUrl: null },
  };

  const bound = await service.resolveUser({ ...account, bindUserId: '1' });
  assert.equal(bound.id, '1');
  assert.equal(bound.feishuUnionId, 'on_1');

  existing = { ...target, id: '2', feishuUnionId: 'on_1' };
  await assert.rejects(
    () => service.resolveUser({ ...account, bindUserId: '1' }),
    error => error.code === 'FEISHU_IDENTITY_BOUND'
  );
});

test('Feishu login honors tenant allowlist and auto-provision policy', async () => {
  const account = {
    identity: { openId: 'ou_1', unionId: null, tenantKey: 'tenant-denied' },
    profile: { displayName: '用户', avatarUrl: null },
  };
  const usersRepository = {
    findByFeishuIdentity: async () => null,
    createFeishuUser: async data => ({ id: '9', isActive: true, ...data }),
  };
  const denied = createFeishuAuthService({
    pool: { query: async () => ({ rows: [] }) },
    usersRepository,
    client: {},
    allowedTenantKeys: ['tenant-allowed'],
  });
  await assert.rejects(
    () => denied.resolveUser(account),
    error => error.code === 'FORBIDDEN' && /租户/.test(error.message)
  );

  const noProvision = createFeishuAuthService({
    pool: { query: async () => ({ rows: [] }) },
    usersRepository,
    client: {},
    autoProvision: false,
  });
  await assert.rejects(
    () => noProvision.resolveUser({ ...account, identity: { ...account.identity, tenantKey: 'tenant-allowed' } }),
    error => error.code === 'FORBIDDEN' && /尚未绑定/.test(error.message)
  );
});
