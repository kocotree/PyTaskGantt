-- Persist immediate-run intent before calling Yingdao. A pending request is an
-- outbox item: every retry reuses its idempotent_uuid until the remote start and
-- the local execution/audit records commit together.

CREATE TABLE IF NOT EXISTS public.rpa_task_run_requests (
  idempotent_uuid       UUID PRIMARY KEY,
  rpa_task_id           BIGINT NOT NULL REFERENCES public.rpa_tasks(id) ON DELETE RESTRICT,
  schedule_uuid_at_run  TEXT NOT NULL,
  schedule_bound_at_at_request TIMESTAMPTZ NOT NULL,
  requested_by_user_id  BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
  status                TEXT NOT NULL DEFAULT 'pending',
  -- Deliberately not a foreign key: execution rows are retained for 30 days,
  -- while this durable request/audit association must survive their cleanup.
  task_uuid             TEXT UNIQUE,
  job_uuid_list         JSONB NOT NULL DEFAULT '[]'::jsonb,
  audit_log_id          BIGINT UNIQUE REFERENCES public.rpa_task_audit_log(id) ON DELETE RESTRICT,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  last_attempt_at       TIMESTAMPTZ,
  next_attempt_at       TIMESTAMPTZ,
  last_error            TEXT,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_rpa_task_run_requests_status
    CHECK (status IN ('pending', 'dispatching', 'succeeded', 'rejected')),
  CONSTRAINT ck_rpa_task_run_requests_job_uuid_list_array
    CHECK (jsonb_typeof(job_uuid_list) = 'array'),
  CONSTRAINT ck_rpa_task_run_requests_attempt_count
    CHECK (attempt_count >= 0),
  CONSTRAINT ck_rpa_task_run_requests_completion
    CHECK (
      (status = 'succeeded' AND task_uuid IS NOT NULL AND audit_log_id IS NOT NULL AND completed_at IS NOT NULL)
      OR (status = 'rejected' AND completed_at IS NOT NULL)
      OR (status IN ('pending', 'dispatching') AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rpa_task_run_requests_open_task
  ON public.rpa_task_run_requests (rpa_task_id)
  WHERE status IN ('pending', 'dispatching');

CREATE INDEX IF NOT EXISTS idx_rpa_task_run_requests_pending_retry
  ON public.rpa_task_run_requests (COALESCE(next_attempt_at, created_at), created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_rpa_task_run_requests_task_created
  ON public.rpa_task_run_requests (rpa_task_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_rpa_task_run_requests_updated_at ON public.rpa_task_run_requests;
CREATE TRIGGER trg_rpa_task_run_requests_updated_at
BEFORE UPDATE ON public.rpa_task_run_requests
FOR EACH ROW EXECUTE FUNCTION public.set_row_updated_at();

COMMENT ON TABLE public.rpa_task_run_requests IS
  'Durable immediate-run outbox. The UUID is committed before remote dispatch and reused by every retry.';
COMMENT ON COLUMN public.rpa_task_run_requests.status IS
  'pending/dispatching are recoverable; succeeded/rejected are terminal.';
