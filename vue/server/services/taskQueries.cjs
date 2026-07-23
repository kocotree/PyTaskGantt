const { EXECUTION_STATUS } = require('./executionStatus.cjs');

const TASK_SELECT = `
  SELECT
    t.id::text AS id,
    t.task,
    t.start_time AS start,
    t.finish_time AS finish,
    t.bot,
    COALESCE(t.tags, ARRAY[]::text[]) AS tags,
    COALESCE(t.note, '') AS note,
    t.created_by_user_id::text AS created_by_user_id,
    t.owner_user_id::text AS owner_user_id,
    t.schedule_uuid,
    t.schedule_bound_at,
    t.version,
    t.last_synced_at,
    t.sync_error,
    t.created_at,
    t.updated_at,
    t.deleted_at,
    CASE WHEN owner.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', owner.id::text,
      'display_name', owner.display_name,
      'avatar_url', owner.avatar_url
    ) END AS owner,
    CASE WHEN creator.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', creator.id::text,
      'display_name', creator.display_name,
      'avatar_url', creator.avatar_url
    ) END AS created_by,
    (t.deleted_at IS NULL
      AND (t.owner_user_id = $2::bigint OR $3::boolean = TRUE)
      AND t.owner_user_id IS NOT NULL
      AND t.schedule_uuid IS NOT NULL
      AND t.schedule_bound_at IS NOT NULL) AS can_edit,
    (t.owner_user_id IS NULL OR t.schedule_uuid IS NULL OR t.schedule_bound_at IS NULL) AS is_legacy_unbound,
    COALESCE(summary.normalized_status, '${EXECUTION_STATUS.NOT_RUN}') AS normalized_status,
    summary.last_run_at
  FROM rpa_tasks t
  LEFT JOIN app_users owner ON owner.id = t.owner_user_id
  LEFT JOIN app_users creator ON creator.id = t.created_by_user_id
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN bool_or(e.normalized_status = '${EXECUTION_STATUS.RUNNING}') THEN '${EXECUTION_STATUS.RUNNING}'
        WHEN bool_or(e.normalized_status = '${EXECUTION_STATUS.WAITING}') THEN '${EXECUTION_STATUS.WAITING}'
        WHEN bool_or(e.normalized_status = '${EXECUTION_STATUS.UNKNOWN}') THEN '${EXECUTION_STATUS.UNKNOWN}'
        ELSE (array_agg(
          e.normalized_status
          ORDER BY COALESCE(e.end_time, e.updated_time, e.trigger_time) DESC NULLS LAST
        ))[1]
      END AS normalized_status,
      max(e.trigger_time) AS last_run_at
    FROM rpa_task_executions e
    WHERE e.rpa_task_id = t.id
      AND e.schedule_uuid_at_run = t.schedule_uuid
      AND e.trigger_time >= t.schedule_bound_at
  ) summary ON TRUE
`;

function actorValues(actor) {
  if (actor && typeof actor === 'object') {
    return {
      userId: String(actor.userId ?? actor.user_id ?? actor.id),
      isAdmin: Boolean(actor.isAdmin ?? actor.is_admin),
    };
  }
  return { userId: String(actor), isAdmin: false };
}

async function loadTasksByIds(queryable, ids, actor, { includeDeleted = false } = {}) {
  if (!ids.length) return [];
  const { userId, isAdmin } = actorValues(actor);
  const { rows } = await queryable.query(
    `${TASK_SELECT}
     WHERE t.id = ANY($1::bigint[]) ${includeDeleted ? '' : 'AND t.deleted_at IS NULL'}
     ORDER BY t.id`,
    [ids, userId, isAdmin]
  );
  return rows;
}

async function loadTaskById(queryable, id, actor, options) {
  const rows = await loadTasksByIds(queryable, [id], actor, options);
  return rows[0] || null;
}

module.exports = { TASK_SELECT, actorValues, loadTasksByIds, loadTaskById };
