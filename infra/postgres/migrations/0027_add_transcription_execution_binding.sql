-- Migration 0027 adds the immutable transcription execution binding.
ALTER TABLE meeting_core.post_call_outbox
  ADD COLUMN IF NOT EXISTS transcription_execution_binding text;

-- Legacy binaries omit this column during rolling deploy or code rollback.
-- Their work is genuinely bound to the frozen legacy profile and remains
-- eligible for legacy recovery. New binaries write TRUE together with the
-- selected binding in the same transaction.
ALTER TABLE meeting_core.post_call_outbox
  ADD COLUMN IF NOT EXISTS transcription_execution_binding_required boolean
  NOT NULL DEFAULT FALSE;

-- Binding-aware rows keep the legacy recovery timestamp at infinity so a
-- still-running V1 dispatcher cannot discover them with its historical query.
-- V2 owns an independent retry clock that V1 does not know exists.
ALTER TABLE meeting_core.post_call_outbox
  ADD COLUMN IF NOT EXISTS binding_recovery_after timestamptz;

ALTER TABLE meeting_core.post_call_outbox
  DROP CONSTRAINT IF EXISTS post_call_outbox_recovery_receipt_is_consistent;

ALTER TABLE meeting_core.post_call_outbox
  ADD CONSTRAINT post_call_outbox_recovery_receipt_is_consistent
  CHECK ((
    (
      transcription_execution_binding_required = FALSE
      AND binding_recovery_after IS NULL
      AND (
        (recovery_generation = 0
          AND recovery_after IS NULL
          AND recovery_source_job_ref IS NULL)
        OR
        (recovery_generation > 0
          AND recovery_after IS NOT NULL
          AND recovery_source_job_ref IS NOT NULL)
      )
    )
    OR
    (
      transcription_execution_binding_required = TRUE
      AND recovery_after = 'infinity'::timestamptz
      AND (
        (recovery_generation = 0
          AND binding_recovery_after IS NULL
          AND recovery_source_job_ref IS NULL)
        OR
        (recovery_generation > 0
          AND binding_recovery_after IS NOT NULL
          AND recovery_source_job_ref IS NOT NULL)
      )
    )
  ) IS TRUE) NOT VALID;

ALTER TABLE meeting_core.post_call_outbox
  DROP CONSTRAINT IF EXISTS post_call_outbox_transcription_execution_binding_is_bounded;

ALTER TABLE meeting_core.post_call_outbox
  ADD CONSTRAINT post_call_outbox_transcription_execution_binding_is_bounded
  CHECK (
    transcription_execution_binding IS NULL OR (
      char_length(transcription_execution_binding) BETWEEN 1 AND 128
      AND transcription_execution_binding ~ '^[a-z0-9][a-z0-9._:-]*$'
    )
  ) NOT VALID;

ALTER TABLE meeting_core.post_call_outbox
  DROP CONSTRAINT IF EXISTS post_call_outbox_required_transcription_binding_is_present;

ALTER TABLE meeting_core.post_call_outbox
  ADD CONSTRAINT post_call_outbox_required_transcription_binding_is_present
  CHECK (
    NOT transcription_execution_binding_required
    OR transcription_execution_binding IS NOT NULL
  ) NOT VALID;

ALTER TABLE meeting_core.post_call_outbox
  DROP CONSTRAINT IF EXISTS post_call_outbox_bound_work_is_hidden_from_legacy_recovery;

ALTER TABLE meeting_core.post_call_outbox
  ADD CONSTRAINT post_call_outbox_bound_work_is_hidden_from_legacy_recovery
  CHECK (
    NOT transcription_execution_binding_required
    OR recovery_after = 'infinity'::timestamptz
  ) NOT VALID;

CREATE OR REPLACE FUNCTION meeting_core.reject_transcription_execution_binding_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.transcription_execution_binding IS NOT NULL
    AND NEW.transcription_execution_binding IS DISTINCT FROM OLD.transcription_execution_binding
  THEN
    RAISE EXCEPTION 'transcription execution binding is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS post_call_outbox_transcription_execution_binding_is_immutable
  ON meeting_core.post_call_outbox;

CREATE TRIGGER post_call_outbox_transcription_execution_binding_is_immutable
BEFORE UPDATE OF transcription_execution_binding ON meeting_core.post_call_outbox
FOR EACH ROW
EXECUTE FUNCTION meeting_core.reject_transcription_execution_binding_change();

COMMENT ON COLUMN meeting_core.post_call_outbox.transcription_execution_binding IS
  'Immutable composition-owned execution binding for authoritative final transcription.';

COMMENT ON COLUMN meeting_core.post_call_outbox.binding_recovery_after IS
  'V2-only retry clock for binding-aware work hidden from legacy recovery.';
