CREATE TABLE meeting_knowledge.live_memory_meetings (
  meeting_id text PRIMARY KEY
    REFERENCES meeting_core.live_meetings(meeting_id) ON DELETE CASCADE,
  schema_version smallint NOT NULL,
  scope_id text NOT NULL,
  room_id text NOT NULL,
  producer_capability_id text NOT NULL,
  actor_semantics_version bigint NOT NULL,
  producer_revision text NOT NULL,
  human_actor_ids jsonb NOT NULL,
  roster_state text NOT NULL,
  identity_generation bigint NOT NULL DEFAULT 1,
  source_generation bigint NOT NULL DEFAULT 0,
  applied_generation bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT live_memory_meetings_schema_is_supported
    CHECK ((schema_version = 1) IS TRUE),
  CONSTRAINT live_memory_meetings_identity_is_valid
    CHECK ((
      length(scope_id) BETWEEN 1 AND 1000 AND
      length(room_id) BETWEEN 1 AND 1000 AND
      length(producer_capability_id) BETWEEN 1 AND 1000 AND
      actor_semantics_version >= 1 AND
      length(producer_revision) BETWEEN 1 AND 1000 AND
      jsonb_typeof(human_actor_ids) = 'array' AND
      jsonb_array_length(human_actor_ids) >= 0 AND
      roster_state IN ('sealed', 'unsealed') AND
      identity_generation >= 1 AND
      source_generation >= 0 AND
      applied_generation BETWEEN 0 AND source_generation
    ) IS TRUE),
  CONSTRAINT live_memory_meetings_state_is_supported
    CHECK ((state IN ('active', 'ended', 'withdrawn')) IS TRUE)
);

CREATE TABLE meeting_knowledge.live_memory_outbox (
  mutation_id text PRIMARY KEY,
  meeting_id text NOT NULL,
  turn_id text NOT NULL,
  source_generation bigint NOT NULL,
  identity_generation bigint NOT NULL,
  turn_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  lease_fence bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  retry_after timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT live_memory_outbox_meeting_id_fkey
    FOREIGN KEY (meeting_id)
      REFERENCES meeting_knowledge.live_memory_meetings(meeting_id) ON DELETE CASCADE,
  CONSTRAINT live_memory_outbox_meeting_id_turn_id_fkey
    FOREIGN KEY (meeting_id, turn_id)
      REFERENCES meeting_core.live_meeting_turns(meeting_id, turn_id) ON DELETE CASCADE,
  CONSTRAINT live_memory_outbox_identity_is_valid
    CHECK ((
      mutation_id ~ '^[a-f0-9]{64}$' AND
      length(meeting_id) BETWEEN 1 AND 1000 AND
      length(turn_id) BETWEEN 1 AND 1000 AND
      source_generation >= 1 AND
      identity_generation >= 1 AND
      turn_hash ~ '^[a-f0-9]{64}$' AND
      attempt_count >= 0 AND
      lease_fence >= 0
    ) IS TRUE),
  CONSTRAINT live_memory_outbox_state_is_supported
    CHECK ((state IN (
      'pending', 'in_flight', 'retry_wait', 'applied', 'dead_letter'
    )) IS TRUE),
  CONSTRAINT live_memory_outbox_lease_is_consistent
    CHECK (((state = 'in_flight') = (lease_expires_at IS NOT NULL)) IS TRUE),
  CONSTRAINT live_memory_outbox_meeting_generation_unique
    UNIQUE (meeting_id, source_generation),
  CONSTRAINT live_memory_outbox_meeting_turn_unique
    UNIQUE (meeting_id, turn_id)
);

CREATE INDEX live_memory_outbox_recoverable_idx
  ON meeting_knowledge.live_memory_outbox (
    COALESCE(retry_after, lease_expires_at, created_at),
    meeting_id,
    source_generation
  )
  WHERE state IN ('pending', 'in_flight', 'retry_wait');

CREATE TABLE meeting_knowledge.live_memory_hot_tail (
  meeting_id text NOT NULL,
  turn_id text NOT NULL,
  source_generation bigint NOT NULL,
  identity_generation bigint NOT NULL,
  turn_hash text NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT live_memory_hot_tail_pkey PRIMARY KEY (meeting_id, turn_id),
  CONSTRAINT live_memory_hot_tail_meeting_id_fkey
    FOREIGN KEY (meeting_id)
      REFERENCES meeting_knowledge.live_memory_meetings(meeting_id) ON DELETE CASCADE,
  CONSTRAINT live_memory_hot_tail_meeting_id_turn_id_fkey
    FOREIGN KEY (meeting_id, turn_id)
      REFERENCES meeting_core.live_meeting_turns(meeting_id, turn_id) ON DELETE CASCADE,
  CONSTRAINT live_memory_hot_tail_identity_is_valid
    CHECK ((
      source_generation >= 1 AND
      identity_generation >= 1 AND
      turn_hash ~ '^[a-f0-9]{64}$'
    ) IS TRUE),
  CONSTRAINT live_memory_hot_tail_meeting_generation_unique
    UNIQUE (meeting_id, source_generation)
);

CREATE INDEX live_memory_hot_tail_generation_idx
  ON meeting_knowledge.live_memory_hot_tail (
    meeting_id,
    source_generation DESC
  );

COMMENT ON TABLE meeting_knowledge.live_memory_outbox IS
  'Text-free durable idempotent stream of trusted finalized live-turn locators.';
COMMENT ON TABLE meeting_knowledge.live_memory_hot_tail IS
  'Bounded text-free live-memory locator projection; canonical text remains in live_meeting_turns.';
