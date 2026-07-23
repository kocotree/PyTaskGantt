ALTER TABLE public.app_users
  ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.rpa_task_audit_log
  DROP CONSTRAINT ck_rpa_task_audit_log_action;

ALTER TABLE public.rpa_task_audit_log
  ADD CONSTRAINT ck_rpa_task_audit_log_action
  CHECK (action IN (
    'create', 'update', 'delete', 'rebind', 'transfer', 'import', 'run_now', 'admin_recover'
  )) NOT VALID;

COMMENT ON COLUMN public.app_users.is_admin IS
  'Controlled administrator permission. It is never derived from login provider or client input.';
