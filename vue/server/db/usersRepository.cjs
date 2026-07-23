const { mapUserRow, toApiId } = require('./values.cjs');
const { resolveExecutor } = require('./repositoryUtils.cjs');

function createUsersRepository(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');

  async function findById(id, options = {}) {
    const executor = resolveExecutor(options, db);
    const activeClause = options.activeOnly ? 'AND is_active = TRUE' : '';
    const { rows } = await executor.query(
      `SELECT * FROM public.app_users
        WHERE id = $1 ${activeClause}`,
      [id]
    );
    return mapUserRow(rows[0]);
  }

  async function listActive(options = {}) {
    const executor = resolveExecutor(options, db);
    const params = [];
    let providerClause = '';
    if (options.authProvider) {
      params.push(options.authProvider);
      providerClause = `AND auth_provider = $${params.length}`;
    }
    const { rows } = await executor.query(
      `SELECT * FROM public.app_users
        WHERE is_active = TRUE ${providerClause}
        ORDER BY display_name, id`,
      params
    );
    return rows.map(mapUserRow);
  }

  async function listActiveDevUsers(options = {}) {
    return listActive({ ...options, authProvider: 'dev' });
  }

  async function findActiveById(id, options = {}) {
    return findById(id, { ...options, activeOnly: true });
  }

  async function lockActiveById(id, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `SELECT * FROM public.app_users
        WHERE id = $1 AND is_active = TRUE
        FOR UPDATE`,
      [id]
    );
    return mapUserRow(rows[0]);
  }

  async function findActiveDevById(id, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `SELECT * FROM public.app_users
        WHERE id = $1
          AND is_active = TRUE
          AND auth_provider = 'dev'`,
      [id]
    );
    return mapUserRow(rows[0]);
  }

  async function createDevUser({ displayName, avatarUrl = null }, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `INSERT INTO public.app_users (display_name, avatar_url, auth_provider)
       VALUES ($1, $2, 'dev')
       RETURNING *`,
      [displayName, avatarUrl]
    );
    return mapUserRow(rows[0]);
  }

  async function updateLastLogin(id, options = {}) {
    const executor = resolveExecutor(options, db);
    const at = options.at || new Date();
    const { rows } = await executor.query(
      `UPDATE public.app_users
          SET last_login_at = $2
        WHERE id = $1 AND is_active = TRUE
      RETURNING *`,
      [id, at]
    );
    return mapUserRow(rows[0]);
  }

  async function setActive(id, isActive, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `UPDATE public.app_users
          SET is_active = $2
        WHERE id = $1
      RETURNING *`,
      [id, Boolean(isActive)]
    );
    return mapUserRow(rows[0]);
  }

  /**
   * Feishu identities use union_id when present; otherwise tenant_key + open_id.
   * The operation is intentionally transactional at the caller/service boundary.
   */
  async function findByFeishuIdentity(identity, options = {}) {
    const executor = resolveExecutor(options, db);
    const unionId = identity.unionId || null;
    const tenantKey = identity.tenantKey || null;
    const openId = identity.openId || null;
    const { rows } = await executor.query(
      `SELECT *
         FROM public.app_users
        WHERE ($1::text IS NOT NULL AND feishu_union_id = $1)
           OR ($2::text IS NOT NULL AND $3::text IS NOT NULL
               AND feishu_tenant_key = $2 AND feishu_open_id = $3)
        ORDER BY CASE WHEN feishu_union_id = $1 THEN 0 ELSE 1 END
        LIMIT 1`,
      [unionId, tenantKey, openId]
    );
    return mapUserRow(rows[0]);
  }

  async function createFeishuUser(data, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `INSERT INTO public.app_users (
         display_name, avatar_url, auth_provider,
         feishu_open_id, feishu_union_id, feishu_tenant_key, last_login_at
       ) VALUES ($1, $2, 'feishu', $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        data.displayName,
        data.avatarUrl || null,
        data.openId || null,
        data.unionId || null,
        data.tenantKey || null,
        data.lastLoginAt || new Date(),
      ]
    );
    return mapUserRow(rows[0]);
  }

  async function updateFeishuProfile(id, data, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `UPDATE public.app_users
          SET display_name = $2,
              avatar_url = $3,
              feishu_open_id = COALESCE($4, feishu_open_id),
              feishu_union_id = COALESCE($5, feishu_union_id),
              feishu_tenant_key = COALESCE($6, feishu_tenant_key),
              last_login_at = $7
        WHERE id = $1 AND is_active = TRUE
      RETURNING *`,
      [
        id,
        data.displayName,
        data.avatarUrl || null,
        data.openId || null,
        data.unionId || null,
        data.tenantKey || null,
        data.lastLoginAt || new Date(),
      ]
    );
    return mapUserRow(rows[0]);
  }

  return Object.freeze({
    findById,
    findActiveById,
    lockActiveById,
    findActiveDevById,
    listActive,
    listActiveDevUsers,
    createDevUser,
    updateLastLogin,
    touchLastLogin: updateLastLogin,
    setActive,
    findByFeishuIdentity,
    createFeishuUser,
    updateFeishuProfile,
    toApiId,
  });
}

module.exports = { createUsersRepository };
