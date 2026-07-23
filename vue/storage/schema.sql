-- PyTaskGantt PostgreSQL schema snapshot / psql entrypoint.
--
-- Preferred command (validates checksums and applies only pending versions):
--   node storage/migrate.cjs
--
-- This file remains a DBA-friendly, atomic psql entrypoint for a fresh database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f storage/schema.sql
-- It includes the same ordered migration files and records their exact checksums,
-- so the application startup version check recognizes the resulting schema.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  checksum    CHAR(64) NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

\ir migrations/001_add_users_and_task_ownership.sql
\ir migrations/002_add_executions_and_binding_history.sql
\ir migrations/003_add_audit_and_sessions.sql
\ir migrations/004_finalize_postgres_only_schema.sql
\ir migrations/005_add_durable_run_requests.sql
\ir migrations/006_add_binding_scoped_sync_generation.sql

INSERT INTO public.schema_migrations (version, name, checksum) VALUES
  (1, '001_add_users_and_task_ownership.sql',
   'c075042c15624ff876a2b690fba16a97ea8e7608564a159fb25e9450d2c4b7f2'),
  (2, '002_add_executions_and_binding_history.sql',
   'a7ac23418c0a5e5d91a9aca9018551bb0df14db522634c61d558eb6f13d4436c'),
  (3, '003_add_audit_and_sessions.sql',
   '9db862eebac53e2eccbd38946c7e9c0e9a9794f0d0cf382022fb43990af3c875'),
  (4, '004_finalize_postgres_only_schema.sql',
   '98ba7f05055bf6b886605f6da3edcc71f66d4c3d2b9fce124d33de834dd190df'),
  (5, '005_add_durable_run_requests.sql',
   'c6e6b76cb0d7d8cd51453f88bdb0b7ba1531b28928e7ef89b064926b6d339737'),
  (6, '006_add_binding_scoped_sync_generation.sql',
   '60168641cc15991754ab058d321cec2176c01daddbf057cc2cf4a5a0acb7e12d')
ON CONFLICT (version) DO NOTHING;

COMMIT;
