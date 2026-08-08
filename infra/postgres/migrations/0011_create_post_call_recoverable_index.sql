CREATE INDEX CONCURRENTLY IF NOT EXISTS post_call_outbox_recoverable_recovery_idx
  ON meeting_core.post_call_outbox
    (COALESCE(recovery_after, created_at), meeting_id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
