ALTER TABLE meeting_core.conversation_one_shot_receipts
  DROP CONSTRAINT conversation_one_shot_receipts_state_is_valid;

ALTER TABLE meeting_core.conversation_one_shot_receipts
  ADD CONSTRAINT conversation_one_shot_receipts_state_is_valid
  CHECK ((
    state IN ('reserved', 'completed', 'attempted', 'played', 'suppressed') AND
    (suppression_reason IS NULL OR suppression_reason IN ('ambiguous', 'stale')) AND
    (
      (state = 'reserved' AND lease_token IS NOT NULL AND
        lease_expires_at IS NOT NULL AND completed_at IS NULL AND
        suppression_reason IS NULL) OR
      (state = 'attempted' AND lease_token IS NOT NULL AND
        lease_expires_at IS NULL AND completed_at IS NULL AND
        suppression_reason IS NULL) OR
      (state = 'completed' AND lease_token IS NULL AND
        lease_expires_at IS NULL AND completed_at IS NOT NULL AND
        suppression_reason IS NULL) OR
      (state = 'played' AND lease_token IS NULL AND
        lease_expires_at IS NULL AND completed_at IS NOT NULL AND
        suppression_reason IS NULL) OR
      (state = 'suppressed' AND lease_token IS NULL AND
        lease_expires_at IS NULL AND completed_at IS NOT NULL AND
        suppression_reason IS NOT NULL)
    )
  ) IS TRUE);

COMMENT ON TABLE meeting_core.conversation_one_shot_receipts IS
  'Opaque fenced receipts with explicit attempted, played, and suppressed cue outcomes.';
