function toApiId(value) {
  return value == null ? null : String(value);
}

function toIsoString(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function timestampAfter(value, candidate = new Date()) {
  const candidateDate = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(candidateDate.getTime())) throw new TypeError('candidate must be a valid timestamp');
  if (value == null) return candidateDate;
  const previous = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(previous.getTime())) return candidateDate;
  // node-postgres exposes timestamptz as a millisecond-precision Date while
  // PostgreSQL may retain microseconds. Moving at least one full millisecond
  // past the exposed value guarantees the new event is not before the stored
  // binding boundary.
  return new Date(Math.max(candidateDate.getTime(), previous.getTime() + 1));
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const result = [];
  for (const value of tags) {
    const tag = String(value == null ? '' : value).trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: toApiId(row.id),
    displayName: row.display_name,
    avatarUrl: row.avatar_url || null,
    authProvider: row.auth_provider,
    feishuOpenId: row.feishu_open_id || null,
    feishuUnionId: row.feishu_union_id || null,
    feishuTenantKey: row.feishu_tenant_key || null,
    isActive: Boolean(row.is_active),
    isAdmin: Boolean(row.is_admin),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    lastLoginAt: toIsoString(row.last_login_at),
  };
}

function mapEmbeddedUser(row, prefix) {
  const id = row[`${prefix}_id`];
  if (id == null) return null;
  return {
    id: toApiId(id),
    displayName: row[`${prefix}_display_name`],
    avatarUrl: row[`${prefix}_avatar_url`] || null,
  };
}

function mapTaskRow(row) {
  if (!row) return null;
  return {
    id: toApiId(row.id),
    task: row.task,
    start: row.start_time != null ? row.start_time : row.start,
    finish: row.finish_time != null ? row.finish_time : row.finish,
    bot: row.bot,
    createdByUserId: toApiId(row.created_by_user_id),
    ownerUserId: toApiId(row.owner_user_id),
    scheduleUuid: row.schedule_uuid || null,
    scheduleBoundAt: toIsoString(row.schedule_bound_at),
    tags: Array.isArray(row.tags) ? [...row.tags] : [],
    note: row.note || '',
    version: Number(row.version || 1),
    lastSyncedAt: toIsoString(row.last_synced_at),
    syncError: row.sync_error || null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    deletedAt: toIsoString(row.deleted_at),
    owner: mapEmbeddedUser(row, 'owner'),
    createdBy: mapEmbeddedUser(row, 'created_by'),
    canEdit: row.can_edit == null ? undefined : Boolean(row.can_edit),
    isLegacyUnbound: row.is_legacy_unbound == null
      ? row.owner_user_id == null || row.schedule_uuid == null
      : Boolean(row.is_legacy_unbound),
    currentStatus: row.current_status || '待运行',
    lastRunAt: toIsoString(row.last_run_at),
  };
}

function mapExecutionRow(row) {
  if (!row) return null;
  return {
    taskUuid: row.task_uuid,
    rpaTaskId: toApiId(row.rpa_task_id),
    scheduleUuidAtRun: row.schedule_uuid_at_run,
    normalizedStatus: row.normalized_status,
    rawStatus: row.raw_status || null,
    rawStatusName: row.raw_status_name || null,
    triggerTime: toIsoString(row.trigger_time),
    updatedTime: toIsoString(row.updated_time),
    endTime: toIsoString(row.end_time),
    jobUuidList: Array.isArray(row.job_uuid_list) ? row.job_uuid_list : [],
    sourceType: row.source_type || null,
    clients: row.clients == null ? null : row.clients,
    errorRemark: row.error_remark || null,
    syncedAt: toIsoString(row.synced_at),
    idempotentUuid: row.idempotent_uuid == null ? null : String(row.idempotent_uuid),
    startedByUserId: toApiId(row.started_by_user_id),
    createdAt: toIsoString(row.created_at),
  };
}

function mapRunRequestRow(row) {
  if (!row) return null;
  return {
    idempotentUuid: row.idempotent_uuid == null ? null : String(row.idempotent_uuid),
    rpaTaskId: toApiId(row.rpa_task_id),
    scheduleUuidAtRun: row.schedule_uuid_at_run,
    scheduleBoundAtAtRequest: toIsoString(row.schedule_bound_at_at_request),
    requestedByUserId: toApiId(row.requested_by_user_id),
    status: row.status,
    taskUuid: row.task_uuid || null,
    jobUuidList: Array.isArray(row.job_uuid_list) ? row.job_uuid_list : [],
    auditLogId: toApiId(row.audit_log_id),
    attemptCount: Number(row.attempt_count || 0),
    lastAttemptAt: toIsoString(row.last_attempt_at),
    nextAttemptAt: toIsoString(row.next_attempt_at),
    lastError: row.last_error || null,
    completedAt: toIsoString(row.completed_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapAuditRow(row) {
  if (!row) return null;
  return {
    id: toApiId(row.id),
    taskId: toApiId(row.task_id),
    actorUserId: toApiId(row.actor_user_id),
    action: row.action,
    oldValue: row.old_value == null ? null : row.old_value,
    newValue: row.new_value == null ? null : row.new_value,
    createdAt: toIsoString(row.created_at),
  };
}

module.exports = {
  toApiId,
  toIsoString,
  timestampAfter,
  normalizeTags,
  mapUserRow,
  mapTaskRow,
  mapExecutionRow,
  mapRunRequestRow,
  mapAuditRow,
};
