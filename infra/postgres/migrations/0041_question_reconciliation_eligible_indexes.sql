CREATE INDEX CONCURRENTLY IF NOT EXISTS question_jobs_reconciliation_active_idx
  ON meeting_knowledge.question_jobs (question_id)
  WHERE state <> 'terminal' OR reconciliation_disposition = 'reconcile';
