import { createHash } from "node:crypto";

import {
  focusedMemoryGeneration,
  isAttestedActiveLiveMemoryIdentity,
  type CanonicalEvidenceTurn,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  LiveMeeting,
  type LiveMeetingSnapshot,
} from "@discord-meeting/meeting-core/live-meeting";
import type { Pool, PoolClient } from "pg";

import type { ResolvedFinalReplyAuthority } from "./postgres-final-reply-evidence.js";

interface StoredLiveMeetingRow { readonly snapshot: unknown }

interface StoredLiveMemoryRow {
  readonly actor_semantics_version: number;
  readonly applied_generation: number;
  readonly human_actor_ids: unknown;
  readonly producer_capability_id: string;
  readonly room_id: string;
  readonly roster_state: "sealed" | "unsealed";
  readonly schema_version: number;
  readonly scope_id: string;
  readonly source_generation: number;
  readonly state: "active" | "ended" | "withdrawn";
}

interface StoredLiveTurnRow { readonly turn: CanonicalEvidenceTurn }

function canonicalLiveEvidenceHash(input: {
  readonly meetingId: string;
  readonly transcriptId: string;
  readonly transcriptVersion: number;
  readonly turns: readonly CanonicalEvidenceTurn[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    meetingId: input.meetingId,
    transcriptId: input.transcriptId,
    turns: input.turns,
    version: input.transcriptVersion,
  }), "utf8").digest("hex");
}

function storedHumanActors(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((actorId) => typeof actorId !== "string" || actorId.length === 0)
  ) {
    return null;
  }
  const actors = [...new Set(value as readonly string[])].toSorted();
  return actors.length === value.length ? Object.freeze(actors) : null;
}

/** Resolves authority without any Discord presentation or user-provided text. */
function resolveLiveReplyAuthority(
  snapshotValue: unknown,
  memory: StoredLiveMemoryRow,
  turnValues: readonly CanonicalEvidenceTurn[],
  botApplicationIdentity: string,
): ResolvedFinalReplyAuthority | null {
  const snapshot = LiveMeeting.restore(snapshotValue as LiveMeetingSnapshot).toSnapshot();
  const humanActorIds = storedHumanActors(memory.human_actor_ids);
  if (
    snapshot.status !== "active" ||
    snapshot.projectionExternalId === null ||
    snapshot.projectionPublisherIdentity === null ||
    snapshot.projectionPublisherIdentity === undefined ||
    snapshot.projectionPublisherIdentity !== botApplicationIdentity ||
    !isAttestedActiveLiveMemoryIdentity({
      actorSemanticsVersion: memory.actor_semantics_version,
      producerCapabilityId: memory.producer_capability_id,
      rosterState: memory.roster_state,
      schemaVersion: memory.schema_version,
      state: memory.state,
    }) ||
    memory.applied_generation !== memory.source_generation ||
    memory.source_generation < 1 ||
    humanActorIds === null
  ) {
    return null;
  }
  const admittedActors = new Set(humanActorIds);
  const turns = Object.freeze(turnValues
    .filter(({ speakerId }) => admittedActors.has(speakerId))
    .toSorted((left, right) =>
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.turnId.localeCompare(right.turnId)
    ));
  if (turns.length === 0) {
    return null;
  }
  const transcriptId = `live-finalized:v1:${snapshot.meetingId}`;
  const evidenceHash = canonicalLiveEvidenceHash({
    meetingId: snapshot.meetingId,
    transcriptId,
    transcriptVersion: memory.source_generation,
    turns,
  });
  return Object.freeze({
    binding: Object.freeze({
      botApplicationIdentity: snapshot.projectionPublisherIdentity,
      canonicalEvidenceHash: evidenceHash,
      finalProjectionEpoch:
        `live-projection:v1:${snapshot.projectedRevision}:${snapshot.projectionExternalId}`,
      finalProjectionReceipt: snapshot.projectionExternalId,
      humanActorIds,
      meetingId: snapshot.meetingId,
      meetingRevision: snapshot.revision,
      memoryGeneration: focusedMemoryGeneration(evidenceHash),
      projectionTargetContainerId: snapshot.publicationTargetId,
      roomId: memory.room_id,
      scopeId: memory.scope_id,
      transcriptId,
      transcriptVersion: memory.source_generation,
    }),
    turns,
  });
}

export async function loadLiveReplyAuthority(
  executor: Pick<Pool, "query"> | PoolClient,
  meetingId: string,
  botApplicationIdentity: string,
  lock = false,
): Promise<ResolvedFinalReplyAuthority | null> {
  const live = await executor.query<StoredLiveMeetingRow>(
    `
      SELECT snapshot
      FROM meeting_core.live_meetings
      WHERE meeting_id = $1
      ${lock ? "FOR UPDATE" : ""}
    `,
    [meetingId],
  );
  const snapshot = live.rows[0]?.snapshot;
  if (snapshot === undefined) {
    return null;
  }
  const memory = await executor.query<StoredLiveMemoryRow>(
    `
      SELECT schema_version, scope_id, room_id, human_actor_ids, roster_state,
             producer_capability_id, actor_semantics_version::float8 AS actor_semantics_version,
             source_generation::float8 AS source_generation,
             applied_generation::float8 AS applied_generation,
             state
      FROM meeting_knowledge.live_memory_meetings
      WHERE meeting_id = $1
      ${lock ? "FOR UPDATE" : ""}
    `,
    [meetingId],
  );
  const memoryRow = memory.rows[0];
  if (memoryRow === undefined) {
    return null;
  }
  const turns = await executor.query<StoredLiveTurnRow>(
    `
      SELECT turn.turn
      FROM meeting_knowledge.live_memory_hot_tail AS hot
      JOIN meeting_core.live_meeting_turns AS turn
        ON turn.meeting_id = hot.meeting_id
       AND turn.turn_id = hot.turn_id
      WHERE hot.meeting_id = $1
      ORDER BY hot.source_generation
    `,
    [meetingId],
  );
  return resolveLiveReplyAuthority(
    snapshot,
    memoryRow,
    turns.rows.map(({ turn }) => turn),
    botApplicationIdentity,
  );
}
