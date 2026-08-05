-- Stop-first schema contract hardening. This file has no BEGIN/COMMIT because
-- the production migration runner atomically commits the SQL and its checksum
-- ledger receipt under a PostgreSQL advisory transaction lock.

ALTER TABLE meeting_core.meetings
  DROP CONSTRAINT IF EXISTS meetings_snapshot_is_object,
  DROP CONSTRAINT IF EXISTS meetings_snapshot_identity_matches,
  DROP CONSTRAINT IF EXISTS meetings_snapshot_revision_matches;

ALTER TABLE meeting_core.meetings
  ADD CONSTRAINT meetings_snapshot_is_object
    CHECK ((jsonb_typeof(snapshot) = 'object') IS TRUE),
  ADD CONSTRAINT meetings_snapshot_identity_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'meetingId') = 'string' AND
      snapshot ->> 'meetingId' = meeting_id
    ) IS TRUE),
  ADD CONSTRAINT meetings_snapshot_revision_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'revision') = 'number' AND
      snapshot ->> 'revision' ~ '^(0|[1-9][0-9]*)$' AND
      (snapshot ->> 'revision')::bigint = revision
    ) IS TRUE);

ALTER TABLE meeting_core.live_meetings
  DROP CONSTRAINT IF EXISTS live_meetings_snapshot_is_object,
  DROP CONSTRAINT IF EXISTS live_meetings_snapshot_identity_matches,
  DROP CONSTRAINT IF EXISTS live_meetings_snapshot_revision_matches,
  DROP CONSTRAINT IF EXISTS live_meetings_snapshot_excludes_legacy_records;

ALTER TABLE meeting_core.live_meetings
  ADD CONSTRAINT live_meetings_snapshot_is_object
    CHECK ((jsonb_typeof(snapshot) = 'object') IS TRUE),
  ADD CONSTRAINT live_meetings_snapshot_identity_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'meetingId') = 'string' AND
      snapshot ->> 'meetingId' = meeting_id
    ) IS TRUE),
  ADD CONSTRAINT live_meetings_snapshot_revision_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'revision') = 'number' AND
      snapshot ->> 'revision' ~ '^(0|[1-9][0-9]*)$' AND
      (snapshot ->> 'revision')::bigint = revision
    ) IS TRUE),
  ADD CONSTRAINT live_meetings_snapshot_excludes_legacy_records
    CHECK ((NOT (snapshot ?| ARRAY[
      'turns',
      'summarizedTurnIds',
      'generationUsage',
      'generationTelemetry'
    ])) IS TRUE);

ALTER TABLE guild_configuration.guild_installations
  DROP CONSTRAINT IF EXISTS guild_installations_snapshot_is_object,
  DROP CONSTRAINT IF EXISTS guild_installations_snapshot_identity_matches,
  DROP CONSTRAINT IF EXISTS guild_installations_snapshot_revision_matches;

ALTER TABLE guild_configuration.guild_installations
  ADD CONSTRAINT guild_installations_snapshot_is_object
    CHECK ((jsonb_typeof(snapshot) = 'object') IS TRUE),
  ADD CONSTRAINT guild_installations_snapshot_identity_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'guildId') = 'string' AND
      snapshot ->> 'guildId' = guild_id
    ) IS TRUE),
  ADD CONSTRAINT guild_installations_snapshot_revision_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'revision') = 'number' AND
      snapshot ->> 'revision' ~ '^(0|[1-9][0-9]*)$' AND
      (snapshot ->> 'revision')::bigint = revision
    ) IS TRUE);

ALTER TABLE meeting_core.live_meeting_turns
  DROP CONSTRAINT IF EXISTS live_meeting_turn_is_object,
  DROP CONSTRAINT IF EXISTS live_meeting_turn_identity_matches,
  DROP CONSTRAINT IF EXISTS live_meeting_turn_timing_matches,
  DROP CONSTRAINT IF EXISTS live_meeting_turn_speaker_matches,
  DROP CONSTRAINT IF EXISTS live_meeting_turn_text_is_string;

ALTER TABLE meeting_core.live_meeting_turns
  ADD CONSTRAINT live_meeting_turn_is_object
    CHECK ((jsonb_typeof(turn) = 'object') IS TRUE),
  ADD CONSTRAINT live_meeting_turn_identity_matches
    CHECK ((
      jsonb_typeof(turn -> 'turnId') = 'string' AND
      turn ->> 'turnId' = turn_id
    ) IS TRUE),
  ADD CONSTRAINT live_meeting_turn_timing_matches
    CHECK ((
      jsonb_typeof(turn -> 'startMs') = 'number' AND
      jsonb_typeof(turn -> 'endMs') = 'number' AND
      turn ->> 'startMs' ~ '^(0|[1-9][0-9]*)$' AND
      turn ->> 'endMs' ~ '^(0|[1-9][0-9]*)$' AND
      (turn ->> 'startMs')::bigint = start_ms AND
      (turn ->> 'endMs')::bigint = end_ms
    ) IS TRUE),
  ADD CONSTRAINT live_meeting_turn_speaker_matches
    CHECK ((
      jsonb_typeof(turn -> 'speakerId') = 'string' AND
      turn ->> 'speakerId' = speaker_id
    ) IS TRUE),
  ADD CONSTRAINT live_meeting_turn_text_is_string
    CHECK ((jsonb_typeof(turn -> 'text') = 'string') IS TRUE);

ALTER TABLE meeting_core.live_meeting_generation_usage
  DROP CONSTRAINT IF EXISTS live_meeting_generation_usage_payload_is_object,
  DROP CONSTRAINT IF EXISTS live_meeting_generation_usage_identity_matches;

ALTER TABLE meeting_core.live_meeting_generation_usage
  ADD CONSTRAINT live_meeting_generation_usage_payload_is_object
    CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  ADD CONSTRAINT live_meeting_generation_usage_identity_matches
    CHECK ((
      jsonb_typeof(payload -> 'runId') = 'string' AND
      payload ->> 'runId' = run_id
    ) IS TRUE);

ALTER TABLE meeting_core.live_meeting_generation_telemetry
  DROP CONSTRAINT IF EXISTS live_meeting_generation_telemetry_payload_is_object,
  DROP CONSTRAINT IF EXISTS live_meeting_generation_telemetry_identity_matches;

ALTER TABLE meeting_core.live_meeting_generation_telemetry
  ADD CONSTRAINT live_meeting_generation_telemetry_payload_is_object
    CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  ADD CONSTRAINT live_meeting_generation_telemetry_identity_matches
    CHECK ((
      jsonb_typeof(payload -> 'runId') = 'string' AND
      payload ->> 'runId' = run_id
    ) IS TRUE);

ALTER TABLE meeting_core.live_meeting_summary_coverage
  DROP CONSTRAINT IF EXISTS live_meeting_summary_coverage_revision_is_positive;

ALTER TABLE meeting_core.live_meeting_summary_coverage
  ADD CONSTRAINT live_meeting_summary_coverage_revision_is_positive
    CHECK ((first_summary_revision >= 1) IS TRUE);

ALTER TABLE meeting_core.post_call_outbox
  ADD COLUMN IF NOT EXISTS last_enqueued_at timestamptz,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

UPDATE meeting_core.post_call_outbox
SET last_enqueued_at = dispatched_at
WHERE last_enqueued_at IS NULL
  AND dispatched_at IS NOT NULL;

ALTER TABLE meeting_core.post_call_outbox
  DROP CONSTRAINT IF EXISTS post_call_outbox_schema_version_check,
  DROP CONSTRAINT IF EXISTS post_call_outbox_schema_version_is_supported;

ALTER TABLE meeting_core.post_call_outbox
  ADD CONSTRAINT post_call_outbox_schema_version_is_supported
    CHECK ((schema_version = 1) IS TRUE);

DROP INDEX IF EXISTS meeting_core.post_call_outbox_pending_idx;
CREATE INDEX IF NOT EXISTS post_call_outbox_recoverable_idx
  ON meeting_core.post_call_outbox (created_at, meeting_id)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS meeting_core.post_call_dead_letters (
  source_job_ref text PRIMARY KEY,
  schema_version smallint NOT NULL,
  meeting_id text,
  attempts_made integer NOT NULL,
  failure_code text NOT NULL,
  retryable boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT post_call_dead_letters_schema_version_is_supported
    CHECK ((schema_version = 1) IS TRUE),
  CONSTRAINT post_call_dead_letters_source_job_ref_is_sha256
    CHECK ((source_job_ref ~ '^[a-f0-9]{64}$') IS TRUE),
  CONSTRAINT post_call_dead_letters_attempts_are_positive
    CHECK ((attempts_made > 0) IS TRUE),
  CONSTRAINT post_call_dead_letters_failure_code_is_valid
    CHECK ((failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$') IS TRUE)
);

CREATE INDEX IF NOT EXISTS post_call_dead_letters_recorded_idx
  ON meeting_core.post_call_dead_letters (recorded_at, source_job_ref);

COMMENT ON COLUMN meeting_core.post_call_outbox.dispatched_at IS
  'Legacy Redis enqueue observation. It is not a durable processing receipt and never suppresses recovery.';
COMMENT ON COLUMN meeting_core.post_call_outbox.last_enqueued_at IS
  'Last observed enqueue attempt. Recoverability remains controlled exclusively by processed_at.';
COMMENT ON COLUMN meeting_core.post_call_outbox.processed_at IS
  'Durable terminal processing receipt. Only this value removes an item from reconciliation.';
COMMENT ON TABLE meeting_core.post_call_dead_letters IS
  'Durable, idempotent terminal post-call failure evidence independent of Redis DLQ availability.';
