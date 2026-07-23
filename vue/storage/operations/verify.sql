\set ON_ERROR_STOP on

-- Verification is deliberately enclosed in a read-only transaction. Catalog
-- inspection and data consistency checks must never mutate the target database.
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL quote_all_identifiers TO off;

DO $verify$
DECLARE
  issue TEXT;
BEGIN
  WITH expected(table_name) AS (
    VALUES
      ('schema_migrations'),
      ('app_users'),
      ('rpa_tasks'),
      ('rpa_task_binding_history'),
      ('rpa_task_executions'),
      ('rpa_task_audit_log'),
      ('rpa_task_run_requests'),
      ('app_sessions')
  )
  SELECT string_agg(format('public.%I', expected.table_name), ', ' ORDER BY expected.table_name)
    INTO issue
    FROM expected
    LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
    LEFT JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = expected.table_name
     AND relation.relkind = 'r'
   WHERE relation.oid IS NULL;

  IF issue IS NOT NULL THEN
    RAISE EXCEPTION '缺少必需的数据表：%', issue;
  END IF;

  WITH expected(
    table_name,
    column_name,
    type_name,
    is_not_null,
    identity_kind,
    default_expression
  ) AS (
    VALUES
      ('schema_migrations', 'version', 'integer', TRUE, '', NULL),
      ('schema_migrations', 'name', 'text', TRUE, '', NULL),
      ('schema_migrations', 'checksum', 'character(64)', TRUE, '', NULL),
      ('schema_migrations', 'applied_at', 'timestamp with time zone', TRUE, '', 'now()'),

      ('app_users', 'id', 'bigint', TRUE, 'd', NULL),
      ('app_users', 'display_name', 'text', TRUE, '', NULL),
      ('app_users', 'avatar_url', 'text', FALSE, '', NULL),
      ('app_users', 'auth_provider', 'text', TRUE, '', '''dev''::text'),
      ('app_users', 'feishu_open_id', 'text', FALSE, '', NULL),
      ('app_users', 'feishu_union_id', 'text', FALSE, '', NULL),
      ('app_users', 'feishu_tenant_key', 'text', FALSE, '', NULL),
      ('app_users', 'is_active', 'boolean', TRUE, '', 'true'),
      ('app_users', 'is_admin', 'boolean', TRUE, '', 'false'),
      ('app_users', 'created_at', 'timestamp with time zone', TRUE, '', 'now()'),
      ('app_users', 'updated_at', 'timestamp with time zone', TRUE, '', 'now()'),
      ('app_users', 'last_login_at', 'timestamp with time zone', FALSE, '', NULL),

      ('rpa_tasks', 'id', 'bigint', TRUE, 'd', NULL),
      ('rpa_tasks', 'task', 'text', TRUE, '', NULL),
      ('rpa_tasks', 'start_time', 'character varying(8)', TRUE, '', '''00:00:00''::character varying'),
      ('rpa_tasks', 'finish_time', 'character varying(8)', TRUE, '', '''00:00:00''::character varying'),
      ('rpa_tasks', 'bot', 'text', TRUE, '', '''未分类''::text'),
      ('rpa_tasks', 'created_by_user_id', 'bigint', FALSE, '', NULL),
      ('rpa_tasks', 'owner_user_id', 'bigint', FALSE, '', NULL),
      ('rpa_tasks', 'schedule_uuid', 'text', FALSE, '', NULL),
      ('rpa_tasks', 'schedule_bound_at', 'timestamp with time zone', FALSE, '', NULL),
      ('rpa_tasks', 'tags', 'text[]', TRUE, '', 'ARRAY[]::text[]'),
      ('rpa_tasks', 'note', 'text', TRUE, '', '''''::text'),
      ('rpa_tasks', 'version', 'integer', TRUE, '', '1'),
      ('rpa_tasks', 'last_synced_at', 'timestamp with time zone', FALSE, '', NULL),
      ('rpa_tasks', 'sync_error', 'text', FALSE, '', NULL),
      ('rpa_tasks', 'created_at', 'timestamp with time zone', TRUE, '', 'now()'),
      ('rpa_tasks', 'updated_at', 'timestamp with time zone', TRUE, '', 'now()'),
      ('rpa_tasks', 'deleted_at', 'timestamp with time zone', FALSE, '', NULL),
      ('rpa_tasks', 'sync_generation', 'bigint', TRUE, '', '0'),

      ('rpa_task_binding_history', 'id', 'bigint', TRUE, 'd', NULL),
      ('rpa_task_binding_history', 'rpa_task_id', 'bigint', TRUE, '', NULL),
      ('rpa_task_binding_history', 'schedule_uuid', 'text', TRUE, '', NULL),
      ('rpa_task_binding_history', 'bound_at', 'timestamp with time zone', TRUE, '', NULL),
      ('rpa_task_binding_history', 'unbound_at', 'timestamp with time zone', FALSE, '', NULL),
      ('rpa_task_binding_history', 'actor_user_id', 'bigint', FALSE, '', NULL),
      ('rpa_task_binding_history', 'created_at', 'timestamp with time zone', TRUE, '', 'now()'),

      ('rpa_task_executions', 'task_uuid', 'text', TRUE, '', NULL),
      ('rpa_task_executions', 'rpa_task_id', 'bigint', TRUE, '', NULL),
      ('rpa_task_executions', 'schedule_uuid_at_run', 'text', TRUE, '', NULL),
      ('rpa_task_executions', 'normalized_status', 'text', TRUE, '', '''未知状态''::text'),
      ('rpa_task_executions', 'raw_status', 'text', FALSE, '', NULL),
      ('rpa_task_executions', 'raw_status_name', 'text', FALSE, '', NULL),
      ('rpa_task_executions', 'trigger_time', 'timestamp with time zone', TRUE, '', NULL),
      ('rpa_task_executions', 'updated_time', 'timestamp with time zone', FALSE, '', NULL),
      ('rpa_task_executions', 'end_time', 'timestamp with time zone', FALSE, '', NULL),
      ('rpa_task_executions', 'job_uuid_list', 'jsonb', TRUE, '', '''[]''::jsonb'),
      ('rpa_task_executions', 'source_type', 'text', FALSE, '', NULL),
      ('rpa_task_executions', 'clients', 'jsonb', FALSE, '', NULL),
      ('rpa_task_executions', 'error_remark', 'text', FALSE, '', NULL),
      ('rpa_task_executions', 'synced_at', 'timestamp with time zone', TRUE, '', 'now()'),
      ('rpa_task_executions', 'idempotent_uuid', 'uuid', FALSE, '', NULL),
      ('rpa_task_executions', 'started_by_user_id', 'bigint', FALSE, '', NULL),
      ('rpa_task_executions', 'created_at', 'timestamp with time zone', TRUE, '', 'now()'),

      ('rpa_task_audit_log', 'id', 'bigint', TRUE, 'd', NULL),
      ('rpa_task_audit_log', 'task_id', 'bigint', TRUE, '', NULL),
      ('rpa_task_audit_log', 'actor_user_id', 'bigint', FALSE, '', NULL),
      ('rpa_task_audit_log', 'action', 'text', TRUE, '', NULL),
      ('rpa_task_audit_log', 'old_value', 'jsonb', FALSE, '', NULL),
      ('rpa_task_audit_log', 'new_value', 'jsonb', FALSE, '', NULL),
      ('rpa_task_audit_log', 'created_at', 'timestamp with time zone', TRUE, '', 'now()'),

      ('rpa_task_run_requests', 'idempotent_uuid', 'uuid', TRUE, '', NULL),
      ('rpa_task_run_requests', 'rpa_task_id', 'bigint', TRUE, '', NULL),
      ('rpa_task_run_requests', 'schedule_uuid_at_run', 'text', TRUE, '', NULL),
      ('rpa_task_run_requests', 'schedule_bound_at_at_request', 'timestamp with time zone', TRUE, '', NULL),
      ('rpa_task_run_requests', 'requested_by_user_id', 'bigint', TRUE, '', NULL),
      ('rpa_task_run_requests', 'status', 'text', TRUE, '', '''pending''::text'),
      ('rpa_task_run_requests', 'task_uuid', 'text', FALSE, '', NULL),
      ('rpa_task_run_requests', 'job_uuid_list', 'jsonb', TRUE, '', '''[]''::jsonb'),
      ('rpa_task_run_requests', 'audit_log_id', 'bigint', FALSE, '', NULL),
      ('rpa_task_run_requests', 'attempt_count', 'integer', TRUE, '', '0'),
      ('rpa_task_run_requests', 'last_attempt_at', 'timestamp with time zone', FALSE, '', NULL),
      ('rpa_task_run_requests', 'next_attempt_at', 'timestamp with time zone', FALSE, '', NULL),
      ('rpa_task_run_requests', 'last_error', 'text', FALSE, '', NULL),
      ('rpa_task_run_requests', 'completed_at', 'timestamp with time zone', FALSE, '', NULL),
      ('rpa_task_run_requests', 'created_at', 'timestamp with time zone', TRUE, '', 'now()'),
      ('rpa_task_run_requests', 'updated_at', 'timestamp with time zone', TRUE, '', 'now()'),

      ('app_sessions', 'sid', 'character varying', TRUE, '', NULL),
      ('app_sessions', 'sess', 'json', TRUE, '', NULL),
      ('app_sessions', 'expire', 'timestamp(6) without time zone', TRUE, '', NULL)
  )
  SELECT string_agg(
           format(
             'public.%I.%I(expected type=%s, not_null=%s, identity=%s, default=%s)',
             expected.table_name,
             expected.column_name,
             expected.type_name,
             expected.is_not_null,
             NULLIF(expected.identity_kind, ''),
             expected.default_expression
           ),
           ', '
           ORDER BY expected.table_name, expected.column_name
         )
    INTO issue
    FROM expected
    JOIN pg_namespace namespace ON namespace.nspname = 'public'
    JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = expected.table_name
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attname = expected.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = relation.oid
     AND default_value.adnum = attribute.attnum
   WHERE attribute.attnum IS NULL
      OR format_type(attribute.atttypid, attribute.atttypmod) IS DISTINCT FROM expected.type_name
      OR attribute.attnotnull IS DISTINCT FROM expected.is_not_null
      OR attribute.attidentity::TEXT IS DISTINCT FROM expected.identity_kind
      OR pg_get_expr(default_value.adbin, default_value.adrelid) IS DISTINCT FROM expected.default_expression;

  IF issue IS NOT NULL THEN
    RAISE EXCEPTION '关键字段定义缺失或不匹配：%', issue;
  END IF;

  WITH expected(version, name, checksum) AS (
    VALUES
      (1, '001_add_users_and_task_ownership.sql', 'c075042c15624ff876a2b690fba16a97ea8e7608564a159fb25e9450d2c4b7f2'),
      (2, '002_add_executions_and_binding_history.sql', 'a7ac23418c0a5e5d91a9aca9018551bb0df14db522634c61d558eb6f13d4436c'),
      (3, '003_add_audit_and_sessions.sql', '9db862eebac53e2eccbd38946c7e9c0e9a9794f0d0cf382022fb43990af3c875'),
      (4, '004_finalize_postgres_only_schema.sql', '98ba7f05055bf6b886605f6da3edcc71f66d4c3d2b9fce124d33de834dd190df'),
      (5, '005_add_durable_run_requests.sql', 'c6e6b76cb0d7d8cd51453f88bdb0b7ba1531b28928e7ef89b064926b6d339737'),
      (6, '006_add_binding_scoped_sync_generation.sql', '60168641cc15991754ab058d321cec2176c01daddbf057cc2cf4a5a0acb7e12d'),
      (7, '007_add_admin_permission.sql', 'a4e8ac1df160e4ef9386b48707760f632a82b763009c2a5c5276545d0f01fe57')
  ), mismatches AS (
    (
      SELECT version, name, checksum::TEXT AS checksum
        FROM public.schema_migrations
      EXCEPT
      SELECT version, name, checksum
        FROM expected
    )
    UNION ALL
    (
      SELECT version, name, checksum
        FROM expected
      EXCEPT
      SELECT version, name, checksum::TEXT AS checksum
        FROM public.schema_migrations
    )
  )
  SELECT string_agg(format('version=%s name=%s checksum=%s', version, name, checksum), '; ' ORDER BY version, name)
    INTO issue
    FROM mismatches;

  IF issue IS NOT NULL THEN
    RAISE EXCEPTION 'schema_migrations 与仓库 001-007 不一致：%', issue;
  END IF;

  WITH expected(table_name, index_name, is_unique, access_method, is_partial) AS (
    VALUES
      ('app_users', 'uq_app_users_feishu_union_id', TRUE, 'btree', TRUE),
      ('app_users', 'uq_app_users_feishu_tenant_open_id', TRUE, 'btree', TRUE),
      ('app_users', 'idx_app_users_active_provider', FALSE, 'btree', FALSE),
      ('rpa_tasks', 'uq_rpa_tasks_active_schedule_uuid', TRUE, 'btree', TRUE),
      ('rpa_tasks', 'idx_rpa_tasks_owner_active', FALSE, 'btree', TRUE),
      ('rpa_tasks', 'idx_rpa_tasks_created_by_user', FALSE, 'btree', FALSE),
      ('rpa_tasks', 'idx_rpa_tasks_deleted_at', FALSE, 'btree', FALSE),
      ('rpa_tasks', 'idx_rpa_tasks_bot', FALSE, 'btree', FALSE),
      ('rpa_tasks', 'idx_rpa_tasks_tags_gin', FALSE, 'gin', FALSE),
      ('rpa_task_binding_history', 'uq_rpa_task_binding_history_active_task', TRUE, 'btree', TRUE),
      ('rpa_task_binding_history', 'uq_rpa_task_binding_history_active_schedule', TRUE, 'btree', TRUE),
      ('rpa_task_binding_history', 'idx_rpa_task_binding_history_task_time', FALSE, 'btree', FALSE),
      ('rpa_task_binding_history', 'idx_rpa_task_binding_history_schedule_time', FALSE, 'btree', FALSE),
      ('rpa_task_executions', 'uq_rpa_task_executions_idempotent_uuid', TRUE, 'btree', TRUE),
      ('rpa_task_executions', 'idx_rpa_task_executions_task_trigger', FALSE, 'btree', FALSE),
      ('rpa_task_executions', 'idx_rpa_task_executions_schedule_trigger', FALSE, 'btree', FALSE),
      ('rpa_task_executions', 'idx_rpa_task_executions_active', FALSE, 'btree', TRUE),
      ('rpa_task_executions', 'idx_rpa_task_executions_retention', FALSE, 'btree', FALSE),
      ('rpa_task_audit_log', 'idx_rpa_task_audit_log_task_created', FALSE, 'btree', FALSE),
      ('rpa_task_audit_log', 'idx_rpa_task_audit_log_actor_created', FALSE, 'btree', FALSE),
      ('app_sessions', 'idx_app_sessions_expire', FALSE, 'btree', FALSE),
      ('rpa_task_run_requests', 'uq_rpa_task_run_requests_open_task', TRUE, 'btree', TRUE),
      ('rpa_task_run_requests', 'idx_rpa_task_run_requests_pending_retry', FALSE, 'btree', TRUE),
      ('rpa_task_run_requests', 'idx_rpa_task_run_requests_task_created', FALSE, 'btree', FALSE)
  )
  SELECT string_agg(format('public.%I.%I', expected.table_name, expected.index_name), ', ' ORDER BY expected.table_name, expected.index_name)
    INTO issue
    FROM expected
    JOIN pg_namespace table_namespace ON table_namespace.nspname = 'public'
    JOIN pg_class table_relation
      ON table_relation.relnamespace = table_namespace.oid
     AND table_relation.relname = expected.table_name
    LEFT JOIN pg_class index_relation
      ON index_relation.relnamespace = table_namespace.oid
     AND index_relation.relname = expected.index_name
     AND index_relation.relkind = 'i'
    LEFT JOIN pg_index index_catalog
      ON index_catalog.indexrelid = index_relation.oid
     AND index_catalog.indrelid = table_relation.oid
    LEFT JOIN pg_am access_method ON access_method.oid = index_relation.relam
   WHERE index_relation.oid IS NULL
      OR index_catalog.indisunique IS DISTINCT FROM expected.is_unique
      OR access_method.amname IS DISTINCT FROM expected.access_method
      OR (index_catalog.indpred IS NOT NULL) IS DISTINCT FROM expected.is_partial
      OR NOT index_catalog.indisvalid
      OR NOT index_catalog.indisready
      OR NOT index_catalog.indislive;

  IF issue IS NOT NULL THEN
    RAISE EXCEPTION '关键索引缺失、无效或属性不匹配：%', issue;
  END IF;

  WITH expected(index_name, definition) AS (
    VALUES
      ('uq_app_users_feishu_union_id',
       'CREATE UNIQUE INDEX uq_app_users_feishu_union_id ON public.app_users USING btree (feishu_union_id) WHERE (feishu_union_id IS NOT NULL)'),
      ('uq_app_users_feishu_tenant_open_id',
       'CREATE UNIQUE INDEX uq_app_users_feishu_tenant_open_id ON public.app_users USING btree (feishu_tenant_key, feishu_open_id) WHERE ((feishu_tenant_key IS NOT NULL) AND (feishu_open_id IS NOT NULL))'),
      ('uq_rpa_tasks_active_schedule_uuid',
       'CREATE UNIQUE INDEX uq_rpa_tasks_active_schedule_uuid ON public.rpa_tasks USING btree (schedule_uuid) WHERE ((deleted_at IS NULL) AND (schedule_uuid IS NOT NULL))'),
      ('idx_rpa_tasks_owner_active',
       'CREATE INDEX idx_rpa_tasks_owner_active ON public.rpa_tasks USING btree (owner_user_id, updated_at DESC) WHERE (deleted_at IS NULL)'),
      ('idx_rpa_tasks_tags_gin',
       'CREATE INDEX idx_rpa_tasks_tags_gin ON public.rpa_tasks USING gin (tags)'),
      ('uq_rpa_task_binding_history_active_task',
       'CREATE UNIQUE INDEX uq_rpa_task_binding_history_active_task ON public.rpa_task_binding_history USING btree (rpa_task_id) WHERE (unbound_at IS NULL)'),
      ('uq_rpa_task_binding_history_active_schedule',
       'CREATE UNIQUE INDEX uq_rpa_task_binding_history_active_schedule ON public.rpa_task_binding_history USING btree (schedule_uuid) WHERE (unbound_at IS NULL)'),
      ('uq_rpa_task_executions_idempotent_uuid',
       'CREATE UNIQUE INDEX uq_rpa_task_executions_idempotent_uuid ON public.rpa_task_executions USING btree (idempotent_uuid) WHERE (idempotent_uuid IS NOT NULL)'),
      ('idx_rpa_task_executions_active',
       'CREATE INDEX idx_rpa_task_executions_active ON public.rpa_task_executions USING btree (rpa_task_id, updated_time DESC NULLS LAST) WHERE (normalized_status = ANY (ARRAY[''等待中''::text, ''运行中''::text, ''未知状态''::text]))'),
      ('idx_rpa_task_executions_retention',
       'CREATE INDEX idx_rpa_task_executions_retention ON public.rpa_task_executions USING btree (COALESCE(end_time, trigger_time))'),
      ('uq_rpa_task_run_requests_open_task',
       'CREATE UNIQUE INDEX uq_rpa_task_run_requests_open_task ON public.rpa_task_run_requests USING btree (rpa_task_id) WHERE (status = ANY (ARRAY[''pending''::text, ''dispatching''::text]))'),
      ('idx_rpa_task_run_requests_pending_retry',
       'CREATE INDEX idx_rpa_task_run_requests_pending_retry ON public.rpa_task_run_requests USING btree (COALESCE(next_attempt_at, created_at), created_at) WHERE (status = ''pending''::text)')
  )
  SELECT string_agg(expected.index_name, ', ' ORDER BY expected.index_name)
    INTO issue
    FROM expected
    JOIN pg_namespace namespace ON namespace.nspname = 'public'
    LEFT JOIN pg_class index_relation
      ON index_relation.relnamespace = namespace.oid
     AND index_relation.relname = expected.index_name
     AND index_relation.relkind = 'i'
   WHERE index_relation.oid IS NULL
      OR pg_get_indexdef(index_relation.oid) IS DISTINCT FROM expected.definition;

  IF issue IS NOT NULL THEN
    RAISE EXCEPTION '关键索引定义不匹配：%', issue;
  END IF;

  WITH expected(table_name, constraint_name, constraint_type, is_validated, definition) AS (
    VALUES
      ('schema_migrations', 'schema_migrations_pkey', 'p', TRUE, 'PRIMARY KEY (version)'),
      ('schema_migrations', 'schema_migrations_name_key', 'u', TRUE, 'UNIQUE (name)'),
      ('app_users', 'app_users_pkey', 'p', TRUE, 'PRIMARY KEY (id)'),
      ('app_users', 'ck_app_users_auth_provider', 'c', FALSE,
       'CHECK (auth_provider = ANY (ARRAY[''dev''::text, ''feishu''::text])) NOT VALID'),
      ('rpa_tasks', 'rpa_tasks_pkey', 'p', TRUE, 'PRIMARY KEY (id)'),
      ('rpa_tasks', 'fk_rpa_tasks_created_by_user', 'f', TRUE,
       'FOREIGN KEY (created_by_user_id) REFERENCES app_users(id) ON DELETE RESTRICT'),
      ('rpa_tasks', 'fk_rpa_tasks_owner_user', 'f', TRUE,
       'FOREIGN KEY (owner_user_id) REFERENCES app_users(id) ON DELETE RESTRICT'),
      ('rpa_tasks', 'ck_rpa_tasks_version_positive', 'c', FALSE,
       'CHECK (version >= 1) NOT VALID'),
      ('rpa_tasks', 'ck_rpa_tasks_start_time_format', 'c', FALSE,
       'CHECK (start_time::text ~ ''^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$''::text) NOT VALID'),
      ('rpa_tasks', 'ck_rpa_tasks_finish_time_format', 'c', FALSE,
       'CHECK (finish_time::text ~ ''^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$''::text) NOT VALID'),
      ('rpa_tasks', 'ck_rpa_tasks_binding_pair', 'c', FALSE,
       'CHECK ((schedule_uuid IS NULL) = (schedule_bound_at IS NULL)) NOT VALID'),
      ('rpa_tasks', 'ck_rpa_tasks_sync_generation_nonnegative', 'c', TRUE,
       'CHECK (sync_generation >= 0)'),
      ('rpa_task_binding_history', 'rpa_task_binding_history_pkey', 'p', TRUE,
       'PRIMARY KEY (id)'),
      ('rpa_task_binding_history', 'rpa_task_binding_history_rpa_task_id_fkey', 'f', TRUE,
       'FOREIGN KEY (rpa_task_id) REFERENCES rpa_tasks(id) ON DELETE RESTRICT'),
      ('rpa_task_binding_history', 'rpa_task_binding_history_actor_user_id_fkey', 'f', TRUE,
       'FOREIGN KEY (actor_user_id) REFERENCES app_users(id) ON DELETE RESTRICT'),
      ('rpa_task_binding_history', 'ck_rpa_task_binding_history_interval', 'c', TRUE,
       'CHECK (unbound_at IS NULL OR unbound_at >= bound_at)'),
      ('rpa_task_executions', 'rpa_task_executions_pkey', 'p', TRUE,
       'PRIMARY KEY (task_uuid)'),
      ('rpa_task_executions', 'rpa_task_executions_rpa_task_id_fkey', 'f', TRUE,
       'FOREIGN KEY (rpa_task_id) REFERENCES rpa_tasks(id) ON DELETE RESTRICT'),
      ('rpa_task_executions', 'rpa_task_executions_started_by_user_id_fkey', 'f', TRUE,
       'FOREIGN KEY (started_by_user_id) REFERENCES app_users(id) ON DELETE RESTRICT'),
      ('rpa_task_executions', 'ck_rpa_task_executions_normalized_status', 'c', FALSE,
       'CHECK (normalized_status = ANY (ARRAY[''等待中''::text, ''运行中''::text, ''等待超时''::text, ''运行超时''::text, ''运行成功''::text, ''运行失败''::text, ''已停止''::text, ''未知状态''::text])) NOT VALID'),
      ('rpa_task_executions', 'ck_rpa_task_executions_job_uuid_list_array', 'c', FALSE,
       'CHECK (jsonb_typeof(job_uuid_list) = ''array''::text) NOT VALID'),
      ('rpa_task_audit_log', 'rpa_task_audit_log_pkey', 'p', TRUE,
       'PRIMARY KEY (id)'),
      ('rpa_task_audit_log', 'rpa_task_audit_log_task_id_fkey', 'f', TRUE,
       'FOREIGN KEY (task_id) REFERENCES rpa_tasks(id) ON DELETE RESTRICT'),
      ('rpa_task_audit_log', 'rpa_task_audit_log_actor_user_id_fkey', 'f', TRUE,
       'FOREIGN KEY (actor_user_id) REFERENCES app_users(id) ON DELETE RESTRICT'),
      ('rpa_task_audit_log', 'ck_rpa_task_audit_log_action', 'c', FALSE,
       'CHECK (action = ANY (ARRAY[''create''::text, ''update''::text, ''delete''::text, ''rebind''::text, ''transfer''::text, ''import''::text, ''run_now''::text, ''admin_recover''::text])) NOT VALID'),
      ('rpa_task_run_requests', 'rpa_task_run_requests_pkey', 'p', TRUE,
       'PRIMARY KEY (idempotent_uuid)'),
      ('rpa_task_run_requests', 'rpa_task_run_requests_rpa_task_id_fkey', 'f', TRUE,
       'FOREIGN KEY (rpa_task_id) REFERENCES rpa_tasks(id) ON DELETE RESTRICT'),
      ('rpa_task_run_requests', 'rpa_task_run_requests_requested_by_user_id_fkey', 'f', TRUE,
       'FOREIGN KEY (requested_by_user_id) REFERENCES app_users(id) ON DELETE RESTRICT'),
      ('rpa_task_run_requests', 'rpa_task_run_requests_audit_log_id_fkey', 'f', TRUE,
       'FOREIGN KEY (audit_log_id) REFERENCES rpa_task_audit_log(id) ON DELETE RESTRICT'),
      ('rpa_task_run_requests', 'rpa_task_run_requests_task_uuid_key', 'u', TRUE,
       'UNIQUE (task_uuid)'),
      ('rpa_task_run_requests', 'rpa_task_run_requests_audit_log_id_key', 'u', TRUE,
       'UNIQUE (audit_log_id)'),
      ('rpa_task_run_requests', 'ck_rpa_task_run_requests_status', 'c', TRUE,
       'CHECK (status = ANY (ARRAY[''pending''::text, ''dispatching''::text, ''succeeded''::text, ''rejected''::text]))'),
      ('rpa_task_run_requests', 'ck_rpa_task_run_requests_job_uuid_list_array', 'c', TRUE,
       'CHECK (jsonb_typeof(job_uuid_list) = ''array''::text)'),
      ('rpa_task_run_requests', 'ck_rpa_task_run_requests_attempt_count', 'c', TRUE,
       'CHECK (attempt_count >= 0)'),
      ('rpa_task_run_requests', 'ck_rpa_task_run_requests_completion', 'c', TRUE,
       'CHECK (status = ''succeeded''::text AND task_uuid IS NOT NULL AND audit_log_id IS NOT NULL AND completed_at IS NOT NULL OR status = ''rejected''::text AND completed_at IS NOT NULL OR (status = ANY (ARRAY[''pending''::text, ''dispatching''::text])) AND completed_at IS NULL)'),
      ('app_sessions', 'app_sessions_pkey', 'p', TRUE, 'PRIMARY KEY (sid)')
  )
  SELECT string_agg(format('public.%I.%I', expected.table_name, expected.constraint_name), ', ' ORDER BY expected.table_name, expected.constraint_name)
    INTO issue
    FROM expected
    JOIN pg_namespace namespace ON namespace.nspname = 'public'
    JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = expected.table_name
    LEFT JOIN pg_constraint constraint_catalog
      ON constraint_catalog.conrelid = relation.oid
     AND constraint_catalog.conname = expected.constraint_name
   WHERE constraint_catalog.oid IS NULL
      OR constraint_catalog.contype IS DISTINCT FROM expected.constraint_type::"char"
      OR constraint_catalog.convalidated IS DISTINCT FROM expected.is_validated
      OR pg_get_constraintdef(constraint_catalog.oid, TRUE) IS DISTINCT FROM expected.definition;

  IF issue IS NOT NULL THEN
    RAISE EXCEPTION '关键约束缺失或定义不匹配：%', issue;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      JOIN pg_language language ON language.oid = procedure.prolang
     WHERE namespace.nspname = 'public'
       AND procedure.proname = 'set_row_updated_at'
       AND procedure.pronargs = 0
       AND procedure.prorettype = 'trigger'::regtype
       AND language.lanname = 'plpgsql'
  ) THEN
    RAISE EXCEPTION '缺少 public.set_row_updated_at() trigger function';
  END IF;

  WITH expected(table_name, trigger_name) AS (
    VALUES
      ('app_users', 'trg_app_users_updated_at'),
      ('rpa_tasks', 'trg_rpa_tasks_updated_at'),
      ('rpa_task_run_requests', 'trg_rpa_task_run_requests_updated_at')
  )
  SELECT string_agg(format('public.%I.%I', expected.table_name, expected.trigger_name), ', ' ORDER BY expected.table_name)
    INTO issue
    FROM expected
    JOIN pg_namespace namespace ON namespace.nspname = 'public'
    JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = expected.table_name
    LEFT JOIN pg_trigger trigger_catalog
      ON trigger_catalog.tgrelid = relation.oid
     AND trigger_catalog.tgname = expected.trigger_name
     AND NOT trigger_catalog.tgisinternal
   WHERE trigger_catalog.oid IS NULL
      OR trigger_catalog.tgenabled <> 'O'
      OR trigger_catalog.tgtype <> 19
      OR trigger_catalog.tgfoid <> 'public.set_row_updated_at()'::regprocedure;

  IF issue IS NOT NULL THEN
    RAISE EXCEPTION '更新时间 trigger 缺失、禁用或定义不匹配：%', issue;
  END IF;
END
$verify$;

DO $verify_data$
DECLARE
  issue TEXT;
BEGIN
  -- These eight checks were introduced as NOT VALID to permit an in-place
  -- legacy upgrade. Verify the historical rows explicitly without changing the
  -- constraints to VALIDATED state.
  SELECT string_agg(violation.constraint_name, ', ' ORDER BY violation.constraint_name)
    INTO issue
    FROM (
      SELECT 'ck_app_users_auth_provider' AS constraint_name
       WHERE EXISTS (
         SELECT 1 FROM public.app_users
          WHERE auth_provider NOT IN ('dev', 'feishu')
       )
      UNION ALL
      SELECT 'ck_rpa_tasks_version_positive'
       WHERE EXISTS (
         SELECT 1 FROM public.rpa_tasks WHERE version < 1
       )
      UNION ALL
      SELECT 'ck_rpa_tasks_start_time_format'
       WHERE EXISTS (
         SELECT 1 FROM public.rpa_tasks
          WHERE start_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'
       )
      UNION ALL
      SELECT 'ck_rpa_tasks_finish_time_format'
       WHERE EXISTS (
         SELECT 1 FROM public.rpa_tasks
          WHERE finish_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'
       )
      UNION ALL
      SELECT 'ck_rpa_tasks_binding_pair'
       WHERE EXISTS (
         SELECT 1 FROM public.rpa_tasks
          WHERE (schedule_uuid IS NULL) <> (schedule_bound_at IS NULL)
       )
      UNION ALL
      SELECT 'ck_rpa_task_executions_normalized_status'
       WHERE EXISTS (
         SELECT 1 FROM public.rpa_task_executions
          WHERE normalized_status NOT IN (
            '等待中', '运行中', '等待超时', '运行超时',
            '运行成功', '运行失败', '已停止', '未知状态'
          )
       )
      UNION ALL
      SELECT 'ck_rpa_task_executions_job_uuid_list_array'
       WHERE EXISTS (
         SELECT 1 FROM public.rpa_task_executions
          WHERE jsonb_typeof(job_uuid_list) IS DISTINCT FROM 'array'
       )
      UNION ALL
      SELECT 'ck_rpa_task_audit_log_action'
       WHERE EXISTS (
         SELECT 1 FROM public.rpa_task_audit_log
          WHERE action NOT IN ('create', 'update', 'delete', 'rebind', 'transfer', 'import', 'run_now', 'admin_recover')
       )
    ) AS violation;

  IF issue IS NOT NULL THEN
    RAISE EXCEPTION 'NOT VALID CHECK 约束存在历史数据违规：%', issue;
  END IF;

  IF EXISTS (
    SELECT schedule_uuid
      FROM public.rpa_tasks
     WHERE deleted_at IS NULL AND schedule_uuid IS NOT NULL
     GROUP BY schedule_uuid
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION '存在重复的有效 schedule_uuid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.rpa_tasks WHERE sync_generation < 0
  ) THEN
    RAISE EXCEPTION '存在负数 sync_generation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.rpa_tasks task
     WHERE task.deleted_at IS NULL
       AND task.schedule_uuid IS NOT NULL
       AND (
         SELECT COUNT(*)
           FROM public.rpa_task_binding_history history
          WHERE history.rpa_task_id = task.id
            AND history.schedule_uuid = task.schedule_uuid
            AND history.bound_at = task.schedule_bound_at
            AND history.unbound_at IS NULL
       ) <> 1
  ) THEN
    RAISE EXCEPTION '有效任务缺少唯一匹配的活动 binding_history';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.rpa_task_binding_history history
      JOIN public.rpa_tasks task ON task.id = history.rpa_task_id
     WHERE history.unbound_at IS NULL
       AND (
         task.deleted_at IS NOT NULL
         OR task.schedule_uuid IS DISTINCT FROM history.schedule_uuid
         OR task.schedule_bound_at IS DISTINCT FROM history.bound_at
       )
  ) THEN
    RAISE EXCEPTION '当前任务绑定与 binding_history 活动区间不一致';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.rpa_task_run_requests
     WHERE (status = 'succeeded' AND (task_uuid IS NULL OR audit_log_id IS NULL OR completed_at IS NULL))
        OR (status = 'rejected' AND completed_at IS NULL)
        OR (status IN ('pending', 'dispatching') AND completed_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION '立即执行请求状态与执行/审计关联不一致';
  END IF;
END
$verify_data$;

SELECT
  COUNT(*) FILTER (WHERE deleted_at IS NULL) AS active_tasks,
  COUNT(*) FILTER (
    WHERE deleted_at IS NULL AND (owner_user_id IS NULL OR schedule_uuid IS NULL)
  ) AS legacy_read_only_tasks,
  COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted_tasks
FROM public.rpa_tasks;

SELECT normalized_status, COUNT(*)
FROM public.rpa_task_executions
GROUP BY normalized_status
ORDER BY normalized_status;

SELECT 'verification_ok' AS result, NOW() AS checked_at;

COMMIT;
