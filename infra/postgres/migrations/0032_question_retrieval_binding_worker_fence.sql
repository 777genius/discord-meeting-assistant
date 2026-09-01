-- Activate the binding-aware deployment before changing the lease constraints.
-- The row lock used by admission and every worker mutation linearizes old
-- protocol-2 binaries behind this monotonic epoch-3 cutover. Once this commits,
-- an old binary can neither admit a legacy binding nor continue leased work.
INSERT INTO meeting_knowledge.current_question_policy (
  policy_key, policy_epoch, policy_version, authorization_policy_version
) VALUES (
  'local-final-reply', 3,
  'meeting-knowledge.focused-memory-final-reply.v3',
  'discord.participant-current-results.v2'
)
ON CONFLICT (policy_key) DO UPDATE
SET policy_epoch = EXCLUDED.policy_epoch,
    policy_version = EXCLUDED.policy_version,
    authorization_policy_version = EXCLUDED.authorization_policy_version,
    activated_at = transaction_timestamp()
WHERE meeting_knowledge.current_question_policy.policy_epoch < EXCLUDED.policy_epoch;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM meeting_knowledge.current_question_policy
    WHERE policy_key = 'local-final-reply'
      AND policy_epoch = 3
      AND (
        policy_version <> 'meeting-knowledge.focused-memory-final-reply.v3' OR
        authorization_policy_version <>
          'discord.participant-current-results.v2'
      )
  ) THEN
    RAISE EXCEPTION 'question policy epoch 3 has conflicting versions'
      USING ERRCODE = '23514',
            CONSTRAINT = 'current_question_policy_epoch_3_identity';
  END IF;
END;
$$;

-- Jobs admitted by the immediately preceding v3 policy release keep their
-- immutable binding and move under the new deployment fence. Older policy
-- identities remain stale and are handled by ordinary maintenance.
UPDATE meeting_knowledge.question_jobs
SET policy_epoch = 3,
    updated_at = transaction_timestamp()
WHERE state <> 'terminal'
  AND policy_epoch < 3
  AND binding ->> 'policyVersion' =
    'meeting-knowledge.focused-memory-final-reply.v3'
  AND binding ->> 'authorizationPolicyVersion' =
    'discord.participant-current-results.v2'
  AND EXISTS (
    SELECT 1
    FROM meeting_knowledge.current_question_policy
    WHERE policy_key = 'local-final-reply'
      AND policy_epoch = 3
      AND policy_version =
        'meeting-knowledge.focused-memory-final-reply.v3'
      AND authorization_policy_version =
        'discord.participant-current-results.v2'
  );

ALTER TABLE meeting_knowledge.question_jobs
  DROP CONSTRAINT question_jobs_running_worker_protocol_is_current,
  ADD CONSTRAINT question_jobs_running_worker_protocol_is_current
    CHECK (((state <> 'running') OR (
      worker_protocol_epoch IN (2, 3) AND
      worker_protocol_generation = generation
    )) IS TRUE),
  ADD CONSTRAINT question_jobs_retrieval_binding_worker_protocol_is_current
    CHECK (((state NOT IN ('running', 'ready')) OR
      binding IS NULL OR
      NOT (binding ? 'bindingProtocolVersion') OR
      worker_protocol_epoch = 3
    ) IS TRUE);

COMMENT ON CONSTRAINT question_jobs_retrieval_binding_worker_protocol_is_current
  ON meeting_knowledge.question_jobs IS
  'A protocol-2 retrieval binding can be leased in running or ready state only by a binding-aware worker; legacy bindings remain drainable.';

CREATE OR REPLACE FUNCTION meeting_knowledge.prevent_question_binding_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.binding IS NOT DISTINCT FROM NEW.binding AND
      OLD.binding_hash = NEW.binding_hash THEN
    RETURN NEW;
  END IF;
  IF NEW.state = 'terminal' AND NEW.binding IS NULL AND
      OLD.binding_hash = NEW.binding_hash THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'question retrieval binding is immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'question_jobs_binding_is_immutable';
END;
$$;

CREATE TRIGGER question_jobs_binding_is_immutable
BEFORE UPDATE OF binding, binding_hash ON meeting_knowledge.question_jobs
FOR EACH ROW
EXECUTE FUNCTION meeting_knowledge.prevent_question_binding_mutation();
