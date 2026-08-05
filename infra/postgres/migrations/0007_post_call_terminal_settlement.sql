ALTER TABLE meeting_core.post_call_outbox
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_letter_source_job_ref text;

ALTER TABLE meeting_core.post_call_outbox
  DROP CONSTRAINT IF EXISTS post_call_outbox_terminal_receipt_is_consistent,
  DROP CONSTRAINT IF EXISTS post_call_outbox_terminal_receipt_is_exclusive,
  DROP CONSTRAINT IF EXISTS post_call_outbox_dead_letter_source_job_ref_fkey;

ALTER TABLE meeting_core.post_call_outbox
  ADD CONSTRAINT post_call_outbox_terminal_receipt_is_consistent
    CHECK (((dead_lettered_at IS NULL) = (dead_letter_source_job_ref IS NULL)) IS TRUE),
  ADD CONSTRAINT post_call_outbox_terminal_receipt_is_exclusive
    CHECK ((processed_at IS NULL OR dead_lettered_at IS NULL) IS TRUE),
  ADD CONSTRAINT post_call_outbox_dead_letter_source_job_ref_fkey
    FOREIGN KEY (dead_letter_source_job_ref)
    REFERENCES meeting_core.post_call_dead_letters(source_job_ref);

DROP INDEX IF EXISTS meeting_core.post_call_outbox_recoverable_idx;
CREATE INDEX post_call_outbox_recoverable_idx
  ON meeting_core.post_call_outbox (created_at, meeting_id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

COMMENT ON COLUMN meeting_core.post_call_outbox.dead_lettered_at IS
  'Durable terminal failure receipt. A linked item is no longer eligible for automatic recovery.';
COMMENT ON COLUMN meeting_core.post_call_outbox.dead_letter_source_job_ref IS
  'Stable reference to the authoritative terminal failure evidence.';
