const { AppError, AuthorizationError, ConflictError, ValidationError } = require('../errors.cjs');
const { withTransaction } = require('../db/repositoryUtils.cjs');

class FeishuUpstreamError extends AppError {
  constructor(message = '飞书授权服务暂时不可用，请稍后重试', details) {
    super(502, 'FEISHU_UPSTREAM_ERROR', message, details);
  }
}

function payloadData(payload) {
  return payload && typeof payload.data === 'object' && payload.data ? payload.data : payload;
}

function assertFeishuSuccess(payload) {
  if (!payload || typeof payload !== 'object') throw new FeishuUpstreamError();
  if (payload.code != null && Number(payload.code) !== 0) {
    throw new FeishuUpstreamError('飞书授权失败，请重试', { upstream_code: String(payload.code) });
  }
  return payloadData(payload);
}

function createFeishuClient({
  appId,
  appSecret,
  redirectUri,
  authorizationUrl,
  apiBaseUrl,
  timeoutMs = 10000,
  fetchImpl = globalThis.fetch,
}) {
  if (!appId || !appSecret || !redirectUri) throw new TypeError('Feishu OAuth credentials are required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');

  function createAuthorizationUrl({ state }) {
    const url = new URL(authorizationUrl);
    url.searchParams.set('app_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async function requestJson(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new FeishuUpstreamError('飞书授权请求超时，请重试');
      }
      throw new FeishuUpstreamError();
    } finally {
      clearTimeout(timer);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new FeishuUpstreamError();
    }
    if (!response.ok) throw new FeishuUpstreamError('飞书授权失败，请重试');
    return assertFeishuSuccess(payload);
  }

  async function exchangeCode(code) {
    const data = await requestJson(`${apiBaseUrl}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: appId,
        client_secret: appSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!data.access_token) throw new FeishuUpstreamError();
    return String(data.access_token);
  }

  async function getUserInfo(accessToken) {
    const data = await requestJson(`${apiBaseUrl}/open-apis/authen/v1/user_info`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const openId = data.open_id && String(data.open_id);
    const tenantKey = data.tenant_key && String(data.tenant_key);
    if (!openId || !tenantKey) throw new FeishuUpstreamError('飞书账号缺少可绑定的身份信息');
    return {
      identity: {
        openId,
        unionId: data.union_id ? String(data.union_id) : null,
        tenantKey,
      },
      profile: {
        displayName: String(data.name || data.en_name || '飞书用户').trim() || '飞书用户',
        avatarUrl: data.avatar_url || data.avatar_big || data.avatar_middle || null,
      },
    };
  }

  return Object.freeze({ createAuthorizationUrl, exchangeCode, getUserInfo });
}

function sameFeishuIdentity(user, identity) {
  if (user.feishuUnionId && identity.unionId && user.feishuUnionId === identity.unionId) return true;
  return Boolean(
    user.feishuTenantKey && user.feishuOpenId &&
    user.feishuTenantKey === identity.tenantKey && user.feishuOpenId === identity.openId
  );
}

function hasFeishuIdentity(user) {
  return Boolean(user && (user.feishuUnionId || (user.feishuTenantKey && user.feishuOpenId)));
}

function createFeishuAuthService({
  pool,
  usersRepository,
  client,
  autoProvision = true,
  allowedTenantKeys = [],
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
  if (!usersRepository) throw new TypeError('usersRepository is required');
  if (!client) throw new TypeError('Feishu client is required');
  const allowedTenants = new Set(allowedTenantKeys.map(String));

  function checkTenant(identity) {
    if (allowedTenants.size > 0 && !allowedTenants.has(identity.tenantKey)) {
      throw new AuthorizationError('当前飞书租户未获准访问此系统');
    }
  }

  async function resolveUser({ identity, profile, bindUserId = null }) {
    checkTenant(identity);
    try {
      return await withTransaction(pool, async executor => {
        const existing = await usersRepository.findByFeishuIdentity(identity, { executor });

        if (bindUserId) {
          const target = usersRepository.lockActiveById
            ? await usersRepository.lockActiveById(bindUserId, { executor })
            : await usersRepository.findActiveById(bindUserId, { executor });
          if (!target) throw new AuthorizationError('待绑定用户不存在或已停用');
          if (existing && String(existing.id) !== String(target.id)) {
            throw new ConflictError('FEISHU_IDENTITY_BOUND', '该飞书账号已绑定其他用户');
          }
          if (hasFeishuIdentity(target) && !sameFeishuIdentity(target, identity)) {
            throw new ConflictError('FEISHU_USER_ALREADY_BOUND', '当前用户已绑定其他飞书账号');
          }
          return usersRepository.updateFeishuProfile(target.id, {
            ...profile,
            ...identity,
            lastLoginAt: new Date(),
          }, { executor });
        }

        if (existing) {
          if (!existing.isActive) throw new AuthorizationError('当前用户已停用');
          return usersRepository.updateFeishuProfile(existing.id, {
            ...profile,
            ...identity,
            lastLoginAt: new Date(),
          }, { executor });
        }
        if (!autoProvision) {
          throw new AuthorizationError('飞书账号尚未绑定，请联系管理员完成绑定');
        }
        const created = await usersRepository.createFeishuUser({
          ...profile,
          ...identity,
          lastLoginAt: new Date(),
        }, { executor });
        if (created) return created;
        const raced = await usersRepository.findByFeishuIdentity(identity, { executor });
        if (!raced || !raced.isActive) throw new ConflictError('FEISHU_IDENTITY_CONFLICT', '飞书账号绑定发生冲突，请重试');
        return usersRepository.updateFeishuProfile(raced.id, {
          ...profile,
          ...identity,
          lastLoginAt: new Date(),
        }, { executor });
      });
    } catch (error) {
      if (error && error.code === '23505') {
        throw new ConflictError('FEISHU_IDENTITY_BOUND', '该飞书账号已绑定其他用户');
      }
      throw error;
    }
  }

  async function completeAuthorization({ code, bindUserId = null }) {
    if (!code || typeof code !== 'string') throw new ValidationError('飞书授权码无效');
    const accessToken = await client.exchangeCode(code);
    const account = await client.getUserInfo(accessToken);
    return resolveUser({ ...account, bindUserId });
  }

  return Object.freeze({
    createAuthorizationUrl: client.createAuthorizationUrl,
    completeAuthorization,
    resolveUser,
  });
}

module.exports = {
  FeishuUpstreamError,
  createFeishuClient,
  createFeishuAuthService,
};
