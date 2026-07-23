const { EXECUTION_STATUS } = require('./services/executionStatus.cjs');
const { sanitizeForLog } = require('./services/yingdaoClient.cjs');

function pick(value, ...keys) {
  for (const key of keys) {
    if (value && value[key] !== undefined) return value[key];
  }
  return undefined;
}

function presentUser(user) {
  if (!user) return null;
  return {
    id: String(user.id),
    display_name: pick(user, 'display_name', 'displayName') || '',
    avatar_url: pick(user, 'avatar_url', 'avatarUrl') || null,
    auth_provider: pick(user, 'auth_provider', 'authProvider'),
    is_active: pick(user, 'is_active', 'isActive'),
    last_login_at: pick(user, 'last_login_at', 'lastLoginAt') || null,
  };
}

function presentTask(task) {
  if (!task) return null;
  return {
    id: String(task.id),
    task: task.task,
    start: pick(task, 'start', 'start_time'),
    finish: pick(task, 'finish', 'finish_time'),
    bot: task.bot,
    tags: Array.isArray(task.tags) ? task.tags : [],
    note: task.note || '',
    created_by_user_id: pick(task, 'created_by_user_id', 'createdByUserId') || null,
    owner_user_id: pick(task, 'owner_user_id', 'ownerUserId') || null,
    schedule_uuid: pick(task, 'schedule_uuid', 'scheduleUuid') || null,
    schedule_bound_at: pick(task, 'schedule_bound_at', 'scheduleBoundAt') || null,
    version: Number(task.version || 1),
    last_synced_at: pick(task, 'last_synced_at', 'lastSyncedAt') || null,
    sync_error: pick(task, 'sync_error', 'syncError') || null,
    created_at: pick(task, 'created_at', 'createdAt') || null,
    updated_at: pick(task, 'updated_at', 'updatedAt') || null,
    owner: presentUser(task.owner),
    created_by: presentUser(pick(task, 'created_by', 'createdBy')),
    can_edit: Boolean(pick(task, 'can_edit', 'canEdit')),
    is_legacy_unbound: Boolean(pick(task, 'is_legacy_unbound', 'isLegacyUnbound')),
    normalized_status: pick(task, 'normalized_status', 'current_status', 'currentStatus') || EXECUTION_STATUS.NOT_RUN,
    last_run_at: pick(task, 'last_run_at', 'lastRunAt') || null,
  };
}

function presentExecution(execution) {
  if (!execution) return null;
  const safe = sanitizeForLog(execution);
  return {
    task_uuid: pick(safe, 'task_uuid', 'taskUuid'),
    rpa_task_id: pick(safe, 'rpa_task_id', 'rpaTaskId'),
    schedule_uuid_at_run: pick(safe, 'schedule_uuid_at_run', 'scheduleUuidAtRun'),
    normalized_status: pick(safe, 'normalized_status', 'normalizedStatus'),
    raw_status: pick(safe, 'raw_status', 'rawStatus') || null,
    raw_status_name: pick(safe, 'raw_status_name', 'rawStatusName') || null,
    trigger_time: pick(safe, 'trigger_time', 'triggerTime') || null,
    updated_time: pick(safe, 'updated_time', 'updatedTime') || null,
    end_time: pick(safe, 'end_time', 'endTime') || null,
    job_uuid_list: pick(safe, 'job_uuid_list', 'jobUuidList') || [],
    source_type: pick(safe, 'source_type', 'sourceType') || null,
    clients: safe.clients || null,
    error_remark: pick(safe, 'error_remark', 'errorRemark') || null,
    synced_at: pick(safe, 'synced_at', 'syncedAt') || null,
  };
}

module.exports = { presentUser, presentTask, presentExecution };
