BEGIN;

CREATE TABLE IF NOT EXISTS meeting_core.post_call_outbox (
  meeting_id text PRIMARY KEY
    REFERENCES meeting_core.meetings(meeting_id) ON DELETE CASCADE,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  dispatched_at timestamptz
);

CREATE INDEX IF NOT EXISTS post_call_outbox_pending_idx
  ON meeting_core.post_call_outbox (created_at, meeting_id)
  WHERE dispatched_at IS NULL;

COMMENT ON TABLE meeting_core.post_call_outbox IS
  'Transactional handoff from authoritative meeting persistence to the durable BullMQ queue.';

COMMIT;
