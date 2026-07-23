\set ON_ERROR_STOP on

-- Read-only effective-privilege verification. This deliberately checks the
-- privileges inherited through PUBLIC as well as direct grants.

\if :{?runtime_role}
\else
  \echo 'runtime_role is required (use -v runtime_role=...)'
  \quit 2
\endif

BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL search_path TO pg_catalog, public;

SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'runtime_role'
) AS runtime_role_exists
\gset

\if :runtime_role_exists
\else
  \echo 'runtime_role does not exist'
  \quit 3
\endif

SELECT NOT (
  rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
) AS runtime_role_flags_safe
FROM pg_catalog.pg_roles
WHERE rolname = :'runtime_role'
\gset

\if :runtime_role_flags_safe
\else
  \echo 'runtime_role has a privileged role attribute'
  \quit 3
\endif

SELECT NOT EXISTS (
  SELECT 1
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles role ON role.oid = membership.member
   WHERE role.rolname = :'runtime_role'
) AS runtime_role_has_no_memberships
\gset

\if :runtime_role_has_no_memberships
\else
  \echo 'runtime_role inherits or can SET ROLE to another role; remove memberships before use'
  \quit 3
\endif

SELECT
  pg_catalog.has_schema_privilege(:'runtime_role', 'public', 'USAGE')
  AND NOT pg_catalog.has_schema_privilege(:'runtime_role', 'public', 'CREATE')
  AND NOT pg_catalog.has_database_privilege(:'runtime_role', current_database(), 'CREATE')
  AS runtime_role_namespace_safe
\gset

\if :runtime_role_namespace_safe
\else
  \echo 'runtime_role must have public USAGE but no schema/database CREATE privilege'
  \quit 3
\endif

WITH expected(table_name, privilege) AS (
  VALUES
    ('schema_migrations', 'SELECT'),
    ('app_users', 'SELECT'), ('app_users', 'INSERT'), ('app_users', 'UPDATE'),
    ('rpa_tasks', 'SELECT'), ('rpa_tasks', 'INSERT'), ('rpa_tasks', 'UPDATE'),
    ('rpa_task_binding_history', 'SELECT'),
    ('rpa_task_binding_history', 'INSERT'),
    ('rpa_task_binding_history', 'UPDATE'),
    ('rpa_task_executions', 'SELECT'),
    ('rpa_task_executions', 'INSERT'),
    ('rpa_task_executions', 'UPDATE'),
    ('rpa_task_executions', 'DELETE'),
    ('rpa_task_audit_log', 'SELECT'), ('rpa_task_audit_log', 'INSERT'),
    ('rpa_task_run_requests', 'SELECT'),
    ('rpa_task_run_requests', 'INSERT'),
    ('rpa_task_run_requests', 'UPDATE'),
    ('app_sessions', 'SELECT'), ('app_sessions', 'INSERT'),
    ('app_sessions', 'UPDATE'), ('app_sessions', 'DELETE')
)
SELECT NOT EXISTS (
  SELECT 1
    FROM expected
   WHERE NOT pg_catalog.has_table_privilege(
     :'runtime_role',
     format('public.%I', table_name),
     privilege
   )
) AS runtime_role_has_required_table_privileges
\gset

\if :runtime_role_has_required_table_privileges
\else
  \echo 'runtime_role is missing a required table privilege'
  \quit 3
\endif

WITH tables(table_name) AS (
  VALUES
    ('schema_migrations'),
    ('app_users'),
    ('rpa_tasks'),
    ('rpa_task_binding_history'),
    ('rpa_task_executions'),
    ('rpa_task_audit_log'),
    ('rpa_task_run_requests'),
    ('app_sessions')
), privileges(privilege) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
         ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
), expected(table_name, privilege) AS (
  VALUES
    ('schema_migrations', 'SELECT'),
    ('app_users', 'SELECT'), ('app_users', 'INSERT'), ('app_users', 'UPDATE'),
    ('rpa_tasks', 'SELECT'), ('rpa_tasks', 'INSERT'), ('rpa_tasks', 'UPDATE'),
    ('rpa_task_binding_history', 'SELECT'),
    ('rpa_task_binding_history', 'INSERT'),
    ('rpa_task_binding_history', 'UPDATE'),
    ('rpa_task_executions', 'SELECT'),
    ('rpa_task_executions', 'INSERT'),
    ('rpa_task_executions', 'UPDATE'),
    ('rpa_task_executions', 'DELETE'),
    ('rpa_task_audit_log', 'SELECT'), ('rpa_task_audit_log', 'INSERT'),
    ('rpa_task_run_requests', 'SELECT'),
    ('rpa_task_run_requests', 'INSERT'),
    ('rpa_task_run_requests', 'UPDATE'),
    ('app_sessions', 'SELECT'), ('app_sessions', 'INSERT'),
    ('app_sessions', 'UPDATE'), ('app_sessions', 'DELETE')
)
SELECT NOT EXISTS (
  SELECT 1
    FROM tables
    CROSS JOIN privileges
    LEFT JOIN expected USING (table_name, privilege)
   WHERE expected.table_name IS NULL
     AND pg_catalog.has_table_privilege(
       :'runtime_role',
       format('public.%I', tables.table_name),
       privileges.privilege
     )
) AS runtime_role_has_no_extra_table_privileges
\gset

\if :runtime_role_has_no_extra_table_privileges
\else
  \echo 'runtime_role has an unexpected effective table privilege'
  \quit 3
\endif

WITH sequences(sequence_name) AS (
  VALUES
    ('app_users_id_seq'),
    ('rpa_tasks_id_seq'),
    ('rpa_task_binding_history_id_seq'),
    ('rpa_task_audit_log_id_seq')
)
SELECT NOT EXISTS (
  SELECT 1
    FROM sequences
   WHERE NOT pg_catalog.has_sequence_privilege(
           :'runtime_role', format('public.%I', sequence_name), 'USAGE'
         )
      OR pg_catalog.has_sequence_privilege(
           :'runtime_role', format('public.%I', sequence_name), 'SELECT'
         )
      OR pg_catalog.has_sequence_privilege(
           :'runtime_role', format('public.%I', sequence_name), 'UPDATE'
         )
) AS runtime_role_sequence_privileges_exact
\gset

\if :runtime_role_sequence_privileges_exact
\else
  \echo 'runtime_role sequence privileges are missing or broader than USAGE'
  \quit 3
\endif

COMMIT;
\echo 'Runtime role privileges verified.'
