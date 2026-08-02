BEGIN;

CREATE TABLE IF NOT EXISTS meeting_core.live_meetings (
  meeting_id text PRIMARY KEY,
  revision bigint NOT NULL
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT live_meetings_snapshot_is_object
    CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT live_meetings_snapshot_identity_matches
    CHECK (snapshot ->> 'meetingId' = meeting_id),
  CONSTRAINT live_meetings_snapshot_revision_matches
    CHECK ((snapshot ->> 'revision')::bigint = revision)
);

COMMENT ON TABLE meeting_core.live_meetings IS
  'Derived live transcript and incremental summary snapshots; final Craig artifacts remain authoritative.';

COMMIT;
