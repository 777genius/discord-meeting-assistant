CREATE SCHEMA IF NOT EXISTS meeting_knowledge;

CREATE TABLE meeting_knowledge.question_jobs (
  question_id text PRIMARY KEY,
  requester_subject text NOT NULL,
  question_hash text NOT NULL,
  scope_id text NOT NULL,
  final_projection_receipt text NOT NULL,
  authorization_principal_ref text,
  authorization_digest text NOT NULL,
  locale text NOT NULL,
  question_text text,
  binding jsonb,
  binding_hash text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  outcome text,
  attempts integer NOT NULL DEFAULT 0,
  generation bigint NOT NULL DEFAULT 0,
  lease_owner text,
  lease_until timestamptz,
  grounding_plan jsonb,
  grounding_measurement jsonb,
  runtime_profile text,
  answer_candidate jsonb,
  retry_reason text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  ready_at timestamptz,
  terminal_at timestamptz,
  scrubbed_at timestamptz,
  CONSTRAINT question_jobs_requester_subject_is_sha256
    CHECK ((requester_subject ~ '^[a-f0-9]{64}$') IS TRUE),
  CONSTRAINT question_jobs_question_hash_is_sha256
    CHECK ((question_hash ~ '^[a-f0-9]{64}$') IS TRUE),
  CONSTRAINT question_jobs_authorization_digest_is_sha256
    CHECK ((authorization_digest ~ '^[a-f0-9]{64}$') IS TRUE),
  CONSTRAINT question_jobs_binding_hash_is_sha256
    CHECK ((binding_hash ~ '^[a-f0-9]{64}$') IS TRUE),
  CONSTRAINT question_jobs_locale_is_supported
    CHECK ((locale IN ('ru', 'en', 'mixed')) IS TRUE),
  CONSTRAINT question_jobs_state_is_supported
    CHECK ((state IN ('queued', 'running', 'ready', 'terminal')) IS TRUE),
  CONSTRAINT question_jobs_outcome_is_supported
    CHECK ((outcome IS NULL OR outcome IN (
      'answered', 'cancelled', 'delivery_unknown', 'expired',
      'insufficient_evidence', 'not_a_question', 'processing',
      'stale_authorization', 'stale_binding', 'unavailable', 'unsupported_size'
    )) IS TRUE),
  CONSTRAINT question_jobs_attempts_are_bounded
    CHECK ((attempts BETWEEN 0 AND 32) IS TRUE),
  CONSTRAINT question_jobs_generation_is_valid
    CHECK ((generation BETWEEN 0 AND 9007199254740991) IS TRUE),
  CONSTRAINT question_jobs_active_content_is_consistent
    CHECK (((state = 'terminal') OR (
      authorization_principal_ref IS NOT NULL AND
      question_text IS NOT NULL AND
      binding IS NOT NULL
    )) IS TRUE),
  CONSTRAINT question_jobs_terminal_is_scrubbed
    CHECK (((state <> 'terminal') OR (
      outcome IS NOT NULL AND
      terminal_at IS NOT NULL AND
      scrubbed_at IS NOT NULL AND
      authorization_principal_ref IS NULL AND
      question_text IS NULL AND
      binding IS NULL AND
      grounding_plan IS NULL AND
      answer_candidate IS NULL
    )) IS TRUE),
  CONSTRAINT question_jobs_nonterminal_has_no_outcome
    CHECK (((state = 'terminal') OR (outcome IS NULL AND terminal_at IS NULL)) IS TRUE),
  CONSTRAINT question_jobs_ready_has_candidate
    CHECK (((state <> 'ready') OR (
      grounding_plan IS NOT NULL AND answer_candidate IS NOT NULL AND ready_at IS NOT NULL
    )) IS TRUE),
  CONSTRAINT question_jobs_expiry_follows_creation
    CHECK ((expires_at > created_at) IS TRUE)
);

CREATE INDEX question_jobs_dedupe_idx
  ON meeting_knowledge.question_jobs
    (requester_subject, question_hash, final_projection_receipt);

CREATE INDEX question_jobs_leasable_idx
  ON meeting_knowledge.question_jobs (state, lease_until, created_at, question_id)
  WHERE state IN ('queued', 'running', 'ready');

CREATE TABLE meeting_knowledge.question_rate_reservations (
  question_id text PRIMARY KEY
    REFERENCES meeting_knowledge.question_jobs(question_id) ON DELETE CASCADE,
  requester_subject text NOT NULL,
  scope_id text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT question_rate_requester_subject_is_sha256
    CHECK ((requester_subject ~ '^[a-f0-9]{64}$') IS TRUE)
);

CREATE INDEX question_rate_requester_window_idx
  ON meeting_knowledge.question_rate_reservations (requester_subject, reserved_at);
CREATE INDEX question_rate_scope_window_idx
  ON meeting_knowledge.question_rate_reservations (scope_id, reserved_at);

CREATE TABLE meeting_knowledge.unavailable_final_projections (
  final_projection_receipt text PRIMARY KEY,
  unavailable_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE meeting_core.answer_effects (
  effect_id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'reserved',
  projection_target_container_id text NOT NULL,
  reply_to_remote_message_id text NOT NULL,
  marker text NOT NULL,
  payload_bytes text NOT NULL,
  payload_hash text NOT NULL,
  binding_hash text NOT NULL,
  authorization_digest text NOT NULL,
  claim_generation bigint NOT NULL DEFAULT 0,
  claim_owner text,
  claim_until timestamptz,
  request_started_at timestamptz,
  external_receipt text,
  reserved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  settled_at timestamptz,
  CONSTRAINT answer_effects_state_is_supported
    CHECK ((state IN (
      'reserved', 'claimed', 'request_started', 'delivered', 'outcome_unknown',
      'cancelled', 'rejected_before_request', 'absent_unconfirmed'
    )) IS TRUE),
  CONSTRAINT answer_effects_payload_hash_is_sha256
    CHECK ((payload_hash ~ '^[a-f0-9]{64}$') IS TRUE),
  CONSTRAINT answer_effects_binding_hash_is_sha256
    CHECK ((binding_hash ~ '^[a-f0-9]{64}$') IS TRUE),
  CONSTRAINT answer_effects_authorization_digest_is_sha256
    CHECK ((authorization_digest ~ '^[a-f0-9]{64}$') IS TRUE),
  CONSTRAINT answer_effects_claim_generation_is_valid
    CHECK ((claim_generation BETWEEN 0 AND 9007199254740991) IS TRUE),
  CONSTRAINT answer_effects_request_receipt_is_consistent
    CHECK (((state NOT IN ('request_started', 'delivered', 'outcome_unknown', 'absent_unconfirmed')) OR
      request_started_at IS NOT NULL) IS TRUE),
  CONSTRAINT answer_effects_delivery_receipt_is_consistent
    CHECK (((state = 'delivered') = (external_receipt IS NOT NULL)) IS TRUE),
  CONSTRAINT answer_effects_payload_is_bounded
    CHECK ((octet_length(payload_bytes) BETWEEN 2 AND 16384) IS TRUE),
  CONSTRAINT answer_effects_terminal_payload_is_scrubbed
    CHECK (((state NOT IN ('delivered', 'cancelled', 'absent_unconfirmed')) OR
      payload_bytes = '{}') IS TRUE)
);

CREATE INDEX answer_effects_unknown_idx
  ON meeting_core.answer_effects (request_started_at, effect_id)
  WHERE state IN ('request_started', 'outcome_unknown');

COMMENT ON TABLE meeting_knowledge.question_jobs IS
  'Meeting Knowledge-owned collapsed durable jobs; sensitive content is scrubbed at terminal settlement.';
COMMENT ON TABLE meeting_core.answer_effects IS
  'Publishing-owned immutable one-attempt answer effects; request_started permanently forbids another create.';
