CREATE TABLE IF NOT EXISTS meeting_core.summary_publication_effects (
  projection_key text PRIMARY KEY,
  publication_target_id text NOT NULL,
  external_receipt text,
  reserved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  CONSTRAINT summary_publication_effects_key_is_valid
    CHECK ((length(projection_key) BETWEEN 1 AND 512) IS TRUE),
  CONSTRAINT summary_publication_effects_target_is_valid
    CHECK ((length(publication_target_id) BETWEEN 1 AND 256) IS TRUE),
  CONSTRAINT summary_publication_effects_receipt_is_consistent
    CHECK (((external_receipt IS NULL) = (completed_at IS NULL)) IS TRUE),
  CONSTRAINT summary_publication_effects_receipt_is_bounded
    CHECK ((external_receipt IS NULL OR length(external_receipt) BETWEEN 1 AND 1024) IS TRUE)
);

COMMENT ON TABLE meeting_core.summary_publication_effects IS
  'Durable reservation fence preventing duplicate external summary creation after an unknown remote outcome.';
