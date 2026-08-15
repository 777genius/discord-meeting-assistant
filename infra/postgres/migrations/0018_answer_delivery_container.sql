ALTER TABLE meeting_core.answer_effects
  ADD COLUMN delivery_container_id text;

-- A projection receipt is the persisted authority for where its question was
-- posted. In thread mode this deliberately yields the thread, never the
-- canonical parent results container.
WITH legacy_question_locations AS (
  SELECT question_id,
         COALESCE(
           substring(final_projection_receipt FROM
             '^discord:v[12]:thread:([0-9]{17,20}):message:[0-9]{17,20}$'),
           substring(final_projection_receipt FROM
             '^discord:v2:channel:([0-9]{17,20}):message:[0-9]{17,20}$')
         ) AS delivery_container_id
  FROM meeting_knowledge.question_jobs
  WHERE binding IS NOT NULL
)
UPDATE meeting_knowledge.question_jobs AS job
SET binding = jsonb_set(
      job.binding,
      '{deliveryContainerId}',
      to_jsonb(location.delivery_container_id),
      true
    ),
    updated_at = transaction_timestamp()
FROM legacy_question_locations AS location
WHERE job.question_id = location.question_id
  AND location.delivery_container_id IS NOT NULL
  AND NOT (job.binding ? 'deliveryContainerId');

-- An active legacy job without a canonical question location cannot be routed
-- safely. Scrub and terminalize it instead of guessing the projection parent.
UPDATE meeting_knowledge.question_jobs AS job
SET state = 'terminal',
    outcome = 'stale_binding',
    authorization_principal_ref = NULL,
    question_text = NULL,
    binding = NULL,
    grounding_plan = NULL,
    answer_candidate = NULL,
    lease_owner = NULL,
    lease_until = NULL,
    terminal_at = COALESCE(terminal_at, transaction_timestamp()),
    scrubbed_at = COALESCE(scrubbed_at, transaction_timestamp()),
    updated_at = transaction_timestamp()
WHERE state <> 'terminal'
  AND (binding IS NULL OR NOT (binding ? 'deliveryContainerId'));

-- Before request_started the question receipt is the desired delivery
-- authority. After request_started the immutable payload is the authority for
-- the container where bytes may actually have crossed the boundary.
WITH legacy_effect_locations AS (
  SELECT effect.effect_id,
         CASE
           WHEN effect.state IN ('request_started', 'outcome_unknown') THEN
             CASE
               WHEN effect.payload_bytes::jsonb #>> '{message_reference,channel_id}'
                    ~ '^[0-9]{17,20}$'
               THEN effect.payload_bytes::jsonb #>> '{message_reference,channel_id}'
               ELSE NULL
             END
           WHEN effect.state IN ('delivered', 'absent_unconfirmed') AND
                job.final_projection_receipt LIKE 'discord:v%:thread:%'
             THEN NULL
           ELSE job.binding ->> 'deliveryContainerId'
         END AS delivery_container_id
  FROM meeting_core.answer_effects AS effect
  LEFT JOIN meeting_knowledge.question_jobs AS job
    ON effect.effect_id = 'meeting-knowledge-answer:v1:' || job.question_id
)
UPDATE meeting_core.answer_effects AS effect
SET delivery_container_id = location.delivery_container_id,
    updated_at = transaction_timestamp()
FROM legacy_effect_locations AS location
WHERE effect.effect_id = location.effect_id;

-- A legacy request that may already have crossed Discord's boundary is never
-- re-entered through the upgraded publication path. Reconciliation retains the
-- effect evidence independently; the sensitive question job is settled now.
UPDATE meeting_knowledge.question_jobs AS job
SET state = 'terminal',
    outcome = CASE WHEN effect.state = 'delivered'
      THEN 'answered'
      ELSE 'delivery_unknown'
    END,
    authorization_principal_ref = NULL,
    question_text = NULL,
    binding = NULL,
    grounding_plan = NULL,
    answer_candidate = NULL,
    lease_owner = NULL,
    lease_until = NULL,
    terminal_at = COALESCE(terminal_at, transaction_timestamp()),
    scrubbed_at = COALESCE(scrubbed_at, transaction_timestamp()),
    updated_at = transaction_timestamp()
FROM meeting_core.answer_effects AS effect
WHERE effect.effect_id = 'meeting-knowledge-answer:v1:' || job.question_id
  AND job.state <> 'terminal'
  AND effect.state IN (
    'request_started', 'delivered', 'outcome_unknown', 'absent_unconfirmed'
  );

-- Missing post-request routing evidence can never authorize another create or
-- an absence claim. Missing pre-request routing evidence is cancelled. Both
-- paths retain non-sensitive hashes/receipts for audit while scrubbing bytes.
UPDATE meeting_core.answer_effects
SET state = CASE
      WHEN state IN ('request_started', 'outcome_unknown')
        THEN 'absent_unconfirmed'
      ELSE 'cancelled'
    END,
    payload_bytes = '{}',
    claim_until = NULL,
    settled_at = COALESCE(settled_at, transaction_timestamp()),
    updated_at = transaction_timestamp()
WHERE delivery_container_id IS NULL
  AND state IN ('reserved', 'claimed', 'request_started', 'outcome_unknown');

ALTER TABLE meeting_core.answer_effects
  ADD CONSTRAINT answer_effects_actionable_delivery_is_known
  CHECK ((delivery_container_id IS NOT NULL OR state IN (
    'delivered', 'cancelled', 'rejected_before_request', 'absent_unconfirmed'
  )) IS TRUE);

COMMENT ON COLUMN meeting_core.answer_effects.projection_target_container_id IS
  'Canonical projection scope used for authority and deletion fencing.';
COMMENT ON COLUMN meeting_core.answer_effects.delivery_container_id IS
  'Actual immutable create/reconciliation container; NULL only for safely terminalized legacy effects whose route is unrecoverable.';
