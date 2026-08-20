import {
  validateHistoricalReleaseBinding,
  type HistoricalReleaseBindingV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { PoolClient } from "pg";

import { lockMeetingKnowledgeSource } from "./postgres-answer-source-withdrawal.js";
import {
  historicalBindingFromRow,
  historicalBindingsEqual,
  historicalSyncRowProjection,
  type HistoricalSyncRow,
} from "./postgres-historical-memory-row.js";

interface HistoricalMeetingMutationRow {
  readonly desired_generation: number;
  readonly operation: "delete_meeting" | "delete_release" | "index";
}

export async function acceptHistoricalReleaseInTransaction(
  client: PoolClient,
  candidate: HistoricalReleaseBindingV1,
): Promise<"accepted" | "replayed"> {
  const binding = validateHistoricalReleaseBinding(candidate);
  await lockMeetingKnowledgeSource(client, binding.meetingId);
  const withdrawn = await client.query(
    `SELECT 1 FROM meeting_knowledge.withdrawn_meeting_sources
     WHERE meeting_id = $1`,
    [binding.meetingId],
  );
  if (withdrawn.rowCount === 1) {
    throw new Error("withdrawn meeting cannot accept a new historical release");
  }
  const existing = await client.query<HistoricalSyncRow>(
    `SELECT ${historicalSyncRowProjection} FROM meeting_core.historical_memory_sync WHERE release_id = $1 FOR UPDATE`,
    [binding.releaseId],
  );
  if (existing.rows[0] !== undefined) {
    const stored = historicalBindingFromRow(existing.rows[0]);
    if (!historicalBindingsEqual(stored, binding)) {
      throw new Error("historical release replay conflicts with its accepted binding");
    }
    return "replayed";
  }
  const meetingMutations = await client.query<HistoricalMeetingMutationRow>(
    `SELECT desired_generation::float8 AS desired_generation, operation
     FROM meeting_core.historical_memory_sync
     WHERE meeting_id = $1
     FOR UPDATE`,
    [binding.meetingId],
  );
  if (meetingMutations.rows.some(({ operation }) => operation === "delete_meeting")) {
    throw new Error("withdrawn meeting cannot accept a new historical release");
  }
  const previousGeneration = meetingMutations.rows.reduce(
    (maximum, row) => Math.max(maximum, row.desired_generation),
    0,
  );
  if (binding.desiredGeneration !== previousGeneration + 1) {
    throw new Error("historical release generation is not the next monotonic generation");
  }
  await client.query(
    `UPDATE meeting_core.historical_memory_sync
     SET is_current = false,
         operation = 'delete_release',
         state = CASE
           WHEN state = 'deleted' THEN 'deleted'
           WHEN state = 'in_flight' THEN 'in_flight'
           ELSE 'deleting'
         END,
         retry_after = NULL,
         lease_expires_at = CASE
           WHEN state = 'in_flight' THEN lease_expires_at
           ELSE NULL
         END,
         superseded_by_release_id = $2,
         updated_at = transaction_timestamp()
     WHERE meeting_id = $1 AND is_current`,
    [binding.meetingId, binding.releaseId],
  );
  await client.query(
    `INSERT INTO meeting_core.historical_memory_sync (
       release_id, meeting_id, schema_version, accepted_meeting_revision,
       desired_generation, transcript_id, transcript_version,
       evidence_policy_version, scope_id, room_id
     ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)`,
    [
      binding.releaseId, binding.meetingId, binding.acceptedMeetingRevision,
      binding.desiredGeneration, binding.transcriptId, binding.transcriptVersion,
      binding.evidencePolicyVersion, binding.scopeId, binding.roomId,
    ],
  );
  return "accepted";
}
