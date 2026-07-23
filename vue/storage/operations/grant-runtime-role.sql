\set ON_ERROR_STOP on

-- Usage:
--   psql ... -v runtime_role=pytaskgantt_runtime \
--     -f storage/operations/grant-runtime-role.sql
--
-- Run as the database/schema owner after migrations. The runtime role must be
-- separate from the migration owner and must not inherit privileges from other
-- roles; verify-runtime-role.sql enforces those assumptions after the grants.

\if :{?runtime_role}
\else
  \echo 'runtime_role is required (use -v runtime_role=...)'
  \quit 2
\endif

SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'runtime_role'
) AS runtime_role_exists
\gset

\if :runtime_role_exists
\else
  \echo 'runtime_role does not exist'
  \quit 2
\endif

SELECT NOT EXISTS (
  SELECT 1
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_database database ON database.datdba = role.oid
   WHERE role.rolname = :'runtime_role'
     AND database.datname = current_database()
  UNION ALL
  SELECT 1
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_namespace namespace ON namespace.nspowner = role.oid
   WHERE role.rolname = :'runtime_role'
     AND namespace.nspname = 'public'
  UNION ALL
  SELECT 1
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_class relation ON relation.relowner = role.oid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE role.rolname = :'runtime_role'
     AND namespace.nspname = 'public'
     AND relation.relname IN (
       'schema_migrations',
       'app_users',
       'rpa_tasks',
       'rpa_task_binding_history',
       'rpa_task_executions',
       'rpa_task_audit_log',
       'rpa_task_run_requests',
       'app_sessions',
       'app_users_id_seq',
       'rpa_tasks_id_seq',
       'rpa_task_binding_history_id_seq',
       'rpa_task_audit_log_id_seq'
     )
) AS runtime_role_is_not_owner
\gset

\if :runtime_role_is_not_owner
\else
  \echo 'runtime_role must not own the database, public schema, or application objects'
  \quit 2
\endif

BEGIN;

SELECT format(
  'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'runtime_role'
)
\gexec

-- PostgreSQL clusters upgraded from older releases may still grant CREATE on
-- public to PUBLIC. Remove it so the runtime role cannot create arbitrary DDL
-- through the implicit PUBLIC membership.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"runtime_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role";

REVOKE ALL PRIVILEGES ON TABLE
  public.schema_migrations,
  public.app_users,
  public.rpa_tasks,
  public.rpa_task_binding_history,
  public.rpa_task_executions,
  public.rpa_task_audit_log,
  public.rpa_task_run_requests,
  public.app_sessions
FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE
  public.schema_migrations,
  public.app_users,
  public.rpa_tasks,
  public.rpa_task_binding_history,
  public.rpa_task_executions,
  public.rpa_task_audit_log,
  public.rpa_task_run_requests,
  public.app_sessions
FROM :"runtime_role";

GRANT SELECT ON TABLE public.schema_migrations TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON TABLE public.app_users TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON TABLE public.rpa_tasks TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON TABLE public.rpa_task_binding_history TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rpa_task_executions TO :"runtime_role";
GRANT SELECT, INSERT ON TABLE public.rpa_task_audit_log TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON TABLE public.rpa_task_run_requests TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.app_sessions TO :"runtime_role";

REVOKE ALL PRIVILEGES ON SEQUENCE
  public.app_users_id_seq,
  public.rpa_tasks_id_seq,
  public.rpa_task_binding_history_id_seq,
  public.rpa_task_audit_log_id_seq
FROM PUBLIC;

REVOKE ALL PRIVILEGES ON SEQUENCE
  public.app_users_id_seq,
  public.rpa_tasks_id_seq,
  public.rpa_task_binding_history_id_seq,
  public.rpa_task_audit_log_id_seq
FROM :"runtime_role";

GRANT USAGE ON SEQUENCE
  public.app_users_id_seq,
  public.rpa_tasks_id_seq,
  public.rpa_task_binding_history_id_seq,
  public.rpa_task_audit_log_id_seq
TO :"runtime_role";

COMMIT;

\ir verify-runtime-role.sql
