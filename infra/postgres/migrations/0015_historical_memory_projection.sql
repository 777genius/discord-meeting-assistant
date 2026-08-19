CREATE TABLE meeting_core.historical_memory_sync (
  release_id text PRIMARY KEY,
  meeting_id text NOT NULL
    REFERENCES meeting_core.meetings(meeting_id) ON DELETE RESTRICT,
  schema_version smallint NOT NULL,
  accepted_meeting_revision bigint NOT NULL,
  desired_generation bigint NOT NULL,
  transcript_id text NOT NULL,
  transcript_version bigint NOT NULL,
  evidence_policy_version text NOT NULL,
  scope_id text NOT NULL,
  room_id text NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  operation text NOT NULL DEFAULT 'index',
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  lease_fence bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  retry_after timestamptz,
  plan jsonb,
  remote_document_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error_code text,
  superseded_by_release_id text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT historical_memory_sync_schema_is_supported
    CHECK ((schema_version = 1) IS TRUE),
  CONSTRAINT historical_memory_sync_binding_is_valid
    CHECK ((
      length(release_id) BETWEEN 1 AND 2000 AND
      length(meeting_id) BETWEEN 1 AND 1000 AND
      length(transcript_id) BETWEEN 1 AND 1000 AND
      length(scope_id) BETWEEN 1 AND 1000 AND
      length(room_id) BETWEEN 1 AND 1000 AND
      accepted_meeting_revision BETWEEN 0 AND 9007199254740991 AND
      desired_generation BETWEEN 1 AND 9007199254740991 AND
      transcript_version BETWEEN 1 AND 9007199254740991
    ) IS TRUE),
  CONSTRAINT historical_memory_sync_operation_is_supported
    CHECK ((operation IN ('index', 'delete_release', 'delete_meeting')) IS TRUE),
  CONSTRAINT historical_memory_sync_state_is_supported
    CHECK ((state IN (
      'pending', 'in_flight', 'retry_wait', 'applied',
      'dead_letter', 'deleting', 'deleted'
    )) IS TRUE),
  CONSTRAINT historical_memory_sync_attempt_and_fence_are_valid
    CHECK ((attempt_count >= 0 AND lease_fence >= 0) IS TRUE),
  CONSTRAINT historical_memory_sync_plan_is_object
    CHECK ((plan IS NULL OR jsonb_typeof(plan) = 'object') IS TRUE),
  CONSTRAINT historical_memory_sync_remote_ids_are_object
    CHECK ((jsonb_typeof(remote_document_ids) = 'object') IS TRUE),
  CONSTRAINT historical_memory_sync_applied_has_plan
    CHECK ((state <> 'applied' OR (operation = 'index' AND plan IS NOT NULL)) IS TRUE),
  CONSTRAINT historical_memory_sync_release_generation_unique
    UNIQUE (meeting_id, desired_generation),
  CONSTRAINT historical_memory_sync_transcript_policy_unique
    UNIQUE (meeting_id, transcript_id, transcript_version, evidence_policy_version)
);

CREATE UNIQUE INDEX historical_memory_sync_current_meeting_idx
  ON meeting_core.historical_memory_sync (meeting_id)
  WHERE is_current;

CREATE INDEX historical_memory_sync_recoverable_idx
  ON meeting_core.historical_memory_sync (
    (CASE WHEN operation <> 'index' THEN 0 ELSE 1 END),
    COALESCE(retry_after, lease_expires_at, created_at),
    release_id
  )
  WHERE state IN ('pending', 'in_flight', 'retry_wait', 'deleting');

CREATE INDEX historical_memory_sync_room_idx
  ON meeting_core.historical_memory_sync (scope_id, room_id, meeting_id)
  WHERE is_current;

COMMENT ON TABLE meeting_core.historical_memory_sync IS
  'Purpose-specific transactional projection state for derived Infinity Context meeting evidence.';

CREATE TABLE meeting_core.historical_coverage_checkpoints (
  checkpoint_id text PRIMARY KEY,
  schema_version smallint NOT NULL,
  question_hash text NOT NULL,
  plan_digest text NOT NULL,
  release_bindings jsonb NOT NULL,
  block_locators jsonb NOT NULL,
  coverage_bitmap jsonb NOT NULL,
  extracts jsonb NOT NULL DEFAULT '{}'::jsonb,
  reduction jsonb,
  state text NOT NULL DEFAULT 'active',
  attempt_count integer NOT NULL DEFAULT 1,
  lease_fence bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  terminal_at timestamptz,
  terminal_reason text,
  retention_expires_at timestamptz NOT NULL DEFAULT
    (transaction_timestamp() + interval '24 hours'),
  CONSTRAINT historical_coverage_schema_is_supported
    CHECK ((schema_version = 1) IS TRUE),
  CONSTRAINT historical_coverage_identity_is_valid
    CHECK ((
      length(checkpoint_id) BETWEEN 1 AND 1000 AND
      length(question_hash) BETWEEN 1 AND 1000 AND
      length(plan_digest) BETWEEN 1 AND 1000 AND
      attempt_count >= 1 AND
      lease_fence >= 1
    ) IS TRUE),
  CONSTRAINT historical_coverage_payloads_are_valid
    CHECK ((
      jsonb_typeof(release_bindings) = 'array' AND
      jsonb_typeof(block_locators) = 'array' AND
      jsonb_typeof(coverage_bitmap) = 'array' AND
      jsonb_array_length(block_locators) = jsonb_array_length(coverage_bitmap) AND
      jsonb_typeof(extracts) = 'object' AND
      (reduction IS NULL OR jsonb_typeof(reduction) = 'object')
    ) IS TRUE),
  CONSTRAINT historical_coverage_state_is_supported
    CHECK ((state IN ('active', 'completed', 'failed', 'invalidated')) IS TRUE),
  CONSTRAINT historical_coverage_completion_is_consistent
    CHECK (((state = 'completed') = (completed_at IS NOT NULL)) IS TRUE),
  CONSTRAINT historical_coverage_terminal_is_consistent
    CHECK (((state = 'active') = (terminal_at IS NULL)) IS TRUE),
  CONSTRAINT historical_coverage_failure_reason_is_present
    CHECK (((state NOT IN ('failed', 'invalidated')) OR
      (terminal_reason IS NOT NULL AND length(terminal_reason) BETWEEN 1 AND 500)) IS TRUE)
);

COMMENT ON TABLE meeting_core.historical_coverage_checkpoints IS
  'Fenced every-block coverage bitmap and structured extract/reduce checkpoint; it never stores answer prose.';
