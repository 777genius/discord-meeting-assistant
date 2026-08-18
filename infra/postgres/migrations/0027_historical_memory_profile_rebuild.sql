ALTER TABLE meeting_core.historical_memory_sync
  ADD COLUMN applied_index_profile_id text,
  ADD COLUMN profile_rebuild_requested boolean NOT NULL DEFAULT false;

-- Every earlier applied projection predates the source-pinned dense profile.
-- Preserve its plan and remote IDs so reconciliation can prove deletion before
-- replacing it; only remove it from serving and enqueue the deterministic work.
UPDATE meeting_core.historical_memory_sync
SET state = 'pending',
    profile_rebuild_requested = true,
    retry_after = NULL,
    lease_expires_at = NULL,
    last_error_code = NULL,
    updated_at = transaction_timestamp()
WHERE is_current AND operation = 'index' AND state = 'applied';

ALTER TABLE meeting_core.historical_memory_sync
  ADD CONSTRAINT historical_memory_sync_applied_profile_is_present
    CHECK ((state <> 'applied' OR applied_index_profile_id IS NOT NULL) IS TRUE),
  ADD CONSTRAINT historical_memory_sync_applied_profile_is_bounded
    CHECK ((applied_index_profile_id IS NULL OR
      length(applied_index_profile_id) BETWEEN 1 AND 1000) IS TRUE);

COMMENT ON COLUMN meeting_core.historical_memory_sync.applied_index_profile_id IS
  'Exact source/model/tokenizer profile that produced the currently servable derived index.';
