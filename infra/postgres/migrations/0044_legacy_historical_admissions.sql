-- An admission retains exact canonical signed receipt bytes, never a transcript copy.
CREATE TABLE meeting_core.legacy_historical_admissions (
  release_id text PRIMARY KEY,
  meeting_id text NOT NULL,
  receipt_json text NOT NULL,
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  transcript_sha256 text NOT NULL CHECK (transcript_sha256 ~ '^[a-f0-9]{64}$'),
  saved_source_sha256 text NOT NULL CHECK (saved_source_sha256 ~ '^[a-f0-9]{64}$'),
  identity_evidence_sha256 text NOT NULL CHECK (identity_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  scope_room_evidence_sha256 text NOT NULL CHECK (scope_room_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  duration_evidence_sha256 text NOT NULL CHECK (duration_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT legacy_historical_receipt_binding CHECK ((
    receipt_json::jsonb #>> '{payload,admission}' = 'signed_legacy_v1'
    AND receipt_json::jsonb #>> '{payload,binding,releaseId}' = release_id
    AND receipt_json::jsonb #>> '{payload,binding,meetingId}' = meeting_id
    AND receipt_json::jsonb #>> '{payload,snapshotSha256}' = snapshot_sha256
    AND receipt_json::jsonb #>> '{payload,transcriptSha256}' = transcript_sha256
    AND receipt_json::jsonb #>> '{payload,savedSourceSha256}' = saved_source_sha256
    AND receipt_json::jsonb #>> '{payload,identityEvidenceSha256}' = identity_evidence_sha256
    AND receipt_json::jsonb #>> '{payload,scopeRoomEvidenceSha256}' = scope_room_evidence_sha256
    AND receipt_json::jsonb #>> '{payload,durationEvidenceSha256}' = duration_evidence_sha256
  ) IS TRUE)
);
CREATE FUNCTION meeting_core.reject_legacy_historical_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'legacy historical admissions are immutable';
END;
$$;
CREATE TRIGGER legacy_historical_admissions_immutable
BEFORE UPDATE OR DELETE ON meeting_core.legacy_historical_admissions
FOR EACH ROW EXECUTE FUNCTION meeting_core.reject_legacy_historical_receipt_mutation();
