-- A sync response may arrive after a newer sync or after a task was rebound.
-- Claiming a monotonically increasing generation before each remote request lets
-- the result update only the exact binding/generation that initiated it.

ALTER TABLE public.rpa_tasks
  ADD COLUMN IF NOT EXISTS sync_generation BIGINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_rpa_tasks_sync_generation_nonnegative'
  ) THEN
    ALTER TABLE public.rpa_tasks
      ADD CONSTRAINT ck_rpa_tasks_sync_generation_nonnegative
      CHECK (sync_generation >= 0);
  END IF;
END
$$;

COMMENT ON COLUMN public.rpa_tasks.sync_generation IS
  'Internal binding-scoped generation; only the latest claimed sync request may update sync metadata.';

DROP INDEX IF EXISTS public.idx_rpa_task_executions_active;
CREATE INDEX idx_rpa_task_executions_active
  ON public.rpa_task_executions (rpa_task_id, updated_time DESC NULLS LAST)
  WHERE normalized_status IN ('等待中', '运行中', '未知状态');
