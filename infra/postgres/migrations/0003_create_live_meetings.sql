CREATE TABLE IF NOT EXISTS meeting_core.live_meetings (
  meeting_id text PRIMARY KEY,
  revision bigint NOT NULL
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT live_meetings_snapshot_is_object
    CHECK ((jsonb_typeof(snapshot) = 'object') IS TRUE),
  CONSTRAINT live_meetings_snapshot_identity_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'meetingId') = 'string' AND
      snapshot ->> 'meetingId' = meeting_id
    ) IS TRUE),
  CONSTRAINT live_meetings_snapshot_revision_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'revision') = 'number' AND
      snapshot ->> 'revision' ~ '^(0|[1-9][0-9]*)$' AND
      (snapshot ->> 'revision')::bigint = revision
    ) IS TRUE)
);

COMMENT ON TABLE meeting_core.live_meetings IS
  'Derived live transcript and incremental summary snapshots; final Craig artifacts remain authoritative.';
