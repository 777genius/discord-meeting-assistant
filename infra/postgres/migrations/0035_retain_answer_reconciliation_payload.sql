-- This lock is the pre-scan fence for workers running schema <= 34. It is
-- acquired before the trigger or snapshot exists, conflicts with their row
-- writes, and is retained through commit. After commit those workers observe
-- the durable v1 trigger before another unresolved update can execute.
LOCK TABLE meeting_core.answer_effects IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE meeting_core.answer_effects
  ADD COLUMN authority_scope_id text;

-- The admitted question scope is the authoritative Discord guild. It is not
-- scrubbed with the sensitive binding and therefore remains derivable for old
-- effects without guessing from a channel ID.
UPDATE meeting_core.answer_effects AS effect
SET authority_scope_id = job.scope_id
FROM meeting_knowledge.question_jobs AS job
WHERE effect.effect_id = 'meeting-knowledge-answer:v1:' || job.question_id
  AND job.scope_id <> '';

-- Orphaned effects can still derive the exact source scope when their retained
-- source meeting is authoritative and unambiguous.
WITH effect_scopes AS (
  SELECT effect.effect_id, min(meeting.snapshot -> 'source' ->> 'scopeId') AS scope_id
  FROM meeting_core.answer_effects AS effect
  JOIN meeting_core.meetings AS meeting
    ON meeting.meeting_id = ANY(effect.source_meeting_ids)
  WHERE effect.authority_scope_id IS NULL
    AND meeting.snapshot -> 'source' ->> 'scopeId' IS NOT NULL
  GROUP BY effect.effect_id
  HAVING count(DISTINCT meeting.snapshot -> 'source' ->> 'scopeId') = 1
)
UPDATE meeting_core.answer_effects AS effect
SET authority_scope_id = effect_scope.scope_id
FROM effect_scopes AS effect_scope
WHERE effect.effect_id = effect_scope.effect_id;

CREATE TABLE meeting_core.answer_effect_reconciliation_quarantine (
  effect_id text PRIMARY KEY,
  prior_state text NOT NULL,
  payload_hash text NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT answer_effect_quarantine_prior_state_is_supported
    CHECK ((prior_state IN (
      'request_started', 'delivered', 'outcome_unknown',
      'absent_unconfirmed', 'retraction_pending'
    )) IS TRUE),
  CONSTRAINT answer_effect_quarantine_reason_is_explicit
    CHECK ((reason IN (
      'legacy_payload_scrubbed_before_0035',
      'legacy_reconciliation_authority_absent_before_0035'
    )) IS TRUE)
);

CREATE OR REPLACE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.state IN (
        'request_started', 'delivered', 'outcome_unknown',
        'absent_unconfirmed', 'retraction_pending'
      ) OR NEW.state IN (
        'request_started', 'delivered', 'outcome_unknown',
        'absent_unconfirmed', 'retraction_pending'
      )) AND OLD.payload_hash IS DISTINCT FROM NEW.payload_hash THEN
    RAISE EXCEPTION 'unresolved answer reconciliation payload is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'answer_effects_unresolved_payload_is_immutable';
  END IF;
  IF NEW.state IN (
       'request_started', 'delivered', 'outcome_unknown',
       'absent_unconfirmed', 'retraction_pending'
     ) AND OLD.payload_bytes IS DISTINCT FROM NEW.payload_bytes THEN
    RAISE EXCEPTION 'unresolved answer reconciliation payload is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'answer_effects_unresolved_payload_is_immutable';
  END IF;
  IF OLD.state IN (
       'request_started', 'delivered', 'outcome_unknown',
       'absent_unconfirmed', 'retraction_pending'
     ) AND NEW.state NOT IN (
       'request_started', 'delivered', 'outcome_unknown',
       'absent_unconfirmed', 'retraction_pending', 'quarantined_unrecoverable'
     ) AND OLD.payload_bytes IS DISTINCT FROM NEW.payload_bytes AND NOT (
       OLD.state = 'retraction_pending' AND NEW.state = 'retracted' AND
       NEW.payload_bytes = '{}'
     ) THEN
    RAISE EXCEPTION 'unresolved answer reconciliation payload is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'answer_effects_unresolved_payload_is_immutable';
  END IF;
  IF NEW.state IN (
       'request_started', 'delivered', 'outcome_unknown',
       'absent_unconfirmed', 'retraction_pending'
     ) AND (
       octet_length(NEW.payload_bytes) <= 2 OR
       NEW.payload_bytes = '{}' OR
       NEW.payload_hash !~ '^[a-f0-9]{64}$'
     ) THEN
    RAISE EXCEPTION 'unresolved answer reconciliation payload is absent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'answer_effects_unresolved_payload_is_retained';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER answer_effects_unresolved_payload_is_immutable
BEFORE UPDATE OF state, payload_bytes, payload_hash
ON meeting_core.answer_effects
FOR EACH ROW
EXECUTE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1();

ALTER TABLE meeting_core.answer_effects
  DROP CONSTRAINT answer_effects_state_is_supported,
  DROP CONSTRAINT answer_effects_request_receipt_is_consistent,
  DROP CONSTRAINT answer_effects_delivery_receipt_is_consistent,
  DROP CONSTRAINT answer_effects_terminal_payload_is_scrubbed,
  DROP CONSTRAINT answer_effects_actionable_delivery_is_known,
  DROP CONSTRAINT answer_effects_containment_state_is_consistent;

-- A pre-0035 worker may have destroyed the only bytes needed to inspect or
-- retract an answer, or the old row may lack exact guild/container authority.
-- Preserve that fact without reconstructing content or treating a receipt as
-- a substitute for the immutable create bytes.
INSERT INTO meeting_core.answer_effect_reconciliation_quarantine (
  effect_id, prior_state, payload_hash, reason
)
SELECT effect_id, state, payload_hash,
       CASE WHEN octet_length(payload_bytes) <= 2 OR payload_bytes = '{}'
         THEN 'legacy_payload_scrubbed_before_0035'
         ELSE 'legacy_reconciliation_authority_absent_before_0035'
       END
FROM meeting_core.answer_effects
WHERE state IN (
    'request_started', 'delivered', 'outcome_unknown',
    'absent_unconfirmed', 'retraction_pending'
  )
  AND (
    octet_length(payload_bytes) <= 2 OR payload_bytes = '{}' OR
    authority_scope_id IS NULL OR delivery_container_id IS NULL OR
    projection_target_container_id = ''
  );

UPDATE meeting_core.answer_effects AS effect
SET state = 'quarantined_unrecoverable',
    settled_at = NULL,
    claim_until = NULL,
    updated_at = transaction_timestamp()
FROM meeting_core.answer_effect_reconciliation_quarantine AS quarantine
WHERE effect.effect_id = quarantine.effect_id;

-- A pre-request effect without exact authority cannot have crossed Discord's
-- boundary and is safely cancelled rather than assigned invented scope.
UPDATE meeting_core.answer_effects
SET state = 'cancelled', payload_bytes = '{}', claim_until = NULL,
    settled_at = COALESCE(settled_at, transaction_timestamp()),
    updated_at = transaction_timestamp()
WHERE state IN ('reserved', 'claimed')
  AND (authority_scope_id IS NULL OR delivery_container_id IS NULL);

-- NOT VALID makes each constraint enforce new writes immediately without an
-- ACCESS EXCLUSIVE validation scan. Migration 0036 validates them after this
-- fencing transaction commits.
ALTER TABLE meeting_core.answer_effects
  ADD CONSTRAINT answer_effects_state_is_supported
    CHECK ((state IN (
      'reserved', 'claimed', 'request_started', 'delivered', 'outcome_unknown',
      'cancelled', 'rejected_before_request', 'absent_unconfirmed',
      'retraction_pending', 'retracted', 'quarantined_unrecoverable'
    )) IS TRUE) NOT VALID,
  ADD CONSTRAINT answer_effects_request_receipt_is_consistent
    CHECK (((state NOT IN (
      'request_started', 'delivered', 'outcome_unknown', 'absent_unconfirmed',
      'retraction_pending', 'retracted', 'quarantined_unrecoverable'
    )) OR request_started_at IS NOT NULL) IS TRUE) NOT VALID,
  ADD CONSTRAINT answer_effects_delivery_receipt_is_consistent
    CHECK (((state IN ('delivered', 'retracted')) = (external_receipt IS NOT NULL)
      OR state IN ('retraction_pending', 'quarantined_unrecoverable')) IS TRUE) NOT VALID,
  ADD CONSTRAINT answer_effects_terminal_payload_is_scrubbed
    CHECK (((state NOT IN ('cancelled', 'retracted')) OR payload_bytes = '{}') IS TRUE)
    NOT VALID,
  ADD CONSTRAINT answer_effects_actionable_delivery_is_known
    CHECK ((delivery_container_id IS NOT NULL OR state IN (
      'cancelled', 'rejected_before_request', 'retracted',
      'quarantined_unrecoverable'
    )) IS TRUE) NOT VALID,
  ADD CONSTRAINT answer_effects_reconciliation_authority_is_known
    CHECK ((authority_scope_id IS NOT NULL OR state IN (
      'cancelled', 'rejected_before_request', 'retracted',
      'quarantined_unrecoverable'
    )) IS TRUE) NOT VALID,
  ADD CONSTRAINT answer_effects_unresolved_payload_is_retained
    CHECK ((state NOT IN (
      'request_started', 'delivered', 'outcome_unknown',
      'absent_unconfirmed', 'retraction_pending'
    ) OR (octet_length(payload_bytes) > 2 AND payload_bytes <> '{}')) IS TRUE) NOT VALID,
  ADD CONSTRAINT answer_effects_containment_state_is_consistent
    CHECK (((cardinality(containment_receipts) = 0) OR (
      state IN ('retraction_pending', 'quarantined_unrecoverable') AND
      external_receipt IS NOT NULL AND
      cardinality(containment_receipts) >= 2 AND
      containment_receipts[1] = external_receipt AND
      array_position(containment_receipts, NULL) IS NULL
    )) IS TRUE) NOT VALID;

COMMENT ON COLUMN meeting_core.answer_effects.payload_bytes IS
  'Immutable create bytes retained through delivery and while an external outcome or retraction remains unresolved; scrubbed only after cancellation or completed retraction.';
COMMENT ON COLUMN meeting_core.answer_effects.authority_scope_id IS
  'Authoritative provider-neutral scope; the Discord adapter exact-binds it as the expected guild during inspection.';
COMMENT ON TABLE meeting_core.answer_effect_reconciliation_quarantine IS
  'Operator-visible evidence of pre-0035 answer effects that lack immutable reconciliation bytes or exact authority and must never be reconstructed.';
COMMENT ON TRIGGER answer_effects_unresolved_payload_is_immutable
  ON meeting_core.answer_effects IS
  'Schema fence v1: rejects mutation or absence of retained answer create bytes/hash in every inspectable or retractable state.';
