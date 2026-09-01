CREATE INDEX CONCURRENTLY IF NOT EXISTS answer_effects_question_reconciliation_idx
  ON meeting_core.answer_effects (effect_id)
  WHERE state IN (
    'request_started', 'outcome_unknown', 'absent_unconfirmed',
    'delivered', 'retraction_pending'
  );
