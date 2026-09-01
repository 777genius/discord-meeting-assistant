DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM meeting_core.conversation_one_shot_receipts
    WHERE cue_kind = 'greeting' AND state IN ('attempted', 'completed', 'played')
  ) THEN
    RAISE EXCEPTION
      'cannot activate provider-attested greeting playback with ambiguous or unattested legacy receipts';
  END IF;
END
$migration$;

ALTER TABLE meeting_core.conversation_one_shot_receipts
  DROP CONSTRAINT conversation_one_shot_receipts_state_is_valid;

ALTER TABLE meeting_core.conversation_one_shot_receipts
  ADD COLUMN provider_command_id text,
  ADD COLUMN provider_command_locale text,
  ADD COLUMN provider_command_prompt text,
  ADD COLUMN provider_started_at timestamptz,
  ADD COLUMN provider_recovery_expires_at timestamptz;

UPDATE meeting_core.conversation_one_shot_receipts
SET provider_command_id = 'participant-greeting:' || receipt_id
WHERE cue_kind = 'greeting';

ALTER TABLE meeting_core.conversation_one_shot_receipts
  ADD CONSTRAINT conversation_one_shot_receipts_provider_command_is_valid
  CHECK ((
    (cue_kind = 'greeting' AND
      provider_command_id ~ '^participant-greeting:[a-f0-9]{64}$') OR
    (cue_kind = 'farewell' AND provider_command_id IS NULL)
  ) IS TRUE),
  ADD CONSTRAINT conversation_one_shot_receipts_provider_command_payload_is_valid
  CHECK ((
    (provider_command_locale IS NULL AND provider_command_prompt IS NULL) OR
    (cue_kind = 'greeting' AND provider_command_locale IN ('en', 'ru') AND
      length(provider_command_prompt) BETWEEN 1 AND 1024)
  ) IS TRUE),
  ADD CONSTRAINT conversation_one_shot_receipts_state_is_valid
  CHECK ((
    state IN ('reserved', 'completed', 'attempted', 'commanded', 'started', 'played', 'suppressed') AND
    (suppression_reason IS NULL OR suppression_reason IN ('ambiguous', 'stale', 'capacity')) AND
    (
      (state = 'reserved' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND
        completed_at IS NULL AND provider_started_at IS NULL AND suppression_reason IS NULL AND
        provider_command_locale IS NULL AND provider_command_prompt IS NULL AND
        provider_recovery_expires_at IS NULL) OR
      (state = 'commanded' AND cue_kind = 'greeting' AND lease_token IS NOT NULL AND
        lease_expires_at IS NOT NULL AND completed_at IS NULL AND provider_started_at IS NULL AND
        suppression_reason IS NULL AND provider_command_locale IS NOT NULL AND
        provider_command_prompt IS NOT NULL AND provider_recovery_expires_at IS NOT NULL) OR
      (state = 'started' AND cue_kind = 'greeting' AND lease_token IS NOT NULL AND
        lease_expires_at IS NULL AND completed_at IS NULL AND provider_started_at IS NOT NULL AND
        suppression_reason IS NULL AND provider_command_locale IS NOT NULL AND
        provider_command_prompt IS NOT NULL AND provider_recovery_expires_at IS NOT NULL) OR
      (state = 'attempted' AND cue_kind = 'farewell' AND lease_token IS NOT NULL AND
        lease_expires_at IS NULL AND completed_at IS NULL AND provider_started_at IS NULL AND
        suppression_reason IS NULL) OR
      (state = 'completed' AND lease_token IS NULL AND lease_expires_at IS NULL AND
        completed_at IS NOT NULL AND provider_started_at IS NULL AND suppression_reason IS NULL) OR
      (state = 'played' AND lease_token IS NULL AND lease_expires_at IS NULL AND
        completed_at IS NOT NULL AND suppression_reason IS NULL AND (
          (cue_kind = 'greeting' AND provider_started_at IS NOT NULL) OR
          (cue_kind = 'farewell' AND provider_started_at IS NULL)
        )) OR
      (state = 'suppressed' AND lease_token IS NULL AND lease_expires_at IS NULL AND
        completed_at IS NOT NULL AND suppression_reason IS NOT NULL)
    )
  ) IS TRUE);

COMMENT ON TABLE meeting_core.conversation_one_shot_receipts IS
  'Opaque fenced receipts; greeting commands are recoverable only before their immutable provider-dedup deadline.';

COMMENT ON COLUMN meeting_core.conversation_one_shot_receipts.provider_recovery_expires_at IS
  'Exclusive durable reissue deadline, fixed when the greeting command is first committed and bounded inside provider dedup retention.';

CREATE TABLE meeting_core.conversation_greeting_capacity_admissions (
  scope_id text NOT NULL,
  receipt_id text PRIMARY KEY,
  admitted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT conversation_greeting_capacity_scope_is_valid
    CHECK (scope_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT conversation_greeting_capacity_receipt_is_valid
    CHECK (receipt_id ~ '^[a-f0-9]{64}$')
);

CREATE INDEX conversation_greeting_capacity_admissions_scope_idx
  ON meeting_core.conversation_greeting_capacity_admissions (scope_id);

COMMENT ON TABLE meeting_core.conversation_greeting_capacity_admissions IS
  'Durable atomic admission plan for bounded proactive greeting commands; terminal playback does not free capacity.';
