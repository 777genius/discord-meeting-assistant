import {
  admitAcceptedFinalMeeting,
  createHistoricalReleaseBinding,
  HISTORICAL_EVIDENCE_POLICY_VERSION,
  type HistoricalReleaseBindingV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";
import type { PoolClient } from "pg";
import { acceptHistoricalReleaseInTransaction } from "./postgres-historical-memory-store.js";
import {
  historicalBindingFromRow,
  historicalSyncRowProjection,
  type HistoricalSyncRow,
} from "./postgres-historical-memory-row.js";

interface GenerationRow {
  readonly desired_generation: number;
}

function acceptedInput(
  snapshot: MeetingSnapshot,
  binding: HistoricalReleaseBindingV1,
) {
  return {
    actors: snapshot.actors,
    authoritativeDurationMs:
      snapshot.recording.authoritativeDurationMs ?? null,
    binding,
    identityProvenance: snapshot.identityProvenance,
    lifecycleGeneration: snapshot.lifecycleGeneration,
    meetingRevision: snapshot.revision,
    roomId: snapshot.source?.roomId ?? null,
    scopeId: snapshot.source?.scopeId ?? null,
    transcriptId: snapshot.transcript?.transcriptId ?? null,
    transcriptVersion: snapshot.transcript?.version ?? null,
    turns: snapshot.transcript?.turns ?? null,
  };
}

/** Runs inside the authoritative MeetingRepository save transaction. */
export async function projectAcceptedHistoricalRelease(
  client: PoolClient,
  snapshot: MeetingSnapshot,
): Promise<void> {
  if (
    snapshot.transcriptionStage.status !== "succeeded" ||
    snapshot.transcript === null ||
    snapshot.source === null ||
    snapshot.actors === null
  ) {
    return;
  }
  const existing = await client.query<HistoricalSyncRow>(
    `
      SELECT ${historicalSyncRowProjection}
      FROM meeting_core.historical_memory_sync
      WHERE meeting_id = $1
        AND transcript_id = $2
        AND transcript_version = $3
        AND evidence_policy_version = $4
      FOR UPDATE
    `,
    [
      snapshot.meetingId,
      snapshot.transcript.transcriptId,
      snapshot.transcript.version,
      HISTORICAL_EVIDENCE_POLICY_VERSION,
    ],
  );
  const existingRow = existing.rows[0];
  if (existingRow !== undefined) {
    // Repository saves can replay after the first projection. Re-admit the
    // immutable stored binding against the current authoritative snapshot so
    // corrupt or conflicting accepted identities fail closed instead of being
    // hidden by an early tuple-exists return.
    const binding = historicalBindingFromRow(existingRow);
    admitAcceptedFinalMeeting(acceptedInput(snapshot, binding));
    return;
  }

  const generations = await client.query<GenerationRow>(
    `
      SELECT desired_generation::float8 AS desired_generation
      FROM meeting_core.historical_memory_sync
      WHERE meeting_id = $1
      ORDER BY desired_generation DESC
      FOR UPDATE
    `,
    [snapshot.meetingId],
  );
  const desiredGeneration = (generations.rows[0]?.desired_generation ?? 0) + 1;
  const binding = createHistoricalReleaseBinding({
    acceptedMeetingRevision: snapshot.revision,
    desiredGeneration,
    meetingId: snapshot.meetingId,
    roomId: snapshot.source.roomId,
    scopeId: snapshot.source.scopeId,
    transcriptId: snapshot.transcript.transcriptId,
    transcriptVersion: snapshot.transcript.version,
  });
  if (admitAcceptedFinalMeeting(acceptedInput(snapshot, binding)) === null) {
    return;
  }

  await acceptHistoricalReleaseInTransaction(client, binding);
}
