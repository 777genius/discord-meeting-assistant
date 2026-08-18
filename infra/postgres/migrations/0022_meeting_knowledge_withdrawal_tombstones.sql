CREATE TABLE IF NOT EXISTS meeting_knowledge.withdrawn_meeting_sources (
  meeting_id text PRIMARY KEY,
  withdrawn_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

-- Releases withdrawn before this table existed remain authoritative deletion
-- evidence after an upgrade. Preserve the earliest retained deletion marker.
INSERT INTO meeting_knowledge.withdrawn_meeting_sources (
  meeting_id,
  withdrawn_at
)
SELECT meeting_id, min(updated_at)
FROM meeting_core.historical_memory_sync
WHERE operation = 'delete_meeting'
GROUP BY meeting_id
ON CONFLICT (meeting_id) DO NOTHING;

-- Retraction reconciliation needs only the immutable marker and payload hash.
-- Scrub answer prose retained by the pre-tombstone withdrawal implementation.
UPDATE meeting_core.answer_effects
SET payload_bytes = '{}',
    updated_at = transaction_timestamp()
WHERE state = 'retraction_pending'
  AND payload_bytes <> '{}';

CREATE INDEX IF NOT EXISTS unavailable_final_projections_unavailable_at_idx
  ON meeting_knowledge.unavailable_final_projections (
    unavailable_at,
    final_projection_receipt
  );

COMMENT ON TABLE meeting_knowledge.withdrawn_meeting_sources IS
  'Authoritative fail-closed tombstones for withdrawn knowledge sources.';

COMMENT ON TABLE meeting_knowledge.unavailable_final_projections IS
  'Fail-closed tombstones for withdrawn final projections; unmatched observations are pruned after a bounded race window.';
