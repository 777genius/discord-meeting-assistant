CREATE INDEX CONCURRENTLY IF NOT EXISTS answer_effects_unresolved_reconciliation_idx
  ON meeting_core.answer_effects (
    updated_at,
    request_started_at,
    effect_id
  )
  WHERE state IN ('outcome_unknown', 'absent_unconfirmed');
