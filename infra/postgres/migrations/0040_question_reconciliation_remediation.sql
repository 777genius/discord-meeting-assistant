-- Canonical JSON bytes match the adapter's recursively key-sorted JSON.stringify
-- contract. PostgreSQL's native jsonb text order is not that contract.
CREATE OR REPLACE FUNCTION meeting_knowledge.canonical_jsonb_text(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, meeting_knowledge
AS $$
DECLARE
  rendered text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(
        to_jsonb(item.key)::text || ':' ||
          meeting_knowledge.canonical_jsonb_text(item.value),
        ',' ORDER BY item.key COLLATE "C"
      ), '') || '}'
      INTO rendered
      FROM jsonb_each(value) AS item;
      RETURN rendered;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(
        meeting_knowledge.canonical_jsonb_text(item.value),
        ',' ORDER BY item.ordinality
      ), '') || ']'
      INTO rendered
      FROM jsonb_array_elements(value) WITH ORDINALITY AS item(value, ordinality);
      RETURN rendered;
    ELSE
      RETURN value::text;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION meeting_knowledge.prevent_question_binding_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, meeting_knowledge
AS $$
DECLARE
  expected_binding jsonb;
  old_dedupe jsonb;
  old_retrieval jsonb;
  pre_canonical_text text;
BEGIN
  IF OLD.binding IS NOT DISTINCT FROM NEW.binding AND
      OLD.binding_hash = NEW.binding_hash THEN
    RETURN NEW;
  END IF;
  IF NEW.state = 'terminal' AND NEW.binding IS NULL AND
      OLD.binding_hash = NEW.binding_hash THEN
    RETURN NEW;
  END IF;

  old_retrieval := OLD.binding -> 'retrievalBinding';
  old_dedupe := OLD.binding - 'authorizationPrincipalRef';
  pre_canonical_text := left(meeting_knowledge.canonical_jsonb_text(
      old_dedupe - ARRAY['bindingProtocolVersion', 'retrievalBinding']::text[]
    ), -1) ||
    ',"bindingProtocolVersion":2,"retrievalBinding":' ||
    meeting_knowledge.canonical_jsonb_text(old_retrieval) || '}';
  IF OLD.state IN ('running', 'ready') AND NEW.state = OLD.state AND
      OLD.question_text IS NOT NULL AND NEW.question_text = OLD.question_text AND
      OLD.binding ->> 'bindingProtocolVersion' = '2' AND
      old_retrieval ->> 'retrievalPath' = 'canonical_local_exact_lexical_v1' AND
      old_retrieval ? 'canonicalEvidenceFilters' AND
      jsonb_typeof(old_retrieval -> 'canonicalEvidenceFilters') = 'object' AND
      old_retrieval ->> 'cutoverEpoch' ~ '^[a-z0-9][a-z0-9._:-]{0,127}$' AND
      old_retrieval ->> 'profileFingerprint' ~ '^[a-f0-9]{64}$' AND
      (SELECT array_agg(key ORDER BY key COLLATE "C")
       FROM jsonb_object_keys(OLD.binding) AS keys(key)) = ARRAY[
         'authorizationDigest', 'authorizationPolicyVersion',
         'authorizationPrincipalRef', 'bindingProtocolVersion',
         'botApplicationIdentity', 'canonicalEvidenceHash',
         'deliveryContainerId', 'expectedLocale', 'finalProjectionEpoch',
         'finalProjectionReceipt', 'humanActorIds', 'meetingId',
         'meetingRevision', 'memoryGeneration', 'policyVersion',
         'projectionTargetContainerId', 'questionHash', 'questionId',
         'requesterSubject', 'retrievalBinding', 'roomId', 'scopeId',
         'transcriptId', 'transcriptVersion'
       ]::text[] AND
      (SELECT array_agg(key ORDER BY key COLLATE "C")
       FROM jsonb_object_keys(old_retrieval) AS keys(key)) = ARRAY[
         'canonicalEvidenceFilters', 'cutoverEpoch',
         'profileFingerprint', 'retrievalPath'
       ]::text[] AND
      OLD.binding_hash IN (
        encode(sha256(convert_to(
          meeting_knowledge.canonical_jsonb_text(old_dedupe), 'UTF8')), 'hex'),
        encode(sha256(convert_to(pre_canonical_text, 'UTF8')), 'hex')
      ) THEN
    expected_binding := jsonb_set(OLD.binding, '{retrievalBinding}',
      jsonb_build_object(
        'canonicalEvidenceFilters', old_retrieval -> 'canonicalEvidenceFilters',
        'cutoverEpoch', old_retrieval -> 'cutoverEpoch',
        'localCurrentIdentity', jsonb_build_object(
          'algorithmId', 'canonical_local_exact_lexical_v1',
          'profileFingerprint', old_retrieval -> 'profileFingerprint',
          'profileId', 'meeting-knowledge.local-current.v2'
        ),
        'originalQuestion', NEW.question_text,
        'profileFingerprint', old_retrieval -> 'profileFingerprint',
        'provenanceSchemaVersion', 1,
        'retrievalPath', 'canonical_local_exact_lexical_v1'
      ));
    IF NEW.binding = expected_binding AND
        NEW.binding_hash = encode(sha256(convert_to(
          meeting_knowledge.canonical_jsonb_text(
            NEW.binding - 'authorizationPrincipalRef'
          ), 'UTF8')), 'hex') THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'question retrieval binding is immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'question_jobs_binding_is_immutable';
END;
$$;

ALTER TABLE meeting_knowledge.question_jobs
  ADD COLUMN delivery_container_id text,
  ADD COLUMN reconciliation_disposition text,
  ADD COLUMN reconciliation_reason text,
  ADD CONSTRAINT question_jobs_reconciliation_quarantine_is_consistent
    CHECK (((reconciliation_disposition IS NULL AND
             reconciliation_reason IS NULL) OR
            (reconciliation_disposition IN ('quarantined', 'reconcile') AND
             reconciliation_reason ~ '^[a-z0-9_]{1,128}$' AND
             state = 'terminal' AND outcome = 'stale_binding')) IS TRUE) NOT VALID;

-- Preserve non-sensitive routing authority before any incompatible binding is
-- terminalized and scrubbed. New admissions write this column directly.
UPDATE meeting_knowledge.question_jobs
SET delivery_container_id = binding ->> 'deliveryContainerId'
WHERE binding IS NOT NULL AND binding ? 'deliveryContainerId';

-- Recover disposition written by either pre-column terminalization path. Only
-- the closed set of reasons whose canonical local authority is derivable may
-- remain actionable.
UPDATE meeting_knowledge.question_jobs
SET reconciliation_reason = substring(
      retry_reason FROM '^[^:]+:([a-z0-9_]{1,128})$'
    ),
    reconciliation_disposition = CASE
      WHEN substring(retry_reason FROM '^[^:]+:([a-z0-9_]{1,128})$')
             LIKE 'protocol2\_%' ESCAPE '\' OR
           substring(retry_reason FROM '^[^:]+:([a-z0-9_]{1,128})$') =
             'legacy_provenance_authority_conflict'
        THEN 'reconcile'
      ELSE 'quarantined'
    END
WHERE state = 'terminal' AND outcome = 'stale_binding'
  AND retry_reason ~ '^(reconciliation|lease-recovery):[a-z0-9_]{1,128}$';

COMMENT ON COLUMN meeting_knowledge.question_jobs.reconciliation_disposition IS
  'Durable replay decision for a terminalized incompatible reconciliation row.';
COMMENT ON COLUMN meeting_knowledge.question_jobs.reconciliation_reason IS
  'Closed adapter recovery reason retained after sensitive question evidence is scrubbed.';
COMMENT ON COLUMN meeting_knowledge.question_jobs.retry_reason IS
  'Terminal diagnostic; new incompatible-row recovery writes canonical reconciliation:<reason> regardless of whether lease or reconciliation scanning discovers the row. Historical lease-recovery:<reason> values remain readable.';
