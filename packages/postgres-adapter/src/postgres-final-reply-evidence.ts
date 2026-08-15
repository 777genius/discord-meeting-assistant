import { createHash } from "node:crypto";

import {
  MeetingKnowledgeIdentity,
  type CanonicalEvidenceTurn,
  type CurrentFinalReplyBinding,
  type FinalReplyEvidencePort,
  type FocusedMemoryReference,
  type QuestionBindingSnapshot,
  focusedMemoryGeneration,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import type { Pool, PoolClient } from "pg";

interface StoredMeetingRow {
  readonly meeting_id?: string;
  readonly snapshot: unknown;
}

interface ReferencedMeetingRow extends StoredMeetingRow {
  readonly historical_current: boolean;
  readonly meeting_id: string;
}

export interface ResolvedFinalReplyAuthority {
  readonly binding: CurrentFinalReplyBinding;
  readonly turns: readonly CanonicalEvidenceTurn[];
}

function canonicalTurns(snapshot: MeetingSnapshot): readonly CanonicalEvidenceTurn[] {
  const transcript = snapshot.transcript;
  if (transcript === null) {
    return [];
  }
  return Object.freeze(transcript.turns.map((turn) => Object.freeze({
    endMs: turn.endMs,
    speakerId: turn.speakerId,
    startMs: turn.startMs,
    text: turn.text,
    turnId: turn.turnId,
  })).toSorted((left, right) =>
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    (left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0)
  ));
}

function canonicalEvidenceHash(snapshot: MeetingSnapshot): string {
  if (snapshot.transcript === null) {
    throw new Error("final reply authority requires an accepted transcript");
  }
  return createHash("sha256").update(JSON.stringify({
    transcriptId: snapshot.transcript.transcriptId,
    turns: canonicalTurns(snapshot),
    version: snapshot.transcript.version,
  }), "utf8").digest("hex");
}

export function canonicalFinalReplyTurnHash(turn: CanonicalEvidenceTurn): string {
  return createHash("sha256").update(JSON.stringify({
    endMs: turn.endMs,
    speakerId: turn.speakerId,
    startMs: turn.startMs,
    text: turn.text,
    turnId: turn.turnId,
  }), "utf8").digest("hex");
}

export function resolveFinalReplyAuthority(
  value: unknown,
  botApplicationIdentity: string,
): ResolvedFinalReplyAuthority | null {
  const snapshot = Meeting.restore(value as MeetingSnapshot).toSnapshot();
  if (
    snapshot.source === null ||
    snapshot.actors === null ||
    snapshot.transcript === null ||
    snapshot.publication === null ||
    snapshot.transcriptionStage.status !== "succeeded" ||
    snapshot.publicationStage.status !== "succeeded"
  ) {
    return null;
  }
  const identity = MeetingKnowledgeIdentity.admit({
    actors: snapshot.actors,
    identityProvenance: snapshot.identityProvenance,
    lifecycleGeneration: snapshot.lifecycleGeneration,
    source: snapshot.source,
  });
  if (identity === null || identity.humanActorIds.length === 0) {
    return null;
  }
  const turns = canonicalTurns(snapshot);
  if (!turns.some(({ speakerId }) => identity.supportsHumanActor(speakerId))) {
    return null;
  }
  const evidenceHash = canonicalEvidenceHash(snapshot);
  return Object.freeze({
    binding: Object.freeze({
      botApplicationIdentity,
      canonicalEvidenceHash: evidenceHash,
      finalProjectionEpoch: snapshot.publication.idempotencyKey,
      finalProjectionReceipt: snapshot.publication.externalPublicationId,
      humanActorIds: identity.humanActorIds,
      meetingId: snapshot.meetingId,
      meetingRevision: snapshot.revision,
      memoryGeneration: focusedMemoryGeneration(evidenceHash),
      projectionTargetContainerId: snapshot.publicationTargetId,
      roomId: identity.source.roomId,
      scopeId: identity.source.scopeId,
      transcriptId: snapshot.transcript.transcriptId,
      transcriptVersion: snapshot.transcript.version,
    }),
    turns,
  });
}

export function finalReplyAuthorityMatches(
  authority: CurrentFinalReplyBinding,
  binding: QuestionBindingSnapshot,
): boolean {
  return authority.humanActorIds.length === binding.humanActorIds.length &&
    authority.humanActorIds.every((actorId) => binding.humanActorIds.includes(actorId)) &&
    authority.botApplicationIdentity === binding.botApplicationIdentity &&
    authority.canonicalEvidenceHash === binding.canonicalEvidenceHash &&
    authority.finalProjectionEpoch === binding.finalProjectionEpoch &&
    authority.finalProjectionReceipt === binding.finalProjectionReceipt &&
    authority.meetingId === binding.meetingId &&
    authority.meetingRevision === binding.meetingRevision &&
    authority.memoryGeneration === binding.memoryGeneration &&
    authority.projectionTargetContainerId === binding.projectionTargetContainerId &&
    authority.roomId === binding.roomId &&
    authority.scopeId === binding.scopeId &&
    authority.transcriptId === binding.transcriptId &&
    authority.transcriptVersion === binding.transcriptVersion;
}

export async function loadLockedFinalReplyAuthority(
  client: PoolClient,
  meetingId: string,
  botApplicationIdentity: string,
): Promise<ResolvedFinalReplyAuthority | null> {
  const result = await client.query<StoredMeetingRow>(
    `
      SELECT snapshot
      FROM meeting_core.meetings
      WHERE meeting_id = $1
      FOR UPDATE
    `,
    [meetingId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : resolveFinalReplyAuthority(row.snapshot, botApplicationIdentity);
}

export class PostgresFinalReplyEvidence implements FinalReplyEvidencePort {
  public constructor(
    private readonly pool: Pool,
    private readonly botApplicationIdentity: string,
  ) {}

  public async findCurrentBinding(input: {
    readonly finalProjectionReceipt: string;
    readonly projectionTargetContainerId: string;
  }): Promise<CurrentFinalReplyBinding | null> {
    const result = await this.pool.query<StoredMeetingRow>(
      `
        SELECT meeting.snapshot
        FROM meeting_core.meetings AS meeting
        WHERE meeting.snapshot -> 'publication' ->> 'externalPublicationId' = $1
          AND meeting.snapshot ->> 'publicationTargetId' = $2
          AND NOT EXISTS (
            SELECT 1
            FROM meeting_knowledge.unavailable_final_projections AS unavailable
            WHERE unavailable.final_projection_receipt = $1
          )
        ORDER BY meeting.meeting_id
        LIMIT 2
      `,
      [input.finalProjectionReceipt, input.projectionTargetContainerId],
    );
    if (result.rows.length !== 1) {
      return null;
    }
    return resolveFinalReplyAuthority(
      result.rows[0]!.snapshot,
      this.botApplicationIdentity,
    )?.binding ?? null;
  }

  public async recheckCurrentBinding(binding: QuestionBindingSnapshot) {
    const authority = await this.loadAuthority(binding);
    if (authority === null) {
      return { status: "unavailable" } as const;
    }
    if (!finalReplyAuthorityMatches(authority.binding, binding)) {
      return { status: "stale" } as const;
    }
    return { binding: authority.binding, status: "current" } as const;
  }

  public async rehydrateSelectedEvidence(
    binding: QuestionBindingSnapshot,
    references: readonly FocusedMemoryReference[],
  ) {
    if (
      references.length === 0 ||
      references.length > 256 ||
      new Set(references.map((reference) => [
        reference.meetingId,
        reference.transcriptId,
        reference.transcriptVersion,
        reference.turnId,
      ].join("\u0000"))).size !== references.length
    ) {
      return { status: "invalid_selection" } as const;
    }
    const anchor = await this.loadAuthority(binding);
    if (anchor === null) {
      return { status: "unavailable" } as const;
    }
    if (!finalReplyAuthorityMatches(anchor.binding, binding)) {
      return { status: "stale" } as const;
    }
    const meetingIds = [...new Set(references.map(({ meetingId }) => meetingId))];
    const result = await this.pool.query<ReferencedMeetingRow>(
      `
        SELECT meeting.meeting_id,
               meeting.snapshot,
               EXISTS (
                 SELECT 1
                 FROM meeting_core.historical_memory_sync AS historical
                 WHERE historical.meeting_id = meeting.meeting_id
                   AND historical.is_current
                   AND historical.operation = 'index'
                   AND historical.state = 'applied'
                   AND historical.transcript_id =
                     meeting.snapshot -> 'transcript' ->> 'transcriptId'
                   AND historical.transcript_version =
                     (meeting.snapshot -> 'transcript' ->> 'version')::bigint
               ) AS historical_current
        FROM meeting_core.meetings AS meeting
        WHERE meeting.meeting_id = ANY($1::text[])
      `,
      [meetingIds],
    );
    const authorities = new Map<string, ResolvedFinalReplyAuthority>();
    for (const row of result.rows) {
      const authority = row.meeting_id === binding.meetingId
        ? anchor
        : resolveFinalReplyAuthority(row.snapshot, this.botApplicationIdentity);
      if (
        authority === null ||
        authority.binding.scopeId !== binding.scopeId ||
        authority.binding.roomId !== binding.roomId ||
        (row.meeting_id !== binding.meetingId && !row.historical_current)
      ) {
        return { status: "invalid_selection" } as const;
      }
      authorities.set(row.meeting_id, authority);
    }
    if (authorities.size !== meetingIds.length) {
      return { status: "invalid_selection" } as const;
    }
    const turns = references.flatMap((reference) => {
      const authority = authorities.get(reference.meetingId);
      if (
        authority === undefined ||
        authority.binding.transcriptId !== reference.transcriptId ||
        authority.binding.transcriptVersion !== reference.transcriptVersion
      ) {
        return [];
      }
      const turn = authority.turns.find(({ turnId }) => turnId === reference.turnId);
      const turnHash = turn === undefined ? null : canonicalFinalReplyTurnHash(turn);
      if (
        turn === undefined ||
        turnHash === null ||
        !authority.binding.humanActorIds.includes(turn.speakerId) ||
        reference.turnHash !== turnHash
      ) {
        return [];
      }
      return [Object.freeze({
        ...turn,
        source: Object.freeze({
          meetingId: reference.meetingId,
          transcriptId: reference.transcriptId,
          transcriptVersion: reference.transcriptVersion,
        }),
        turnHash,
      })];
    });
    if (turns.length !== references.length) {
      return { status: "invalid_selection" } as const;
    }
    return {
      binding: anchor.binding,
      status: "current",
      turns: Object.freeze(turns),
    } as const;
  }

  private async loadAuthority(
    binding: QuestionBindingSnapshot,
  ): Promise<ResolvedFinalReplyAuthority | null> {
    const result = await this.pool.query<StoredMeetingRow & { readonly unavailable: boolean }>(
      `
        SELECT meeting.snapshot,
               EXISTS (
                 SELECT 1
                 FROM meeting_knowledge.unavailable_final_projections AS unavailable
                 WHERE unavailable.final_projection_receipt = $2
               ) AS unavailable
        FROM meeting_core.meetings AS meeting
        WHERE meeting.meeting_id = $1
      `,
      [binding.meetingId, binding.finalProjectionReceipt],
    );
    const row = result.rows[0];
    if (row === undefined || row.unavailable) {
      return null;
    }
    return resolveFinalReplyAuthority(
      row.snapshot,
      this.botApplicationIdentity,
    );
  }
}
