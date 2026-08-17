ALTER TABLE meeting_core.post_call_outbox
  ADD COLUMN IF NOT EXISTS transcription_execution_binding text;

ALTER TABLE meeting_core.post_call_outbox
  DROP CONSTRAINT IF EXISTS post_call_outbox_transcription_execution_binding_is_bounded;

ALTER TABLE meeting_core.post_call_outbox
  ADD CONSTRAINT post_call_outbox_transcription_execution_binding_is_bounded
  CHECK (
    transcription_execution_binding IS NULL OR (
      char_length(transcription_execution_binding) BETWEEN 1 AND 128
      AND transcription_execution_binding ~ '^[a-z0-9][a-z0-9._:-]*$'
    )
  );

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
