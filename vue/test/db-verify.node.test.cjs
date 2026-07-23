const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { discoverMigrations } = require('../server/db/migrations.cjs');

const verifyPath = path.resolve(__dirname, '..', 'storage', 'operations', 'verify.sql');
const verifySql = fs.readFileSync(verifyPath, 'utf8');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('verify.sql is fail-fast and executes entirely inside a read-only transaction', () => {
  assert.match(verifySql, /^\\set ON_ERROR_STOP on\s*$/m);
  assert.match(verifySql, /BEGIN;\s*SET TRANSACTION READ ONLY;/);
  assert.match(verifySql, /COMMIT;\s*$/);

  assert.doesNotMatch(
    verifySql,
    /^\s*(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|COPY|GRANT|REVOKE)\b/im
  );
  assert.doesNotMatch(verifySql, /VALIDATE\s+CONSTRAINT/i);
});

test('verify.sql pins the exact ordered migration names and repository checksums', () => {
  const migrations = discoverMigrations();
  assert.deepEqual(migrations.map(item => item.version), [1, 2, 3, 4, 5, 6]);

  for (const migration of migrations) {
    assert.match(
      verifySql,
      new RegExp(
        `\\(${migration.version},\\s*'${escapeRegExp(migration.name)}',\\s*'${migration.checksum}'\\)`
      )
    );
  }

  assert.ok((verifySql.match(/\bEXCEPT\b/g) || []).length >= 2);
});

test('verify.sql covers every durable table, explicit index, and updated_at trigger', () => {
  for (const table of [
    'schema_migrations',
    'app_users',
    'rpa_tasks',
    'rpa_task_binding_history',
    'rpa_task_executions',
    'rpa_task_audit_log',
    'rpa_task_run_requests',
    'app_sessions',
  ]) {
    assert.match(verifySql, new RegExp(`'${table}'`));
  }

  for (const index of [
    'uq_app_users_feishu_union_id',
    'uq_app_users_feishu_tenant_open_id',
    'idx_app_users_active_provider',
    'uq_rpa_tasks_active_schedule_uuid',
    'idx_rpa_tasks_owner_active',
    'idx_rpa_tasks_created_by_user',
    'idx_rpa_tasks_deleted_at',
    'idx_rpa_tasks_bot',
    'idx_rpa_tasks_tags_gin',
    'uq_rpa_task_binding_history_active_task',
    'uq_rpa_task_binding_history_active_schedule',
    'idx_rpa_task_binding_history_task_time',
    'idx_rpa_task_binding_history_schedule_time',
    'uq_rpa_task_executions_idempotent_uuid',
    'idx_rpa_task_executions_task_trigger',
    'idx_rpa_task_executions_schedule_trigger',
    'idx_rpa_task_executions_active',
    'idx_rpa_task_executions_retention',
    'idx_rpa_task_audit_log_task_created',
    'idx_rpa_task_audit_log_actor_created',
    'idx_app_sessions_expire',
    'uq_rpa_task_run_requests_open_task',
    'idx_rpa_task_run_requests_pending_retry',
    'idx_rpa_task_run_requests_task_created',
  ]) {
    assert.match(verifySql, new RegExp(`'${index}'`));
  }

  assert.match(verifySql, /procedure\.prorettype = 'trigger'::regtype/);
  for (const trigger of [
    'trg_app_users_updated_at',
    'trg_rpa_tasks_updated_at',
    'trg_rpa_task_run_requests_updated_at',
  ]) {
    assert.match(verifySql, new RegExp(`'${trigger}'`));
  }
});

test('verify.sql checks critical field types and defaults from migrations 001-006', () => {
  for (const tuple of [
    "('app_users', 'auth_provider', 'text', TRUE, '', '''dev''::text')",
    "('rpa_tasks', 'start_time', 'character varying(8)', TRUE, '', '''00:00:00''::character varying')",
    "('rpa_tasks', 'finish_time', 'character varying(8)', TRUE, '', '''00:00:00''::character varying')",
    "('rpa_tasks', 'version', 'integer', TRUE, '', '1')",
    "('rpa_tasks', 'sync_generation', 'bigint', TRUE, '', '0')",
    "('rpa_task_executions', 'job_uuid_list', 'jsonb', TRUE, '', '''[]''::jsonb')",
    "('rpa_task_audit_log', 'action', 'text', TRUE, '', NULL)",
    "('rpa_task_run_requests', 'status', 'text', TRUE, '', '''pending''::text')",
    "('rpa_task_run_requests', 'job_uuid_list', 'jsonb', TRUE, '', '''[]''::jsonb')",
    "('app_sessions', 'expire', 'timestamp(6) without time zone', TRUE, '', NULL)",
  ]) {
    assert.ok(verifySql.includes(tuple), `missing catalog assertion: ${tuple}`);
  }
});

test('verify.sql requires all eight NOT VALID checks and scans current rows for violations', () => {
  const expectedChecks = [
    'ck_app_users_auth_provider',
    'ck_rpa_tasks_version_positive',
    'ck_rpa_tasks_start_time_format',
    'ck_rpa_tasks_finish_time_format',
    'ck_rpa_tasks_binding_pair',
    'ck_rpa_task_executions_normalized_status',
    'ck_rpa_task_executions_job_uuid_list_array',
    'ck_rpa_task_audit_log_action',
  ];
  const catalogChecks = [...verifySql.matchAll(/\('[^']+', '(ck_[^']+)', 'c', FALSE,/g)]
    .map(match => match[1]);

  assert.deepEqual([...catalogChecks].sort(), [...expectedChecks].sort());
  for (const constraint of expectedChecks) {
    assert.match(
      verifySql,
      new RegExp(`SELECT '${escapeRegExp(constraint)}'(?: AS constraint_name)?\\s+WHERE EXISTS`)
    );
  }
});
