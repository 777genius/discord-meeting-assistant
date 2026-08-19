CREATE TABLE meeting_core.conversation_one_shot_receipts (
  receipt_id text PRIMARY KEY,
  cue_kind text NOT NULL,
  state text NOT NULL DEFAULT 'reserved',
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  CONSTRAINT conversation_one_shot_receipts_identity_is_valid
    CHECK ((
      receipt_id ~ '^[a-f0-9]{64}$' AND
      cue_kind IN ('farewell', 'greeting')
    ) IS TRUE),
  CONSTRAINT conversation_one_shot_receipts_state_is_valid
    CHECK ((
      state IN ('reserved', 'completed') AND
      ((state = 'completed') = (completed_at IS NOT NULL)) AND
      ((state = 'reserved') = (
        lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      ))
    ) IS TRUE)
);

COMMENT ON TABLE meeting_core.conversation_one_shot_receipts IS
  'Opaque fenced, expiring reserve/complete receipts for greeting and farewell playback.';
