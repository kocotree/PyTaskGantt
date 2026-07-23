const { mapTaskRow, normalizeTags, timestampAfter, toApiId, toIsoString } = require('./values.cjs');
const { resolveExecutor, withTransaction } = require('./repositoryUtils.cjs');

const TASK_RETURNING_COLUMNS = `
  id, task, start_time, finish_time, bot,
  created_by_user_id, owner_user_id, schedule_uuid, schedule_bound_at,
  tags, note, version, last_synced_at, sync_error,
  created_at, updated_at, deleted_at`;

const TASK_LIST_SELECT = `
  SELECT
    task.id, task.task, task.start_time, task.finish_time, task.bot,
    task.created_by_user_id, task.owner_user_id,
    task.schedule_uuid, task.schedule_bound_at,
    task.tags, task.note, task.version,
    task.last_synced_at, task.sync_error,
    task.created_at, task.updated_at, task.deleted_at,
    owner.id AS owner_id,
    owner.display_name AS owner_display_name,
    owner.avatar_url AS owner_avatar_url,
    creator.id AS created_by_id,
    creator.display_name AS created_by_display_name,
    creator.avatar_url AS created_by_avatar_url,
    CASE WHEN task.owner_user_id = $1::bigint
              AND task.schedule_uuid IS NOT NULL
              AND task.schedule_bound_at IS NOT NULL
         THEN TRUE ELSE FALSE END AS can_edit,
    (task.owner_user_id IS NULL OR task.schedule_uuid IS NULL OR task.schedule_bound_at IS NULL) AS is_legacy_unbound,
    COALESCE(summary.current_status, '待运行') AS current_status,
    summary.last_run_at
  FROM public.rpa_tasks AS task
  LEFT JOIN public.app_users AS owner ON owner.id = task.owner_user_id
  LEFT JOIN public.app_users AS creator ON creator.id = task.created_by_user_id
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN COUNT(*) FILTER (WHERE execution.normalized_status = '运行中') > 0 THEN '运行中'
        WHEN COUNT(*) FILTER (WHERE execution.normalized_status = '等待中') > 0 THEN '等待中'
        WHEN COUNT(*) FILTER (WHERE execution.normalized_status = '未知状态') > 0 THEN '未知状态'
        ELSE (ARRAY_AGG(
          execution.normalized_status
          ORDER BY COALESCE(execution.end_time, execution.updated_time, execution.trigger_time) DESC
        ))[1]
      END AS current_status,
      MAX(execution.trigger_time) AS last_run_at
    FROM public.rpa_task_executions AS execution
    WHERE execution.rpa_task_id = task.id
      AND execution.schedule_uuid_at_run = task.schedule_uuid
      AND execution.trigger_time >= task.schedule_bound_at
  ) AS summary ON TRUE`;

function createTasksRepository(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');

  async function listVisibleTasks({ currentUserId, executor = db } = {}) {
    if (currentUserId == null) throw new TypeError('currentUserId is required');
    const { rows } = await executor.query(
      `${TASK_LIST_SELECT}
       WHERE task.deleted_at IS NULL
       ORDER BY task.start_time, task.id`,
      [currentUserId]
    );
    return rows.map(mapTaskRow);
  }

  async function listOwnedTasks(ownerUserId, filters = {}, options = {}) {
    const executor = resolveExecutor(options, db);
    const params = [ownerUserId];
    const conditions = [
      'task.deleted_at IS NULL',
      'task.owner_user_id = $1::bigint',
      'task.schedule_uuid IS NOT NULL',
      'task.schedule_bound_at IS NOT NULL',
    ];

    if (filters.query && String(filters.query).trim()) {
      params.push(`%${String(filters.query).trim()}%`);
      conditions.push(`task.task ILIKE $${params.length}`);
    }
    const tags = normalizeTags(filters.tags);
    if (tags.length > 0) {
      params.push(tags);
      conditions.push(`task.tags @> $${params.length}::text[]`);
    }
    const statuses = Array.isArray(filters.normalizedStatus)
      ? filters.normalizedStatus.filter(Boolean)
      : filters.normalizedStatus ? [filters.normalizedStatus] : [];
    if (statuses.length > 0) {
      params.push(statuses);
      conditions.push(`COALESCE(summary.current_status, '待运行') = ANY($${params.length}::text[])`);
    }

    const orderBy = {
      name: 'task.task ASC, task.id ASC',
      start: 'task.start_time ASC, task.id ASC',
      last_run: 'summary.last_run_at DESC NULLS LAST, task.id ASC',
      updated: 'task.updated_at DESC, task.id ASC',
    }[filters.sort] || 'task.updated_at DESC, task.id ASC';

    const { rows } = await executor.query(
      `${TASK_LIST_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}`,
      params
    );
    return rows.map(mapTaskRow);
  }

  async function findById(id, options = {}) {
    const executor = resolveExecutor(options, db);
    const deletedClause = options.includeDeleted ? '' : 'AND deleted_at IS NULL';
    const lockClause = options.forUpdate ? 'FOR UPDATE' : '';
    const { rows } = await executor.query(
      `SELECT ${TASK_RETURNING_COLUMNS}
         FROM public.rpa_tasks
        WHERE id = $1 ${deletedClause}
        ${lockClause}`,
      [id]
    );
    return mapTaskRow(rows[0]);
  }

  async function lockById(id, executor) {
    if (!executor) throw new TypeError('lockById requires a transaction client');
    return findById(id, { executor, includeDeleted: true, forUpdate: true });
  }

  async function createTask(data, options = {}) {
    if (data.currentUserId == null) throw new TypeError('currentUserId is required');
    if (!data.scheduleUuid) throw new TypeError('scheduleUuid is required for new tasks');
    const transactionTarget = resolveExecutor(options, db);
    const tags = normalizeTags(data.tags);
    const boundAt = data.scheduleBoundAt || new Date();
    return withTransaction(transactionTarget, async client => {
      const { rows } = await client.query(
        `INSERT INTO public.rpa_tasks (
           task, start_time, finish_time, bot,
           created_by_user_id, owner_user_id,
           schedule_uuid, schedule_bound_at, tags, note
         ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8::text[], $9)
         RETURNING ${TASK_RETURNING_COLUMNS}`,
        [
          data.task,
          data.start,
          data.finish,
          data.bot,
          data.currentUserId,
          data.scheduleUuid,
          boundAt,
          tags,
          data.note || '',
        ]
      );
      await client.query(
        `INSERT INTO public.rpa_task_binding_history (
           rpa_task_id, schedule_uuid, bound_at, actor_user_id
         ) VALUES ($1, $2, $3, $4)`,
        [rows[0].id, data.scheduleUuid, boundAt, data.currentUserId]
      );
      return mapTaskRow(rows[0]);
    });
  }

  async function updateOwnedTask({ id, ownerUserId, version, changes }, options = {}) {
    const executor = resolveExecutor(options, db);
    const fieldMap = {
      task: 'task',
      start: 'start_time',
      finish: 'finish_time',
      bot: 'bot',
      tags: 'tags',
      note: 'note',
    };
    const assignments = [];
    const params = [id, ownerUserId, version];
    for (const [apiField, column] of Object.entries(fieldMap)) {
      if (!Object.prototype.hasOwnProperty.call(changes, apiField)) continue;
      const value = apiField === 'tags' ? normalizeTags(changes[apiField]) : changes[apiField];
      params.push(value);
      assignments.push(`${column} = $${params.length}${apiField === 'tags' ? '::text[]' : ''}`);
    }
    if (assignments.length === 0) {
      const current = await findById(id, { executor });
      return current
        && current.ownerUserId === toApiId(ownerUserId)
        && current.version === Number(version)
        && current.scheduleUuid
        && current.scheduleBoundAt
        ? current
        : null;
    }
    const { rows } = await executor.query(
      `UPDATE public.rpa_tasks
          SET ${assignments.join(', ')}, version = version + 1
        WHERE id = $1
          AND owner_user_id = $2
          AND version = $3
          AND deleted_at IS NULL
          AND schedule_uuid IS NOT NULL
          AND schedule_bound_at IS NOT NULL
      RETURNING ${TASK_RETURNING_COLUMNS}`,
      params
    );
    return mapTaskRow(rows[0]);
  }

  async function softDeleteTask({ id, ownerUserId, version, deletedAt = new Date() }, options = {}) {
    const transactionTarget = resolveExecutor(options, db);
    return withTransaction(transactionTarget, async client => {
      const { rows: lockedRows } = await client.query(
        `SELECT ${TASK_RETURNING_COLUMNS}
           FROM public.rpa_tasks
          WHERE id = $1
            AND owner_user_id = $2
            AND version = $3
            AND deleted_at IS NULL
            AND schedule_uuid IS NOT NULL
            AND schedule_bound_at IS NOT NULL
          FOR UPDATE`,
        [id, ownerUserId, version]
      );
      if (!lockedRows[0]) return null;
      const effectiveDeletedAt = timestampAfter(lockedRows[0].schedule_bound_at, deletedAt);
      const { rows } = await client.query(
        `UPDATE public.rpa_tasks
            SET deleted_at = $4,
                schedule_uuid = NULL,
                schedule_bound_at = NULL,
                version = version + 1
          WHERE id = $1
            AND owner_user_id = $2
            AND version = $3
            AND deleted_at IS NULL
            AND schedule_uuid IS NOT NULL
            AND schedule_bound_at IS NOT NULL
        RETURNING ${TASK_RETURNING_COLUMNS}`,
        [id, ownerUserId, version, effectiveDeletedAt]
      );
      await client.query(
        `UPDATE public.rpa_task_binding_history
            SET unbound_at = $2
          WHERE rpa_task_id = $1 AND unbound_at IS NULL`,
        [id, effectiveDeletedAt]
      );
      return mapTaskRow(rows[0]);
    });
  }

  async function rebindTask({
    id,
    ownerUserId,
    version,
    scheduleUuid,
    actorUserId,
    boundAt = new Date(),
  }, options = {}) {
    const transactionTarget = resolveExecutor(options, db);
    return withTransaction(transactionTarget, async client => {
      const { rows: lockedRows } = await client.query(
        `SELECT ${TASK_RETURNING_COLUMNS}
           FROM public.rpa_tasks
          WHERE id = $1
            AND owner_user_id = $2
            AND version = $3
            AND deleted_at IS NULL
            AND schedule_uuid IS NOT NULL
            AND schedule_bound_at IS NOT NULL
          FOR UPDATE`,
        [id, ownerUserId, version]
      );
      if (!lockedRows[0]) return null;
      const effectiveBoundAt = timestampAfter(lockedRows[0].schedule_bound_at, boundAt);

      await client.query(
        `UPDATE public.rpa_task_binding_history
            SET unbound_at = $2
          WHERE rpa_task_id = $1 AND unbound_at IS NULL`,
        [id, effectiveBoundAt]
      );
      const { rows } = await client.query(
        `UPDATE public.rpa_tasks
            SET schedule_uuid = $2,
                schedule_bound_at = $3,
                last_synced_at = NULL,
                sync_error = NULL,
                version = version + 1
          WHERE id = $1
        RETURNING ${TASK_RETURNING_COLUMNS}`,
        [id, scheduleUuid, effectiveBoundAt]
      );
      await client.query(
        `INSERT INTO public.rpa_task_binding_history (
           rpa_task_id, schedule_uuid, bound_at, actor_user_id
         ) VALUES ($1, $2, $3, $4)`,
        [id, scheduleUuid, effectiveBoundAt, actorUserId]
      );
      return mapTaskRow(rows[0]);
    });
  }

  async function transferTask({ id, ownerUserId, version, newOwnerUserId }, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `UPDATE public.rpa_tasks
          SET owner_user_id = $4, version = version + 1
        WHERE id = $1
          AND owner_user_id = $2
          AND version = $3
          AND deleted_at IS NULL
          AND schedule_uuid IS NOT NULL
          AND schedule_bound_at IS NOT NULL
      RETURNING ${TASK_RETURNING_COLUMNS}`,
      [id, ownerUserId, version, newOwnerUserId]
    );
    return mapTaskRow(rows[0]);
  }

  async function isScheduleBound(scheduleUuid, options = {}) {
    const executor = resolveExecutor(options, db);
    const params = [scheduleUuid];
    let exclude = '';
    if (options.excludeTaskId != null) {
      params.push(options.excludeTaskId);
      exclude = `AND id <> $${params.length}`;
    }
    const { rows } = await executor.query(
      `SELECT id, task, owner_user_id
         FROM public.rpa_tasks
        WHERE schedule_uuid = $1
          AND deleted_at IS NULL
          ${exclude}
        LIMIT 1`,
      params
    );
    if (!rows[0]) return null;
    return {
      taskId: toApiId(rows[0].id),
      taskName: rows[0].task,
      ownerUserId: toApiId(rows[0].owner_user_id),
    };
  }

  async function listBoundTasks(options = {}) {
    const executor = resolveExecutor(options, db);
    const params = [];
    let ownerClause = '';
    if (options.ownerUserId != null) {
      params.push(options.ownerUserId);
      ownerClause = `AND owner_user_id = $${params.length}`;
    }
    const { rows } = await executor.query(
      `SELECT ${TASK_RETURNING_COLUMNS}
         FROM public.rpa_tasks
        WHERE deleted_at IS NULL
          AND schedule_uuid IS NOT NULL
          AND schedule_bound_at IS NOT NULL
          ${ownerClause}
        ORDER BY id`,
      params
    );
    return rows.map(mapTaskRow);
  }

  async function findBindingForScheduleAt(scheduleUuid, triggerTime, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `SELECT id, rpa_task_id, schedule_uuid, bound_at, unbound_at, actor_user_id
         FROM public.rpa_task_binding_history
        WHERE schedule_uuid = $1
          AND bound_at <= $2
          AND (unbound_at IS NULL OR $2 < unbound_at)
        ORDER BY bound_at DESC
        LIMIT 1`,
      [scheduleUuid, triggerTime]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: toApiId(row.id),
      rpaTaskId: toApiId(row.rpa_task_id),
      scheduleUuid: row.schedule_uuid,
      boundAt: toIsoString(row.bound_at),
      unboundAt: toIsoString(row.unbound_at),
      actorUserId: toApiId(row.actor_user_id),
    };
  }

  async function beginSyncAttempt({ taskId, scheduleUuid, scheduleBoundAt }, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `UPDATE public.rpa_tasks
          SET sync_generation = sync_generation + 1
        WHERE id = $1
          AND deleted_at IS NULL
          AND schedule_uuid = $2
          AND date_trunc('milliseconds', schedule_bound_at)
              IS NOT DISTINCT FROM $3::timestamptz
      RETURNING id, schedule_uuid, schedule_bound_at, sync_generation`,
      [taskId, scheduleUuid, scheduleBoundAt]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      taskId: toApiId(row.id),
      scheduleUuid: row.schedule_uuid,
      scheduleBoundAt: toIsoString(row.schedule_bound_at),
      syncGeneration: toApiId(row.sync_generation),
    };
  }

  async function updateSyncState({
    taskId,
    scheduleUuid,
    scheduleBoundAt,
    syncGeneration,
    lastSyncedAt = new Date(),
    syncError = null,
  }, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `UPDATE public.rpa_tasks
          SET last_synced_at = CASE
                WHEN $5::text IS NULL AND $4::timestamptz IS NOT NULL
                  THEN GREATEST(COALESCE(last_synced_at, $4::timestamptz), $4::timestamptz)
                ELSE last_synced_at
              END,
              sync_error = $5
        WHERE id = $1
          AND deleted_at IS NULL
          AND schedule_uuid = $2
          AND date_trunc('milliseconds', schedule_bound_at)
              IS NOT DISTINCT FROM $3::timestamptz
          AND sync_generation = $6::bigint
      RETURNING ${TASK_RETURNING_COLUMNS}`,
      [taskId, scheduleUuid, scheduleBoundAt, lastSyncedAt, syncError, syncGeneration]
    );
    return mapTaskRow(rows[0]);
  }

  return Object.freeze({
    listVisibleTasks,
    listAll: (currentUserId, options = {}) => listVisibleTasks({ currentUserId, ...options }),
    listOwnedTasks,
    listMine: listOwnedTasks,
    findById,
    lockById,
    createTask,
    updateOwnedTask,
    softDeleteTask,
    rebindTask,
    transferTask,
    isScheduleBound,
    listBoundTasks,
    listAllBoundTasks: listBoundTasks,
    findBindingForScheduleAt,
    beginSyncAttempt,
    updateSyncState,
  });
}

module.exports = {
  createTasksRepository,
  TASK_RETURNING_COLUMNS,
};
