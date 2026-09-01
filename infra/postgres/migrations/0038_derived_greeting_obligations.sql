CREATE TABLE meeting_core.derived_greeting_obligations (
  event_id text PRIMARY KEY,
  recording_id text NOT NULL,
  participant_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  memory_actor_id text,
  memory_producer_revision text,
  state text NOT NULL DEFAULT 'pending',
  accepted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  terminal_at timestamptz,
  CONSTRAINT derived_greeting_obligations_identity_is_valid
    CHECK ((length(event_id) BETWEEN 1 AND 256 AND
      length(recording_id) BETWEEN 1 AND 256 AND
      length(participant_id) BETWEEN 1 AND 256) IS TRUE),
  CONSTRAINT derived_greeting_obligations_memory_is_complete
    CHECK (((memory_actor_id IS NULL) = (memory_producer_revision IS NULL)) IS TRUE),
  CONSTRAINT derived_greeting_obligations_deadline_is_exact
    CHECK ((not_after = occurred_at + interval '5 seconds') IS TRUE),
  CONSTRAINT derived_greeting_obligations_state_is_valid
    CHECK (((state = 'pending' AND terminal_at IS NULL) OR
      (state IN ('delivered', 'expired') AND terminal_at IS NOT NULL)) IS TRUE)
);

CREATE INDEX derived_greeting_obligations_pending_idx
  ON meeting_core.derived_greeting_obligations (occurred_at, event_id)
  WHERE state = 'pending';

COMMENT ON TABLE meeting_core.derived_greeting_obligations IS
  'Replayable participant-join greeting effects retained before durable HTTP acknowledgement.';
