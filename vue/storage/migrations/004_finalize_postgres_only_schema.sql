-- Finalize server-maintained timestamps and reconstruct binding intervals for any
-- database that already carried schedule assignments before this migration set.

CREATE OR REPLACE FUNCTION public.set_row_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_app_users_updated_at ON public.app_users;
CREATE TRIGGER trg_app_users_updated_at
BEFORE UPDATE ON public.app_users
FOR EACH ROW EXECUTE FUNCTION public.set_row_updated_at();

DROP TRIGGER IF EXISTS trg_rpa_tasks_updated_at ON public.rpa_tasks;
CREATE TRIGGER trg_rpa_tasks_updated_at
BEFORE UPDATE ON public.rpa_tasks
FOR EACH ROW EXECUTE FUNCTION public.set_row_updated_at();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_app_users_auth_provider') THEN
    ALTER TABLE public.app_users
      ADD CONSTRAINT ck_app_users_auth_provider
      CHECK (auth_provider IN ('dev', 'feishu')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_rpa_tasks_binding_pair') THEN
    ALTER TABLE public.rpa_tasks
      ADD CONSTRAINT ck_rpa_tasks_binding_pair
      CHECK ((schedule_uuid IS NULL) = (schedule_bound_at IS NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_rpa_task_executions_normalized_status') THEN
    ALTER TABLE public.rpa_task_executions
      ADD CONSTRAINT ck_rpa_task_executions_normalized_status
      CHECK (normalized_status IN (
        '等待中', '运行中', '等待超时', '运行超时',
        '运行成功', '运行失败', '已停止', '未知状态'
      )) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_rpa_task_executions_job_uuid_list_array') THEN
    ALTER TABLE public.rpa_task_executions
      ADD CONSTRAINT ck_rpa_task_executions_job_uuid_list_array
      CHECK (jsonb_typeof(job_uuid_list) = 'array') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_rpa_task_audit_log_action') THEN
    ALTER TABLE public.rpa_task_audit_log
      ADD CONSTRAINT ck_rpa_task_audit_log_action
      CHECK (action IN ('create', 'update', 'delete', 'rebind', 'transfer', 'import', 'run_now')) NOT VALID;
  END IF;
END
$$;

INSERT INTO public.rpa_task_binding_history (
  rpa_task_id,
  schedule_uuid,
  bound_at,
  unbound_at,
  actor_user_id
)
SELECT
  task.id,
  task.schedule_uuid,
  COALESCE(task.schedule_bound_at, task.updated_at, task.created_at, NOW()),
  CASE WHEN task.deleted_at IS NULL THEN NULL ELSE task.deleted_at END,
  task.owner_user_id
FROM public.rpa_tasks AS task
WHERE task.schedule_uuid IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.rpa_task_binding_history AS history
    WHERE history.rpa_task_id = task.id
      AND history.schedule_uuid = task.schedule_uuid
      AND history.unbound_at IS NOT DISTINCT FROM
          CASE WHEN task.deleted_at IS NULL THEN NULL ELSE task.deleted_at END
  );

COMMENT ON TABLE public.rpa_tasks IS
  'PostgreSQL-only task source. owner_user_id/schedule_uuid may be NULL only for migrated historical tasks.';
COMMENT ON COLUMN public.rpa_tasks.version IS
  'Optimistic-lock version incremented by every user-visible mutation.';
COMMENT ON TABLE public.rpa_task_executions IS
  'Last 30 days of Yingdao executions, idempotently keyed by task_uuid.';
COMMENT ON TABLE public.app_sessions IS
  'Server-side HTTP sessions; configure connect-pg-simple with tableName=app_sessions.';
