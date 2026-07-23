const { mapExecutionRow, toApiId } = require('./values.cjs');
const { resolveExecutor } = require('./repositoryUtils.cjs');

const EXECUTION_COLUMNS = `
  task_uuid, rpa_task_id, schedule_uuid_at_run,
  normalized_status, raw_status, raw_status_name,
  trigger_time, updated_time, end_time,
  job_uuid_list, source_type, clients, error_remark,
  synced_at, idempotent_uuid, started_by_user_id, created_at`;

const ACTIVE_STATUSES = Object.freeze(['等待中', '运行中', '未知状态']);

function jsonValue(value, fallback) {
  if (value == null) return JSON.stringify(fallback);
  return JSON.stringify(value);
}

function createExecutionsRepository(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');

  async function upsertExecution(execution, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `INSERT INTO public.rpa_task_executions (
         task_uuid, rpa_task_id, schedule_uuid_at_run,
         normalized_status, raw_status, raw_status_name,
         trigger_time, updated_time, end_time,
         job_uuid_list, source_type, clients, error_remark,
         synced_at, idempotent_uuid, started_by_user_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9,
         $10::jsonb, $11, $12::jsonb, $13,
         $14, $15::uuid, $16
       )
       ON CONFLICT (task_uuid) DO UPDATE SET
         normalized_status = EXCLUDED.normalized_status,
         raw_status = EXCLUDED.raw_status,
         raw_status_name = EXCLUDED.raw_status_name,
         trigger_time = EXCLUDED.trigger_time,
         updated_time = EXCLUDED.updated_time,
         end_time = EXCLUDED.end_time,
         job_uuid_list = CASE
           WHEN jsonb_array_length(EXCLUDED.job_uuid_list) = 0
             THEN public.rpa_task_executions.job_uuid_list
           ELSE COALESCE((
             SELECT jsonb_agg(value ORDER BY value)
               FROM (
                 SELECT DISTINCT value
                   FROM jsonb_array_elements_text(
                     public.rpa_task_executions.job_uuid_list || EXCLUDED.job_uuid_list
                   ) AS merged(value)
               ) AS deduplicated
           ), '[]'::jsonb)
         END,
         source_type = EXCLUDED.source_type,
         clients = CASE
           WHEN EXCLUDED.clients IS NULL
             OR (jsonb_typeof(EXCLUDED.clients) = 'array' AND jsonb_array_length(EXCLUDED.clients) = 0)
             THEN public.rpa_task_executions.clients
           ELSE EXCLUDED.clients
         END,
         error_remark = EXCLUDED.error_remark,
         synced_at = EXCLUDED.synced_at,
         idempotent_uuid = COALESCE(
           public.rpa_task_executions.idempotent_uuid,
           EXCLUDED.idempotent_uuid
         ),
         started_by_user_id = COALESCE(
           public.rpa_task_executions.started_by_user_id,
           EXCLUDED.started_by_user_id
         )
       WHERE public.rpa_task_executions.rpa_task_id = EXCLUDED.rpa_task_id
         AND public.rpa_task_executions.schedule_uuid_at_run = EXCLUDED.schedule_uuid_at_run
       RETURNING ${EXECUTION_COLUMNS}`,
      [
        execution.taskUuid,
        execution.rpaTaskId,
        execution.scheduleUuidAtRun,
        execution.normalizedStatus || '未知状态',
        execution.rawStatus || null,
        execution.rawStatusName || null,
        execution.triggerTime,
        execution.updatedTime || null,
        execution.endTime || null,
        jsonValue(execution.jobUuidList, []),
        execution.sourceType || null,
        jsonValue(execution.clients, null),
        execution.errorRemark || null,
        execution.syncedAt || new Date(),
        execution.idempotentUuid || null,
        execution.startedByUserId || null,
      ]
    );
    if (!rows[0]) {
      const error = new Error('同一 taskUuid 已关联到其他平台任务或计划绑定');
      error.code = 'EXECUTION_BINDING_CONFLICT';
      throw error;
    }
    return mapExecutionRow(rows[0]);
  }

  async function findByTaskUuid(taskUuid, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `SELECT ${EXECUTION_COLUMNS}
         FROM public.rpa_task_executions
        WHERE task_uuid = $1`,
      [taskUuid]
    );
    return mapExecutionRow(rows[0]);
  }

  async function findByJobUuid(jobUuid, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `SELECT ${EXECUTION_COLUMNS}
         FROM public.rpa_task_executions
        WHERE job_uuid_list ? $1
        ORDER BY COALESCE(updated_time, trigger_time) DESC, task_uuid
        LIMIT 1`,
      [String(jobUuid)]
    );
    return mapExecutionRow(rows[0]);
  }

  async function mergeJobUuids(taskUuid, jobUuids, options = {}) {
    const executor = resolveExecutor(options, db);
    const values = [...new Set((Array.isArray(jobUuids) ? jobUuids : [])
      .map(value => String(value || '').trim())
      .filter(Boolean))];
    if (values.length === 0) return findByTaskUuid(taskUuid, { executor });
    const { rows } = await executor.query(
      `UPDATE public.rpa_task_executions
          SET job_uuid_list = COALESCE((
            SELECT jsonb_agg(value ORDER BY value)
              FROM (
                SELECT DISTINCT value
                  FROM jsonb_array_elements_text(
                    COALESCE(job_uuid_list, '[]'::jsonb) || to_jsonb($2::text[])
                  ) AS merged(value)
              ) AS deduplicated
          ), '[]'::jsonb)
        WHERE task_uuid = $1
      RETURNING ${EXECUTION_COLUMNS}`,
      [String(taskUuid), values]
    );
    return mapExecutionRow(rows[0]);
  }

  async function findByIdempotentUuid(idempotentUuid, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `SELECT ${EXECUTION_COLUMNS}
         FROM public.rpa_task_executions
        WHERE idempotent_uuid = $1::uuid`,
      [idempotentUuid]
    );
    return mapExecutionRow(rows[0]);
  }

  async function listForTask(taskId, pagination = {}, options = {}) {
    const executor = resolveExecutor(options, db);
    const limit = Math.min(Math.max(Number(pagination.limit) || 50, 1), 200);
    const offset = Math.max(Number(pagination.offset) || 0, 0);
    const { rows } = await executor.query(
      `SELECT ${EXECUTION_COLUMNS}
         FROM public.rpa_task_executions
        WHERE rpa_task_id = $1
        ORDER BY trigger_time DESC, task_uuid
        LIMIT $2 OFFSET $3`,
      [taskId, limit, offset]
    );
    return rows.map(mapExecutionRow);
  }

  async function listForTaskPage(taskId, pagination = {}, options = {}) {
    const executor = resolveExecutor(options, db);
    const limit = Math.min(Math.max(Number(pagination.limit) || 50, 1), 200);
    const offset = Math.max(Number(pagination.offset) || 0, 0);
    const [{ rows: countRows }, executions] = await Promise.all([
      executor.query(
        `SELECT COUNT(*)::bigint AS total
           FROM public.rpa_task_executions
          WHERE rpa_task_id = $1`,
        [taskId]
      ),
      listForTask(taskId, { limit, offset }, { executor }),
    ]);
    const total = Number(countRows[0] && countRows[0].total) || 0;
    return {
      executions,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + executions.length < total,
      },
    };
  }

  async function listActiveExecutions(filters = {}, options = {}) {
    const executor = resolveExecutor(options, db);
    const params = [ACTIVE_STATUSES];
    const conditions = ['normalized_status = ANY($1::text[])'];
    if (filters.taskId != null) {
      params.push(filters.taskId);
      conditions.push(`rpa_task_id = $${params.length}`);
    }
    if (filters.ownerUserId != null) {
      params.push(filters.ownerUserId);
      conditions.push(`EXISTS (
        SELECT 1 FROM public.rpa_tasks AS task
         WHERE task.id = rpa_task_executions.rpa_task_id
           AND task.owner_user_id = $${params.length}
           AND task.deleted_at IS NULL
      )`);
    }
    const { rows } = await executor.query(
      `SELECT ${EXECUTION_COLUMNS}
         FROM public.rpa_task_executions
        WHERE ${conditions.join(' AND ')}
        ORDER BY COALESCE(updated_time, trigger_time), task_uuid`,
      params
    );
    return rows.map(mapExecutionRow);
  }

  async function hasActiveExecution(taskId, options = {}) {
    const executor = resolveExecutor(options, db);
    const params = [taskId, ACTIVE_STATUSES];
    const conditions = [
      'rpa_task_id = $1',
      'normalized_status = ANY($2::text[])',
    ];
    if (options.scheduleUuid) {
      params.push(options.scheduleUuid);
      conditions.push(`schedule_uuid_at_run = $${params.length}`);
    }
    if (options.scheduleBoundAt) {
      params.push(options.scheduleBoundAt);
      conditions.push(`trigger_time >= $${params.length}`);
    }
    const { rows } = await executor.query(
      `SELECT task_uuid, normalized_status
         FROM public.rpa_task_executions
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY trigger_time DESC
        LIMIT 1`,
      params
    );
    if (!rows[0]) return null;
    return {
      taskUuid: rows[0].task_uuid,
      normalizedStatus: rows[0].normalized_status,
    };
  }

  async function getTaskStatusSummary(taskId, options = {}) {
    const executor = resolveExecutor(options, db);
    const params = [taskId];
    const conditions = ['rpa_task_id = $1'];
    if (options.scheduleUuid) {
      params.push(options.scheduleUuid);
      conditions.push(`schedule_uuid_at_run = $${params.length}`);
    }
    if (options.scheduleBoundAt) {
      params.push(options.scheduleBoundAt);
      conditions.push(`trigger_time >= $${params.length}`);
    }
    const { rows } = await executor.query(
      `SELECT
         CASE
           WHEN COUNT(*) FILTER (WHERE normalized_status = '运行中') > 0 THEN '运行中'
           WHEN COUNT(*) FILTER (WHERE normalized_status = '等待中') > 0 THEN '等待中'
           ELSE (ARRAY_AGG(
             normalized_status
             ORDER BY COALESCE(end_time, updated_time, trigger_time) DESC
           ))[1]
         END AS current_status,
         MAX(trigger_time) AS last_run_at
       FROM public.rpa_task_executions
       WHERE ${conditions.join('\n         AND ')}`,
      params
    );
    const row = rows[0] || {};
    return {
      taskId: toApiId(taskId),
      currentStatus: row.current_status || '待运行',
      lastRunAt: row.last_run_at instanceof Date
        ? row.last_run_at.toISOString()
        : row.last_run_at || null,
    };
  }

  async function deleteExpired(retentionDays, options = {}) {
    const executor = resolveExecutor(options, db);
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < 1) throw new TypeError('retentionDays must be a positive integer');
    const result = await executor.query(
      `DELETE FROM public.rpa_task_executions
        WHERE COALESCE(end_time, trigger_time) < NOW() - ($1::int * INTERVAL '1 day')
          AND normalized_status <> ALL($2::text[])`,
      [days, ACTIVE_STATUSES]
    );
    return result.rowCount || 0;
  }

  return Object.freeze({
    upsertExecution,
    findByTaskUuid,
    findByJobUuid,
    mergeJobUuids,
    findByIdempotentUuid,
    listForTask,
    listForTaskPage,
    listActiveExecutions,
    hasActiveExecution,
    hasActiveForTask: hasActiveExecution,
    getTaskStatusSummary,
    deleteExpired,
    purgeExpired: deleteExpired,
  });
}

module.exports = {
  ACTIVE_STATUSES,
  EXECUTION_COLUMNS,
  createExecutionsRepository,
};
