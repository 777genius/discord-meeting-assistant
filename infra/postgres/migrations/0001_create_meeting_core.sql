BEGIN;

CREATE SCHEMA IF NOT EXISTS meeting_core;

CREATE TABLE IF NOT EXISTS meeting_core.meetings (
  meeting_id text PRIMARY KEY,
  revision bigint NOT NULL
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT meetings_snapshot_is_object
    CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT meetings_snapshot_identity_matches
    CHECK (snapshot ->> 'meetingId' = meeting_id),
  CONSTRAINT meetings_snapshot_revision_matches
    CHECK ((snapshot ->> 'revision')::bigint = revision)
);

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

COMMENT ON TABLE meeting_core.meetings IS
  'Authoritative Meeting Core snapshots; revision is duplicated only for optimistic compare-and-swap.';
COMMENT ON COLUMN meeting_core.meetings.snapshot IS
  'Complete JSONB aggregate snapshot, including recording evidence, transcript turns, summary evidence, and publication receipt.';

COMMIT;
