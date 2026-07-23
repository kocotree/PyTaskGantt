const { mapAuditRow } = require('./values.cjs');
const { resolveExecutor } = require('./repositoryUtils.cjs');

const ALLOWED_ACTIONS = Object.freeze([
  'create',
  'update',
  'delete',
  'rebind',
  'transfer',
  'import',
  'run_now',
  'admin_recover',
]);

function createAuditRepository(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');

  async function append(entry, options = {}) {
    if (!ALLOWED_ACTIONS.includes(entry.action)) {
      throw new TypeError(`Unsupported audit action: ${entry.action}`);
    }
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `INSERT INTO public.rpa_task_audit_log (
         task_id, actor_user_id, action, old_value, new_value, created_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, COALESCE($6, NOW()))
       RETURNING id, task_id, actor_user_id, action, old_value, new_value, created_at`,
      [
        entry.taskId,
        entry.actorUserId || null,
        entry.action,
        entry.oldValue == null ? null : JSON.stringify(entry.oldValue),
        entry.newValue == null ? null : JSON.stringify(entry.newValue),
        entry.createdAt || null,
      ]
    );
    return mapAuditRow(rows[0]);
  }

  async function listForTask(taskId, pagination = {}, options = {}) {
    const executor = resolveExecutor(options, db);
    const limit = Math.min(Math.max(Number(pagination.limit) || 50, 1), 200);
    const offset = Math.max(Number(pagination.offset) || 0, 0);
    const { rows } = await executor.query(
      `SELECT id, task_id, actor_user_id, action, old_value, new_value, created_at
         FROM public.rpa_task_audit_log
        WHERE task_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [taskId, limit, offset]
    );
    return rows.map(mapAuditRow);
  }

  async function listByActor(actorUserId, pagination = {}, options = {}) {
    const executor = resolveExecutor(options, db);
    const limit = Math.min(Math.max(Number(pagination.limit) || 50, 1), 200);
    const offset = Math.max(Number(pagination.offset) || 0, 0);
    const { rows } = await executor.query(
      `SELECT id, task_id, actor_user_id, action, old_value, new_value, created_at
         FROM public.rpa_task_audit_log
        WHERE actor_user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [actorUserId, limit, offset]
    );
    return rows.map(mapAuditRow);
  }

  return Object.freeze({ append, listForTask, listByActor });
}

module.exports = {
  ALLOWED_ACTIONS,
  createAuditRepository,
};
