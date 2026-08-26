DROP INDEX meeting_knowledge.live_memory_outbox_recoverable_idx;

ALTER TABLE meeting_knowledge.live_memory_outbox
  DROP CONSTRAINT live_memory_outbox_state_is_supported;

ALTER TABLE meeting_knowledge.live_memory_outbox
  DROP CONSTRAINT live_memory_outbox_lease_is_consistent;

ALTER TABLE meeting_knowledge.live_memory_outbox
  ADD CONSTRAINT live_memory_outbox_state_is_supported
  CHECK ((state IN (
    'pending', 'in_flight', 'retry_wait', 'outcome_unknown', 'applied', 'dead_letter',
    'retire_pending', 'retire_in_flight', 'retire_outcome_unknown',
    'retired', 'retire_dead_letter'
  )) IS TRUE) NOT VALID;

ALTER TABLE meeting_knowledge.live_memory_outbox
  VALIDATE CONSTRAINT live_memory_outbox_state_is_supported;

ALTER TABLE meeting_knowledge.live_memory_outbox
  ADD CONSTRAINT live_memory_outbox_lease_is_consistent
  CHECK (((state IN ('in_flight', 'retire_in_flight')) =
    (lease_expires_at IS NOT NULL)) IS TRUE) NOT VALID;

ALTER TABLE meeting_knowledge.live_memory_outbox
  VALIDATE CONSTRAINT live_memory_outbox_lease_is_consistent;

CREATE INDEX live_memory_outbox_recoverable_idx
  ON meeting_knowledge.live_memory_outbox (
    COALESCE(retry_after, lease_expires_at, created_at),
    meeting_id,
    source_generation
  )
  WHERE state IN (
    'pending', 'in_flight', 'retry_wait', 'outcome_unknown',
    'retire_pending', 'retire_in_flight', 'retire_outcome_unknown'
  );

COMMENT ON COLUMN meeting_knowledge.live_memory_outbox.state IS
  'outcome_unknown rows must reconcile the exact opaque document before any retry.';
