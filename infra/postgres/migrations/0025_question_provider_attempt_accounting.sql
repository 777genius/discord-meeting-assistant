ALTER TABLE meeting_knowledge.question_jobs
  ADD COLUMN provider_attempt_state text NOT NULL DEFAULT 'none',
  ADD COLUMN provider_attempt_id text,
  ADD COLUMN provider_attempt_started_at timestamptz,
  ADD COLUMN provider_attempt_finished_at timestamptz,
  ADD COLUMN provider_attempt_retryable boolean,
  ADD COLUMN worker_protocol_epoch integer NOT NULL DEFAULT 1,
  ADD COLUMN worker_protocol_generation bigint,
  ADD CONSTRAINT question_jobs_provider_attempt_state_is_supported
    CHECK ((provider_attempt_state IN ('none', 'reserved', 'completed', 'failed')) IS TRUE),
  ADD CONSTRAINT question_jobs_provider_attempt_is_consistent
    CHECK (((provider_attempt_state = 'none' AND
              provider_attempt_id IS NULL AND
              provider_attempt_started_at IS NULL AND
              provider_attempt_finished_at IS NULL AND
              provider_attempt_retryable IS NULL) OR
            (provider_attempt_state = 'reserved' AND
              provider_attempt_id IS NOT NULL AND
              provider_attempt_started_at IS NOT NULL AND
              provider_attempt_finished_at IS NULL AND
              provider_attempt_retryable IS NULL) OR
            (provider_attempt_state = 'completed' AND
              provider_attempt_id IS NOT NULL AND
              provider_attempt_started_at IS NOT NULL AND
              provider_attempt_finished_at IS NOT NULL AND
              provider_attempt_retryable IS NULL) OR
            (provider_attempt_state = 'failed' AND
              provider_attempt_id IS NOT NULL AND
              provider_attempt_started_at IS NOT NULL AND
              provider_attempt_finished_at IS NOT NULL AND
              provider_attempt_retryable IS NOT NULL)) IS TRUE);

-- A pre-upgrade running lease may already have an unobservable provider call.
-- Terminalize it rather than risk replaying that call under the new accounting.
UPDATE meeting_knowledge.question_jobs
SET state = 'terminal',
    outcome = 'unavailable',
    authorization_principal_ref = NULL,
    question_text = NULL,
    binding = NULL,
    grounding_plan = NULL,
    answer_candidate = NULL,
    lease_owner = NULL,
    lease_until = NULL,
    terminal_at = transaction_timestamp(),
    scrubbed_at = transaction_timestamp(),
    updated_at = transaction_timestamp()
WHERE state = 'running';

-- Activation fence: old binaries increment generation but cannot stamp the
-- matching protocol generation, so PostgreSQL rejects every old lease claim.
ALTER TABLE meeting_knowledge.question_jobs
  ADD CONSTRAINT question_jobs_running_worker_protocol_is_current
    CHECK (((state <> 'running') OR (
      worker_protocol_epoch = 2 AND
      worker_protocol_generation = generation
    )) IS TRUE);

COMMENT ON COLUMN meeting_knowledge.question_jobs.provider_attempt_state IS
  'Durable provider usage reservation/outcome. An expired reserved attempt is terminal and is never replayed.';
COMMENT ON COLUMN meeting_knowledge.question_jobs.worker_protocol_epoch IS
  'Lease protocol epoch. Epoch 2 atomically fences pre-accounting workers after migration activation.';
