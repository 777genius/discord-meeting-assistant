CREATE TABLE meeting_knowledge.question_message_tombstones (
  question_id text PRIMARY KEY,
  mutation_kind text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT question_message_tombstones_kind_is_supported
    CHECK ((mutation_kind IN ('edit', 'delete')) IS TRUE),
  CONSTRAINT question_message_tombstones_expiry_is_bounded
    CHECK ((expires_at > observed_at AND
      expires_at <= observed_at + interval '7 days') IS TRUE)
);

CREATE INDEX question_message_tombstones_expiry_idx
  ON meeting_knowledge.question_message_tombstones (expires_at, question_id);

COMMENT ON TABLE meeting_knowledge.question_message_tombstones IS
  'Edit/delete-before-create fence retained for at most 7 days and deleted in bounded maintenance pages.';

CREATE TABLE meeting_knowledge.question_reconciliation_checkpoints (
  checkpoint_key text PRIMARY KEY,
  after_question_id text,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT question_reconciliation_checkpoint_key_is_supported
    CHECK ((checkpoint_key = 'discord-active-questions-v1') IS TRUE),
  CONSTRAINT question_reconciliation_cursor_is_valid
    CHECK ((after_question_id IS NULL OR
      after_question_id ~ '^[0-9]{17,20}$') IS TRUE)
);

INSERT INTO meeting_knowledge.question_reconciliation_checkpoints
  (checkpoint_key, after_question_id)
VALUES ('discord-active-questions-v1', NULL);

COMMENT ON TABLE meeting_knowledge.question_reconciliation_checkpoints IS
  'Crash-resumable bounded keyset checkpoint for Discord question reconciliation.';
