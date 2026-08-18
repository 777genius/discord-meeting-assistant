CREATE TABLE meeting_knowledge.withdrawn_meeting_sources (
  meeting_id text PRIMARY KEY,
  withdrawn_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

COMMENT ON TABLE meeting_knowledge.withdrawn_meeting_sources IS
  'Authoritative fail-closed tombstones for withdrawn knowledge sources.';

COMMENT ON TABLE meeting_knowledge.unavailable_final_projections IS
  'Authoritative fail-closed tombstones for withdrawn final projections.';
