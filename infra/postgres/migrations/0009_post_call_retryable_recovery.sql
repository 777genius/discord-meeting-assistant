ALTER TABLE meeting_core.post_call_outbox
  ADD COLUMN IF NOT EXISTS recovery_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_after timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_source_job_ref text;

ALTER TABLE meeting_core.post_call_outbox
  ADD CONSTRAINT post_call_outbox_recovery_generation_is_valid
    CHECK (recovery_generation BETWEEN 0 AND 9007199254740991) NOT VALID,
  ADD CONSTRAINT post_call_outbox_recovery_receipt_is_consistent
    CHECK ((
      (recovery_generation = 0
        AND recovery_after IS NULL
        AND recovery_source_job_ref IS NULL)
      OR
      (recovery_generation > 0
        AND recovery_after IS NOT NULL
        AND recovery_source_job_ref IS NOT NULL)
    ) IS TRUE) NOT VALID,
  ADD CONSTRAINT post_call_outbox_recovery_source_job_ref_fkey
    FOREIGN KEY (recovery_source_job_ref)
    REFERENCES meeting_core.post_call_dead_letters(source_job_ref)
    NOT VALID;

COMMENT ON COLUMN meeting_core.post_call_outbox.recovery_generation IS
  'Zero-based durable delivery generation. Each exhausted retryable generation advances it once.';
COMMENT ON COLUMN meeting_core.post_call_outbox.recovery_after IS
  'Earliest database time at which the current recovery generation may be enqueued.';
COMMENT ON COLUMN meeting_core.post_call_outbox.recovery_source_job_ref IS
  'Idempotency receipt for the exhausted delivery generation that scheduled recovery.';
