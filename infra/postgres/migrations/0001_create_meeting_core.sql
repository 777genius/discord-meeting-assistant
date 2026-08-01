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

COMMENT ON TABLE meeting_core.meetings IS
  'Authoritative Meeting Core snapshots; revision is duplicated only for optimistic compare-and-swap.';
COMMENT ON COLUMN meeting_core.meetings.snapshot IS
  'Complete JSONB aggregate snapshot, including recording evidence, transcript turns, summary evidence, and publication receipt.';

COMMIT;
