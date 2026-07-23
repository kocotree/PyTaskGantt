const { mapRunRequestRow } = require('./values.cjs');
const { resolveExecutor } = require('./repositoryUtils.cjs');

const RUN_REQUEST_COLUMNS = `
  idempotent_uuid, rpa_task_id, schedule_uuid_at_run, schedule_bound_at_at_request,
  requested_by_user_id, status, task_uuid, job_uuid_list,
  audit_log_id, attempt_count, last_attempt_at, next_attempt_at,
  last_error, completed_at, created_at, updated_at`;

const OPEN_RUN_REQUEST_STATUSES = Object.freeze(['pending', 'dispatching']);

function createRunRequestsRepository(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');

  async function createPending(request, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `INSERT INTO public.rpa_task_run_requests (
         idempotent_uuid, rpa_task_id, schedule_uuid_at_run,
         schedule_bound_at_at_request, requested_by_user_id
       ) VALUES ($1::uuid, $2, $3, $4, $5)
       RETURNING ${RUN_REQUEST_COLUMNS}`,
      [
        request.idempotentUuid,
        request.rpaTaskId,
        request.scheduleUuidAtRun,
        request.scheduleBoundAtAtRequest,
        request.requestedByUserId,
      ]
    );
    return mapRunRequestRow(rows[0]);
  }

  async function findByIdempotentUuid(idempotentUuid, options = {}) {
    const executor = resolveExecutor(options, db);
    const lockClause = options.forUpdate ? 'FOR UPDATE' : '';
    const { rows } = await executor.query(
      `SELECT ${RUN_REQUEST_COLUMNS}
         FROM public.rpa_task_run_requests
        WHERE idempotent_uuid = $1::uuid
        ${lockClause}`,
      [idempotentUuid]
    );
    return mapRunRequestRow(rows[0]);
  }

  async function findOpenForTask(taskId, options = {}) {
    const executor = resolveExecutor(options, db);
    const lockClause = options.forUpdate ? 'FOR UPDATE' : '';
    const { rows } = await executor.query(
      `SELECT ${RUN_REQUEST_COLUMNS}
         FROM public.rpa_task_run_requests
        WHERE rpa_task_id = $1
          AND status = ANY($2::text[])
        ORDER BY created_at
        LIMIT 1
        ${lockClause}`,
      [taskId, OPEN_RUN_REQUEST_STATUSES]
    );
    return mapRunRequestRow(rows[0]);
  }

  async function markDispatching(idempotentUuid, attemptedAt = new Date(), options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `UPDATE public.rpa_task_run_requests
          SET status = 'dispatching',
              attempt_count = attempt_count + 1,
              last_attempt_at = $2,
              next_attempt_at = NULL,
              last_error = NULL
        WHERE idempotent_uuid = $1::uuid
          AND status IN ('pending', 'dispatching')
      RETURNING ${RUN_REQUEST_COLUMNS}`,
      [idempotentUuid, attemptedAt]
    );
    return mapRunRequestRow(rows[0]);
  }

  async function markRemoteAccepted(idempotentUuid, result, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `UPDATE public.rpa_task_run_requests
          SET task_uuid = $2,
              job_uuid_list = $3::jsonb,
              last_error = NULL,
              next_attempt_at = NULL
        WHERE idempotent_uuid = $1::uuid
          AND status = 'dispatching'
          AND (task_uuid IS NULL OR task_uuid = $2)
      RETURNING ${RUN_REQUEST_COLUMNS}`,
      [
        idempotentUuid,
        result.taskUuid,
        JSON.stringify(result.jobUuidList || []),
      ]
    );
    return mapRunRequestRow(rows[0]);
  }

  async function markSucceeded(idempotentUuid, result, options = {}) {
    const executor = resolveExecutor(options, db);
    const completedAt = result.completedAt || new Date();
    const { rows } = await executor.query(
      `UPDATE public.rpa_task_run_requests
          SET status = 'succeeded',
              task_uuid = $2,
              job_uuid_list = $3::jsonb,
              audit_log_id = $4,
              last_error = NULL,
              next_attempt_at = NULL,
              completed_at = $5
        WHERE idempotent_uuid = $1::uuid
          AND status = 'dispatching'
      RETURNING ${RUN_REQUEST_COLUMNS}`,
      [
        idempotentUuid,
        result.taskUuid,
        JSON.stringify(result.jobUuidList || []),
        result.auditLogId,
        completedAt,
      ]
    );
    return mapRunRequestRow(rows[0]);
  }

  async function recordFailure(idempotentUuid, failure, options = {}) {
    const executor = resolveExecutor(options, db);
    const rejected = Boolean(failure.rejected);
    const { rows } = await executor.query(
      `UPDATE public.rpa_task_run_requests
          SET status = $2,
              last_attempt_at = CASE
                WHEN task_uuid IS NULL THEN COALESCE($3, NOW())
                ELSE last_attempt_at
              END,
              next_attempt_at = $4,
              last_error = $5,
              completed_at = CASE WHEN $2 = 'rejected' THEN COALESCE($3, NOW()) ELSE NULL END
        WHERE idempotent_uuid = $1::uuid
          AND status IN ('pending', 'dispatching')
      RETURNING ${RUN_REQUEST_COLUMNS}`,
      [
        idempotentUuid,
        rejected ? 'rejected' : 'pending',
        failure.attemptedAt || new Date(),
        rejected ? null : failure.nextAttemptAt || null,
        failure.errorMessage || null,
      ]
    );
    return mapRunRequestRow(rows[0]);
  }

  async function listPendingDue({
    limit = 50,
    now = new Date(),
    dispatchLeaseMs = 5 * 60_000,
  } = {}, options = {}) {
    const executor = resolveExecutor(options, db);
    const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const boundedLeaseMs = Math.max(Number(dispatchLeaseMs) || 0, 0);
    const { rows } = await executor.query(
      `SELECT ${RUN_REQUEST_COLUMNS}
         FROM public.rpa_task_run_requests
        WHERE (
          status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
        ) OR (
          status = 'dispatching'
          AND (
            last_attempt_at IS NULL
            OR last_attempt_at <= $1 - ($3::double precision * INTERVAL '1 millisecond')
          )
        )
        ORDER BY COALESCE(next_attempt_at, created_at), created_at
        LIMIT $2`,
      [now, boundedLimit, boundedLeaseMs]
    );
    return rows.map(mapRunRequestRow);
  }

  return Object.freeze({
    createPending,
    findByIdempotentUuid,
    findOpenForTask,
    markDispatching,
    markRemoteAccepted,
    markSucceeded,
    recordFailure,
    listPendingDue,
  });
}

module.exports = {
  OPEN_RUN_REQUEST_STATUSES,
  RUN_REQUEST_COLUMNS,
  createRunRequestsRepository,
};
