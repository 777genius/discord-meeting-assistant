CREATE TABLE meeting_core.recording_publication_reconciliations (
  meeting_id text PRIMARY KEY,
  external_publication_id text NOT NULL,
  request_payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  CONSTRAINT recording_publication_reconciliations_values_are_valid CHECK ((
    length(meeting_id) BETWEEN 1 AND 1024 AND
    length(external_publication_id) BETWEEN 1 AND 1024 AND
    jsonb_typeof(request_payload) = 'object' AND
    state IN ('pending', 'edited', 'unavailable') AND
    ((state = 'pending') = (completed_at IS NULL)) AND
    ((lease_owner IS NULL) = (lease_expires_at IS NULL)) AND
    (state = 'pending' OR lease_owner IS NULL) AND
    (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 1024)
  ) IS TRUE)
);

CREATE INDEX recording_publication_reconciliations_pending_idx
  ON meeting_core.recording_publication_reconciliations (created_at, meeting_id)
  WHERE state = 'pending';

COMMENT ON TABLE meeting_core.recording_publication_reconciliations IS
  'Durable idempotent obligations to add ready recording links to final Discord projections.';
