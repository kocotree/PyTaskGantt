const { randomUUID } = require('crypto');
const {
  AdminRequiredError,
  ConflictError,
  NotFoundError,
  ValidationError,
  databaseError,
} = require('../errors.cjs');
const { withTransaction } = require('../db/repositoryUtils.cjs');
const { createRunRequestsRepository } = require('../db/runRequestsRepository.cjs');
const { timestampAfter } = require('../db/values.cjs');
const {
  addAudit,
  assertOwner,
  lockTask,
  normalizeActor,
  withAdminAudit,
} = require('./taskMutationService.cjs');
const { loadTaskById } = require('./taskQueries.cjs');
const { EXECUTION_STATUS } = require('./executionStatus.cjs');

const ACTIVE_EXECUTION_STATUSES = Object.freeze([
  EXECUTION_STATUS.WAITING,
  EXECUTION_STATUS.RUNNING,
  EXECUTION_STATUS.UNKNOWN,
]);
const DEFAULT_RECOVERY_INTERVAL_MS = 60_000;
const DEFAULT_DISPATCH_LEASE_MS = 5 * 60_000;
const RECOVERY_BATCH_SIZE = 50;

function safeErrorMessage(error) {
  const message = error && error.message ? error.message : String(error || '启动失败');
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1000);
}

function retryDelayMs(attemptCount) {
  const exponent = Math.min(Math.max(Number(attemptCount) || 0, 0), 6);
  return Math.min(15 * 60_000, 15_000 * (2 ** exponent));
}

function isDefinitiveUpstreamRejection(error) {
  const status = Number(error && error.status);
  const code = Number(error && error.code);
  const value = Number.isFinite(status) && status > 0 ? status : code;
  return Number.isFinite(value)
    && value >= 400
    && value < 500
    && ![408, 409, 425, 429].includes(value);
}

function dispatchLeaseExpired(request, attemptedAt, leaseMs) {
  if (!request || request.status !== 'dispatching') return true;
  const lastAttempt = Date.parse(request.lastAttemptAt || '');
  return !Number.isFinite(lastAttempt)
    || attemptedAt.getTime() - lastAttempt >= leaseMs;
}

function timestampValue(value) {
  if (value instanceof Date) return value.getTime();
  return Date.parse(value || '');
}

async function findActiveExecution(
  client,
  taskId,
  scheduleUuid,
  scheduleBoundAt,
  idempotentUuid = null
) {
  const { rows } = await client.query(
    `SELECT task_uuid, idempotent_uuid, job_uuid_list,
            normalized_status, trigger_time, updated_time
       FROM rpa_task_executions
      WHERE rpa_task_id = $1
        AND normalized_status = ANY($2::text[])
        AND schedule_uuid_at_run = $3
        AND trigger_time >= $4
      ORDER BY CASE
                 WHEN $5::uuid IS NOT NULL AND idempotent_uuid = $5::uuid THEN 0
                 ELSE 1
               END,
               COALESCE(updated_time, trigger_time) DESC
      LIMIT 1`,
    [taskId, ACTIVE_EXECUTION_STATUSES, scheduleUuid, scheduleBoundAt, idempotentUuid]
  );
  return rows[0] || null;
}

async function lockTaskForFirstRunClaim(client, taskId, requesterUserId) {
  const { rows } = await client.query(
    `SELECT task.id, task.owner_user_id, task.schedule_uuid, task.schedule_bound_at,
            task.deleted_at, requester.is_admin AS requester_is_admin
       FROM rpa_tasks AS task
       JOIN app_users AS requester ON requester.id = $2 AND requester.is_active = TRUE
      WHERE task.id = $1
      FOR UPDATE`,
    [taskId, requesterUserId]
  );
  return rows[0] || null;
}

async function readTaskForAuthorization(pool, taskId) {
  const { rows } = await pool.query(
    `SELECT id, owner_user_id, schedule_uuid, schedule_bound_at, version, deleted_at
       FROM rpa_tasks
      WHERE id = $1 AND deleted_at IS NULL`,
    [taskId]
  );
  return rows[0] || null;
}

function createTaskActionService({
  pool,
  scheduleDirectory,
  yingdaoClient,
  pollingCoordinator,
  syncCoordinator,
  runRequestsRepository,
  logger = console,
  uuid = randomUUID,
  now = () => new Date(),
  recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS,
  dispatchLeaseMs = DEFAULT_DISPATCH_LEASE_MS,
}) {
  const runningLocks = new Map();
  const runRequests = runRequestsRepository || createRunRequestsRepository(pool);
  let recoveryTimer = null;
  let recoveryFlight = null;

  async function rebind(actorInput, taskId, { schedule_uuid: scheduleUuid, version }) {
    const actor = normalizeActor(actorInput);
    const userId = actor.userId;
    try {
      const preliminary = await readTaskForAuthorization(pool, taskId);
      assertOwner(preliminary, actor);
      if (Number(preliminary.version) !== version) throw new ConflictError('VERSION_CONFLICT');
      if (preliminary.schedule_uuid === scheduleUuid) throw new ValidationError('该任务已经绑定此计划');
      await scheduleDirectory.assertBindable(scheduleUuid, { actorUserId: userId, excludeTaskId: taskId });
    } catch (error) {
      throw databaseError(error);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await lockTask(client, taskId);
      assertOwner(current, actor);
      if (Number(current.version) !== version) throw new ConflictError('VERSION_CONFLICT');
      if (current.schedule_uuid === scheduleUuid) throw new ValidationError('该任务已经绑定此计划');
      const changedAt = timestampAfter(current.schedule_bound_at, now());
      if (current.schedule_uuid) {
        await client.query(
          `UPDATE rpa_task_binding_history SET unbound_at = $2
           WHERE rpa_task_id = $1 AND unbound_at IS NULL`,
          [taskId, changedAt]
        );
      }
      await client.query(
        `INSERT INTO rpa_task_binding_history
           (rpa_task_id, schedule_uuid, bound_at, actor_user_id)
         VALUES ($1, $2, $3, $4)`,
        [taskId, scheduleUuid, changedAt, userId]
      );
      const { rows } = await client.query(
        `UPDATE rpa_tasks
         SET schedule_uuid = $2, schedule_bound_at = $3, version = version + 1,
             last_synced_at = NULL, sync_error = NULL, updated_at = $3
         WHERE id = $1 AND version = $4 AND deleted_at IS NULL
         RETURNING id`,
        [taskId, scheduleUuid, changedAt, version]
      );
      if (!rows[0]) throw new ConflictError('VERSION_CONFLICT');
      await addAudit(client, {
        taskId,
        actorUserId: userId,
        action: 'rebind',
        oldValue: { schedule_uuid: current.schedule_uuid },
        newValue: withAdminAudit({
          schedule_uuid: scheduleUuid,
          schedule_bound_at: changedAt.toISOString(),
        }, actor, current.owner_user_id),
      });
      const task = await loadTaskById(client, taskId, actor);
      await client.query('COMMIT');
      if (syncCoordinator && typeof syncCoordinator.syncTask === 'function') {
        syncCoordinator.syncTask(actor, taskId).catch(() => undefined);
      }
      return { success: true, task };
    } catch (error) {
      await client.query('ROLLBACK');
      throw databaseError(error);
    } finally {
      client.release();
    }
  }

  async function transfer(actorInput, taskId, { target_user_id: targetUserId, version }) {
    const actor = normalizeActor(actorInput);
    const userId = actor.userId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await lockTask(client, taskId);
      assertOwner(current, actor);
      if (Number(current.version) !== version) throw new ConflictError('VERSION_CONFLICT');
      if (String(current.owner_user_id) === String(targetUserId)) {
        throw new ValidationError('任务已属于该用户');
      }
      const { rows: users } = await client.query(
        `SELECT id FROM app_users WHERE id = $1 AND is_active = TRUE`,
        [targetUserId]
      );
      if (!users[0]) throw new NotFoundError('接收用户不存在或已停用');
      const { rows } = await client.query(
        `UPDATE rpa_tasks
         SET owner_user_id = $2, version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $3 AND deleted_at IS NULL
         RETURNING id`,
        [taskId, targetUserId, version]
      );
      if (!rows[0]) throw new ConflictError('VERSION_CONFLICT');
      await addAudit(client, {
        taskId,
        actorUserId: userId,
        action: 'transfer',
        oldValue: { owner_user_id: String(current.owner_user_id) },
        newValue: withAdminAudit(
          { owner_user_id: String(targetUserId) },
          actor,
          current.owner_user_id
        ),
      });
      const task = await loadTaskById(client, taskId, actor);
      await client.query('COMMIT');
      return { success: true, task };
    } catch (error) {
      await client.query('ROLLBACK');
      throw databaseError(error);
    } finally {
      client.release();
    }
  }

  async function recover(actorInput, taskId, {
    owner_user_id: ownerUserId,
    schedule_uuid: scheduleUuid,
    version,
  }) {
    const actor = normalizeActor(actorInput);
    if (!actor.isAdmin) throw new AdminRequiredError();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await lockTask(client, taskId);
      if (!current) throw new NotFoundError('任务不存在或已删除');
      if (Number(current.version) !== version) throw new ConflictError('VERSION_CONFLICT');
      if (current.owner_user_id != null && current.schedule_uuid && current.schedule_bound_at) {
        throw new ConflictError('TASK_ALREADY_ACTIVE', '任务已是正常有效任务，请使用转交或换绑功能');
      }

      const { rows: owners } = await client.query(
        `SELECT id FROM app_users WHERE id = $1 AND is_active = TRUE FOR SHARE`,
        [ownerUserId]
      );
      if (!owners[0]) throw new NotFoundError('目标用户不存在或已停用');

      await scheduleDirectory.assertBindable(scheduleUuid, {
        actorUserId: actor.userId,
        excludeTaskId: taskId,
      });
      const { rows: occupied } = await client.query(
        `SELECT id FROM rpa_tasks
          WHERE schedule_uuid = $1
            AND deleted_at IS NULL
            AND id <> $2
          LIMIT 1`,
        [scheduleUuid, taskId]
      );
      if (occupied[0]) {
        throw new ConflictError('SCHEDULE_ALREADY_BOUND', '该影刀计划已被其他任务绑定');
      }

      const boundAt = timestampAfter(current.schedule_bound_at, now());
      if (current.schedule_uuid) {
        await client.query(
          `UPDATE rpa_task_binding_history
              SET unbound_at = $2
            WHERE rpa_task_id = $1 AND unbound_at IS NULL`,
          [taskId, boundAt]
        );
      }
      await client.query(
        `INSERT INTO rpa_task_binding_history
           (rpa_task_id, schedule_uuid, bound_at, actor_user_id)
         VALUES ($1, $2, $3, $4)`,
        [taskId, scheduleUuid, boundAt, actor.userId]
      );
      const { rows } = await client.query(
        `UPDATE rpa_tasks
            SET owner_user_id = $2,
                schedule_uuid = $3,
                schedule_bound_at = $4,
                version = version + 1,
                last_synced_at = NULL,
                sync_error = NULL,
                updated_at = $4
          WHERE id = $1 AND version = $5 AND deleted_at IS NULL
        RETURNING id`,
        [taskId, ownerUserId, scheduleUuid, boundAt, version]
      );
      if (!rows[0]) throw new ConflictError('VERSION_CONFLICT');

      await addAudit(client, {
        taskId,
        actorUserId: actor.userId,
        action: 'admin_recover',
        oldValue: {
          owner_user_id: current.owner_user_id == null ? null : String(current.owner_user_id),
          schedule_uuid: current.schedule_uuid || null,
          schedule_bound_at: current.schedule_bound_at || null,
          version: Number(current.version),
        },
        newValue: {
          owner_user_id: String(ownerUserId),
          schedule_uuid: scheduleUuid,
          schedule_bound_at: boundAt.toISOString(),
          version: Number(current.version) + 1,
          admin_override: true,
          task_owner_user_id: current.owner_user_id == null ? null : String(current.owner_user_id),
        },
      });
      const task = await loadTaskById(client, taskId, actor);
      await client.query('COMMIT');
      return { success: true, task };
    } catch (error) {
      await client.query('ROLLBACK');
      throw databaseError(error);
    } finally {
      client.release();
    }
  }

  async function prepareRunRequest(actorInput, taskId) {
    const actor = normalizeActor(actorInput);
    const userId = actor.userId;
    return withTransaction(pool, async client => {
      const current = await lockTask(client, taskId);
      assertOwner(current, actor);
      if (!current.schedule_uuid) throw new ValidationError('任务尚未绑定影刀计划');

      if (await findActiveExecution(
        client,
        taskId,
        current.schedule_uuid,
        current.schedule_bound_at
      )) {
        throw new ConflictError('TASK_ALREADY_ACTIVE', '任务已有等待中或运行中的实例');
      }

      const pending = await runRequests.findOpenForTask(taskId, {
        executor: client,
        forUpdate: true,
      });
      if (pending) return pending;

      return runRequests.createPending({
        idempotentUuid: uuid(),
        rpaTaskId: String(taskId),
        scheduleUuidAtRun: current.schedule_uuid,
        scheduleBoundAtAtRequest: current.schedule_bound_at,
        requestedByUserId: String(userId),
      }, { executor: client });
    });
  }

  async function claimRunRequest(runRequest, attemptedAt) {
    return withTransaction(pool, async client => {
      const request = await runRequests.findByIdempotentUuid(runRequest.idempotentUuid, {
        executor: client,
        forUpdate: true,
      });
      if (!request) throw new NotFoundError('立即执行请求不存在');
      if (request.status === 'rejected') {
        throw new ConflictError('RUN_REQUEST_REJECTED', '此前的立即执行请求已被上游明确拒绝');
      }
      if (request.status === 'succeeded') return { kind: 'succeeded', request };
      if (!dispatchLeaseExpired(request, attemptedAt, dispatchLeaseMs)) {
        throw new ConflictError('RUN_REQUEST_IN_PROGRESS', '立即执行请求正在发送到影刀');
      }

      if (request.taskUuid) {
        const remoteAcceptedAt = request.lastAttemptAt || attemptedAt.toISOString();
        const claimed = await runRequests.markDispatching(
          request.idempotentUuid,
          attemptedAt,
          { executor: client }
        );
        if (!claimed) throw new ConflictError('RUN_REQUEST_STATE_CONFLICT', '立即执行请求状态已发生变化');
        return {
          kind: 'accepted',
          request: claimed,
          execution: {
            taskUuid: request.taskUuid,
            jobUuidList: request.jobUuidList || [],
            normalizedStatus: EXECUTION_STATUS.WAITING,
            triggerTime: remoteAcceptedAt,
            updatedTime: remoteAcceptedAt,
          },
        };
      }

      if (request.attemptCount === 0) {
        const task = await lockTaskForFirstRunClaim(
          client,
          request.rpaTaskId,
          request.requestedByUserId
        );
        const currentBoundAt = timestampValue(task && task.schedule_bound_at);
        const requestedBoundAt = timestampValue(request.scheduleBoundAtAtRequest);
        const contextChanged = !task
          || task.deleted_at != null
          || (
            String(task.owner_user_id) !== String(request.requestedByUserId)
            && !task.requester_is_admin
          )
          || String(task.schedule_uuid || '') !== String(request.scheduleUuidAtRun)
          || !Number.isFinite(currentBoundAt)
          || currentBoundAt !== requestedBoundAt;
        if (contextChanged) {
          const error = new ConflictError(
            'RUN_REQUEST_CONTEXT_CHANGED',
            '任务已删除、转交或换绑，立即执行请求未发送'
          );
          await runRequests.recordFailure(request.idempotentUuid, {
            rejected: true,
            attemptedAt,
            nextAttemptAt: null,
            errorMessage: safeErrorMessage(error),
          }, { executor: client });
          return { kind: 'rejected', error };
        }
      }

      const active = await findActiveExecution(
        client,
        request.rpaTaskId,
        request.scheduleUuidAtRun,
        request.scheduleBoundAtAtRequest,
        request.idempotentUuid
      );
      if (active && (!active.idempotent_uuid || String(active.idempotent_uuid) !== request.idempotentUuid)) {
        const firstAttempt = request.attemptCount === 0;
        const error = new ConflictError('TASK_ALREADY_ACTIVE', '任务已有等待中或运行中的实例');
        await runRequests.recordFailure(request.idempotentUuid, {
          rejected: firstAttempt,
          attemptedAt,
          nextAttemptAt: firstAttempt
            ? null
            : new Date(attemptedAt.getTime() + retryDelayMs(request.attemptCount)),
          errorMessage: safeErrorMessage(error),
        }, { executor: client });
        return { kind: firstAttempt ? 'rejected' : 'deferred', error };
      }

      const claimed = await runRequests.markDispatching(
        request.idempotentUuid,
        attemptedAt,
        { executor: client }
      );
      if (!claimed) throw new ConflictError('RUN_REQUEST_STATE_CONFLICT', '立即执行请求状态已发生变化');
      return active
        ? { kind: 'existing', request: claimed, execution: active }
        : { kind: 'dispatch', request: claimed };
    });
  }

  async function recordRunFailure(request, error, attemptedAt, rejected) {
    try {
      await runRequests.recordFailure(request.idempotentUuid, {
        rejected,
        attemptedAt,
        nextAttemptAt: rejected
          ? null
          : new Date(attemptedAt.getTime() + retryDelayMs(request.attemptCount)),
        errorMessage: safeErrorMessage(error),
      });
    } catch (recordError) {
      if (logger && typeof logger.error === 'function') {
        logger.error('立即执行失败状态未能持久化', {
          idempotentUuid: request.idempotentUuid,
          error: safeErrorMessage(recordError),
        });
      }
    }
  }

  async function finalizeRunRequest(request, execution, attemptedAt, { recovered = false } = {}) {
    return withTransaction(pool, async client => {
      const current = await runRequests.findByIdempotentUuid(request.idempotentUuid, {
        executor: client,
        forUpdate: true,
      });
      if (!current) throw new NotFoundError('立即执行请求不存在');
      if (current.status === 'succeeded') {
        return {
          response: {
            success: true,
            task_uuid: current.taskUuid,
            job_uuid_list: current.jobUuidList,
            normalized_status: execution.normalizedStatus || EXECUTION_STATUS.WAITING,
          },
          pollingExecution: null,
        };
      }
      if (current.status !== 'dispatching') {
        throw new ConflictError('RUN_REQUEST_STATE_CONFLICT', '立即执行请求不再处于发送状态');
      }

      const { rows: persistedExecutions } = await client.query(
          `INSERT INTO rpa_task_executions (
             task_uuid, rpa_task_id, schedule_uuid_at_run, normalized_status,
             raw_status, raw_status_name, trigger_time, updated_time,
             job_uuid_list, source_type, synced_at, idempotent_uuid, started_by_user_id
           ) VALUES ($1, $2, $3, $8, 'created', '已创建', $4, $4, $5::jsonb, 'api', $4, $6::uuid, $7)
           ON CONFLICT (task_uuid) DO UPDATE SET
             rpa_task_id = EXCLUDED.rpa_task_id,
             schedule_uuid_at_run = EXCLUDED.schedule_uuid_at_run,
             job_uuid_list = CASE
               WHEN jsonb_array_length(rpa_task_executions.job_uuid_list) = 0
                 THEN EXCLUDED.job_uuid_list
               ELSE rpa_task_executions.job_uuid_list
             END,
             idempotent_uuid = COALESCE(rpa_task_executions.idempotent_uuid, EXCLUDED.idempotent_uuid),
             started_by_user_id = COALESCE(rpa_task_executions.started_by_user_id, EXCLUDED.started_by_user_id),
             synced_at = GREATEST(rpa_task_executions.synced_at, EXCLUDED.synced_at)
           WHERE (rpa_task_executions.idempotent_uuid IS NULL
                  OR rpa_task_executions.idempotent_uuid = EXCLUDED.idempotent_uuid)
             AND rpa_task_executions.rpa_task_id = EXCLUDED.rpa_task_id
             AND rpa_task_executions.schedule_uuid_at_run = EXCLUDED.schedule_uuid_at_run
         RETURNING task_uuid`,
          [
            execution.taskUuid,
            current.rpaTaskId,
            current.scheduleUuidAtRun,
            attemptedAt,
            JSON.stringify(execution.jobUuidList || []),
            current.idempotentUuid,
            current.requestedByUserId,
            EXECUTION_STATUS.WAITING,
          ]
        );
      if (!persistedExecutions[0]) {
        throw new ConflictError(
          'RUN_REQUEST_EXECUTION_CONFLICT',
          '影刀执行记录已关联到其他任务或幂等请求'
        );
      }

      const { rows: auditContexts } = await client.query(
        `SELECT task.owner_user_id, actor.is_admin
           FROM rpa_tasks AS task
           JOIN app_users AS actor ON actor.id = $2
          WHERE task.id = $1`,
        [current.rpaTaskId, current.requestedByUserId]
      );
      const auditContext = auditContexts[0] || {};
      const auditLogId = await addAudit(client, {
        taskId: current.rpaTaskId,
        actorUserId: current.requestedByUserId,
        action: 'run_now',
        newValue: withAdminAudit({
          task_uuid: execution.taskUuid,
          idempotent_uuid: current.idempotentUuid,
          run_request_status: 'succeeded',
          recovered,
        }, {
          userId: current.requestedByUserId,
          isAdmin: auditContext.is_admin,
        }, auditContext.owner_user_id),
      });
      if (auditLogId == null) throw new Error('立即执行审计记录写入失败');
      const saved = await runRequests.markSucceeded(current.idempotentUuid, {
        taskUuid: execution.taskUuid,
        jobUuidList: execution.jobUuidList || [],
        auditLogId,
        completedAt: attemptedAt,
      }, { executor: client });
      if (!saved) throw new Error('立即执行请求完成状态写入失败');

      const normalizedStatus = execution.normalizedStatus || EXECUTION_STATUS.WAITING;
      return {
        response: {
          success: true,
          task_uuid: execution.taskUuid,
          job_uuid_list: execution.jobUuidList || [],
          normalized_status: normalizedStatus,
        },
        pollingExecution: {
          taskUuid: execution.taskUuid,
          rpaTaskId: current.rpaTaskId,
          scheduleUuidAtRun: current.scheduleUuidAtRun,
          normalizedStatus,
          rawStatus: execution.rawStatus || (recovered ? null : 'created'),
          rawStatusName: execution.rawStatusName || (recovered ? null : '已创建'),
          triggerTime: execution.triggerTime || attemptedAt.toISOString(),
          updatedTime: execution.updatedTime || attemptedAt.toISOString(),
          jobUuidList: execution.jobUuidList || [],
          sourceType: 'api',
          clients: execution.clients || [],
          idempotentUuid: current.idempotentUuid,
          startedByUserId: current.requestedByUserId,
        },
      };
    });
  }

  async function dispatchRunRequest(runRequest) {
    const attemptedAt = timestampAfter(runRequest.scheduleBoundAtAtRequest, now());
    const claim = await claimRunRequest(runRequest, attemptedAt);
    if (claim.kind === 'rejected' || claim.kind === 'deferred') throw claim.error;
    if (claim.kind === 'succeeded') {
      return {
        success: true,
        task_uuid: claim.request.taskUuid,
        job_uuid_list: claim.request.jobUuidList,
        normalized_status: EXECUTION_STATUS.WAITING,
      };
    }

    let execution;
    let requestForFinalize = claim.request;
    let recovered = false;
    if (claim.kind === 'accepted' || claim.kind === 'existing') {
      recovered = true;
      execution = claim.kind === 'accepted'
        ? claim.execution
        : {
            taskUuid: claim.execution.task_uuid,
            jobUuidList: claim.execution.job_uuid_list || [],
            normalizedStatus: claim.execution.normalized_status,
            triggerTime: claim.execution.trigger_time,
            updatedTime: claim.execution.updated_time,
          };
    } else {
      let result;
      try {
        // No database transaction or task-row lock is held across this call.
        result = await yingdaoClient.startTask(claim.request.scheduleUuidAtRun, {
          idempotentUuid: claim.request.idempotentUuid,
        });
        const taskUuid = result && (result.task_uuid || result.taskUuid);
        if (!taskUuid) throw new Error('影刀未返回 taskUuid');
        execution = {
          taskUuid,
          jobUuidList: result && (result.job_uuid_list || result.jobUuidList) || [],
          normalizedStatus: EXECUTION_STATUS.WAITING,
        };
        requestForFinalize = await runRequests.markRemoteAccepted(claim.request.idempotentUuid, {
          taskUuid: execution.taskUuid,
          jobUuidList: execution.jobUuidList,
        });
        if (!requestForFinalize) {
          throw new ConflictError(
            'RUN_REQUEST_STATE_CONFLICT',
            '影刀已受理，但立即执行请求状态已发生变化'
          );
        }
      } catch (error) {
        await recordRunFailure(
          claim.request,
          error,
          attemptedAt,
          isDefinitiveUpstreamRejection(error)
        );
        throw databaseError(error);
      }
    }

    let completed;
    try {
      completed = await finalizeRunRequest(requestForFinalize, execution, attemptedAt, { recovered });
    } catch (error) {
      await recordRunFailure(requestForFinalize, error, attemptedAt, false);
      throw databaseError(error);
    }

    if (completed.pollingExecution && pollingCoordinator && pollingCoordinator.trackExecution) {
      Promise.resolve()
        .then(() => pollingCoordinator.trackExecution(completed.pollingExecution))
        .catch(() => undefined);
    }
    return completed.response;
  }

  async function runNow(actor, taskId) {
    const taskKey = String(taskId);
    if (runningLocks.has(taskKey)) {
      throw new ConflictError('TASK_ALREADY_ACTIVE', '任务正在启动或运行中');
    }
    const promise = prepareRunRequest(actor, taskId).then(dispatchRunRequest);
    runningLocks.set(taskKey, promise);
    try {
      return await promise;
    } finally {
      if (runningLocks.get(taskKey) === promise) runningLocks.delete(taskKey);
    }
  }

  async function recoverPendingRuns({ limit = RECOVERY_BATCH_SIZE } = {}) {
    if (recoveryFlight) return recoveryFlight;
    recoveryFlight = (async () => {
      const pending = await runRequests.listPendingDue({
        limit,
        now: now(),
        dispatchLeaseMs,
      });
      let succeeded = 0;
      let failed = 0;
      for (const request of pending) {
        const taskKey = String(request.rpaTaskId);
        if (runningLocks.has(taskKey)) continue;
        const promise = dispatchRunRequest(request);
        runningLocks.set(taskKey, promise);
        try {
          await promise;
          succeeded += 1;
        } catch (error) {
          failed += 1;
          if (logger && typeof logger.warn === 'function') {
            logger.warn('待恢复的立即执行请求仍未完成', {
              idempotentUuid: request.idempotentUuid,
              error: safeErrorMessage(error),
            });
          }
        } finally {
          if (runningLocks.get(taskKey) === promise) runningLocks.delete(taskKey);
        }
      }
      return { scanned: pending.length, succeeded, failed };
    })().finally(() => {
      recoveryFlight = null;
    });
    return recoveryFlight;
  }

  function start({ runImmediately = true } = {}) {
    if (recoveryTimer) return;
    if (runImmediately) {
      Promise.resolve().then(() => recoverPendingRuns()).catch(error => {
        if (logger && typeof logger.error === 'function') {
          logger.error('立即执行恢复扫描失败', { error: safeErrorMessage(error) });
        }
      });
    }
    recoveryTimer = setInterval(() => {
      recoverPendingRuns().catch(error => {
        if (logger && typeof logger.error === 'function') {
          logger.error('立即执行恢复扫描失败', { error: safeErrorMessage(error) });
        }
      });
    }, recoveryIntervalMs);
    if (typeof recoveryTimer.unref === 'function') recoveryTimer.unref();
  }

  function stop() {
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = null;
  }

  return { rebind, transfer, recover, runNow, recoverPendingRuns, start, stop };
}

module.exports = { createTaskActionService };
