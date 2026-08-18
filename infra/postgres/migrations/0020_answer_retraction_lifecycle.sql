ALTER TABLE meeting_knowledge.question_jobs
  ADD COLUMN source_meeting_ids text[] NOT NULL DEFAULT ARRAY[]::text[];

UPDATE meeting_knowledge.question_jobs
SET source_meeting_ids = ARRAY[binding ->> 'meetingId']::text[]
WHERE binding ->> 'meetingId' IS NOT NULL
  AND cardinality(source_meeting_ids) = 0;

ALTER TABLE meeting_core.answer_effects
  ADD COLUMN source_meeting_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN retraction_requested_at timestamptz,
  ADD COLUMN retracted_at timestamptz;

UPDATE meeting_core.answer_effects AS effect
SET source_meeting_ids = job.source_meeting_ids
FROM meeting_knowledge.question_jobs AS job
WHERE effect.effect_id = 'meeting-knowledge-answer:v1:' || job.question_id
  AND cardinality(effect.source_meeting_ids) = 0
  AND cardinality(job.source_meeting_ids) > 0;

WITH projection_meetings AS (
  SELECT meeting.meeting_id,
         meeting.snapshot -> 'publication' ->> 'externalPublicationId' AS receipt
  FROM meeting_core.meetings AS meeting
  UNION ALL
  SELECT live.meeting_id, live.snapshot ->> 'projectionExternalId' AS receipt
  FROM meeting_core.live_meetings AS live
)
UPDATE meeting_core.answer_effects AS effect
SET source_meeting_ids = ARRAY[projection.meeting_id]::text[]
FROM meeting_knowledge.question_jobs AS job,
     projection_meetings AS projection
WHERE effect.effect_id = 'meeting-knowledge-answer:v1:' || job.question_id
  AND cardinality(effect.source_meeting_ids) = 0
  AND projection.receipt = job.final_projection_receipt;

UPDATE meeting_core.answer_effects
SET source_meeting_ids = ARRAY['legacy-unattributed:' || effect_id]::text[]
WHERE cardinality(source_meeting_ids) = 0;

ALTER TABLE meeting_core.answer_effects
  DROP CONSTRAINT answer_effects_state_is_supported,
  DROP CONSTRAINT answer_effects_request_receipt_is_consistent,
  DROP CONSTRAINT answer_effects_delivery_receipt_is_consistent,
  DROP CONSTRAINT answer_effects_terminal_payload_is_scrubbed,
  DROP CONSTRAINT answer_effects_actionable_delivery_is_known;

ALTER TABLE meeting_core.answer_effects
  ADD CONSTRAINT answer_effects_state_is_supported
    CHECK ((state IN (
      'reserved', 'claimed', 'request_started', 'delivered', 'outcome_unknown',
      'cancelled', 'rejected_before_request', 'absent_unconfirmed',
      'retraction_pending', 'retracted'
    )) IS TRUE),
  ADD CONSTRAINT answer_effects_request_receipt_is_consistent
    CHECK (((state NOT IN (
      'request_started', 'delivered', 'outcome_unknown', 'absent_unconfirmed',
      'retraction_pending', 'retracted'
    )) OR request_started_at IS NOT NULL) IS TRUE),
  ADD CONSTRAINT answer_effects_delivery_receipt_is_consistent
    CHECK (((state IN ('delivered', 'retracted')) = (external_receipt IS NOT NULL)
      OR state = 'retraction_pending') IS TRUE),
  ADD CONSTRAINT answer_effects_terminal_payload_is_scrubbed
    CHECK (((state NOT IN (
      'delivered', 'cancelled', 'absent_unconfirmed', 'retracted'
    )) OR payload_bytes = '{}') IS TRUE),
  ADD CONSTRAINT answer_effects_actionable_delivery_is_known
    CHECK ((delivery_container_id IS NOT NULL OR state IN (
      'delivered', 'cancelled', 'rejected_before_request',
      'absent_unconfirmed', 'retracted'
    )) IS TRUE),
  ADD CONSTRAINT answer_effects_source_meetings_are_bounded
    CHECK ((cardinality(source_meeting_ids) BETWEEN 1 AND 256) IS TRUE),
  ADD CONSTRAINT answer_effects_retraction_state_is_consistent
    CHECK (((state NOT IN ('retraction_pending', 'retracted') OR
      retraction_requested_at IS NOT NULL) AND
      (state <> 'retracted' OR retracted_at IS NOT NULL)) IS TRUE);

CREATE INDEX answer_effects_retraction_pending_idx
  ON meeting_core.answer_effects (updated_at, effect_id)
  WHERE state = 'retraction_pending';

COMMENT ON COLUMN meeting_core.answer_effects.source_meeting_ids IS
  'Exact authoritative meeting identities whose evidence the answer depends on.';
COMMENT ON COLUMN meeting_core.answer_effects.external_receipt IS
  'Exact Discord message receipt, retained through idempotent retraction.';
