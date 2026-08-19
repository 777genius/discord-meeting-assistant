CREATE INDEX CONCURRENTLY IF NOT EXISTS post_call_outbox_binding_recoverable_idx
  ON meeting_core.post_call_outbox (
    COALESCE(binding_recovery_after, created_at),
    meeting_id
  )
  WHERE processed_at IS NULL
    AND dead_lettered_at IS NULL
    AND transcription_execution_binding_required = TRUE;
