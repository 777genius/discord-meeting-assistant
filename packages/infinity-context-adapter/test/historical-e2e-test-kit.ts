import {
  admitAcceptedFinalMeeting,
  createHistoricalReleaseBinding,
  type AcceptedFinalMeetingV1,
  type CoverageCheckpointLeaseV1,
  type CoverageExtractV1,
  type CoverageReductionV1,
  type ExhaustiveCoverageStore,
  type HistoricalAppliedPlanV1,
  type HistoricalCandidateRecordV1,
  type HistoricalEvidenceAuthority,
  type HistoricalIndexPlanV1,
  type HistoricalReleaseBindingV1,
  type HistoricalSyncClaimOptionsV1,
  type HistoricalSyncLeaseV1,
  type HistoricalSyncOperationV1,
  type HistoricalSyncStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { createHmac } from "node:crypto";

import type { HistoricalRetrievalActorKeyMapper } from
  "../src/historical-retrieval-projection.js";

export const testHistoricalActorKeys: HistoricalRetrievalActorKeyMapper =
  Object.freeze({
    activeActorKey: (actorId: string) => `test-actor.v1.${createHmac(
      "sha256",
      "infinity-context-disposable-test-actor-key",
    ).update(actorId, "utf8").digest("base64url")}`,
  });

type RowState = "applied" | "dead_letter" | "deleted" | "deleting" | "in_flight" | "pending" | "retry_wait";

export function finalMeeting(
  transcriptVersion: number,
  launchDay: string,
): AcceptedFinalMeetingV1 {
  const binding = createHistoricalReleaseBinding({
    acceptedMeetingRevision: transcriptVersion + 10,
    desiredGeneration: transcriptVersion,
    meetingId: "fixture-meeting",
    roomId: "fixture-room",
    scopeId: "fixture-scope",
    transcriptId: `fixture-transcript-${transcriptVersion}`,
    transcriptVersion,
  });
  const admitted = admitAcceptedFinalMeeting({
    actors: [
      { actorId: "human-maya", kind: "human" },
      { actorId: "fixture-automation", kind: "automation" },
    ],
    authoritativeDurationMs: 150_000,
    binding,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "fixture-r1",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingRevision: binding.acceptedMeetingRevision,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion,
    turns: [
      ...Array.from({ length: 14 }, (_, index) => ({
        endMs: (index + 1) * 10_000,
        speakerId: "human-maya",
        startMs: index * 10_000,
        text: index === 8
          ? `Project Cedar launch is ${launchDay}; Maya owns the release.`
          : `Accepted planning detail ${transcriptVersion}-${index} for the product review.`,
        turnId: `human-turn-${transcriptVersion}-${index}`,
      })),
      {
        endMs: 150_000,
        speakerId: "fixture-automation",
        startMs: 140_000,
        text: "BOTIK GENERATED SUMMARY MUST NOT BE INDEXED",
        turnId: `bot-turn-${transcriptVersion}`,
      },
    ],
  });
  if (admitted === null) {
    throw new Error("fixture admission failed");
  }
  return admitted;
}

interface StateRow {
  appliedIndexProfileId: string | null;
  attempt: number;
  readonly binding: HistoricalReleaseBindingV1;
  current: boolean;
  fence: number;
  operation: HistoricalSyncOperationV1;
  plan: HistoricalIndexPlanV1 | null;
  profileRebuildRequired: boolean;
  remoteDocumentIds: Readonly<Record<string, string>>;
  state: RowState;
}

export class MemoryHistoricalAuthority implements HistoricalEvidenceAuthority {
  readonly #meetings = new Map<string, AcceptedFinalMeetingV1>();

  public put(meeting: AcceptedFinalMeetingV1): void {
    this.#meetings.set(meeting.binding.releaseId, meeting);
  }

  public async loadAcceptedFinalMeeting(
    binding: HistoricalReleaseBindingV1,
  ): Promise<AcceptedFinalMeetingV1 | null> {
    return this.#meetings.get(binding.releaseId) ?? null;
  }
}

export class MemoryHistoricalStore implements HistoricalSyncStore {
  readonly #rows = new Map<string, StateRow>();

  public async enqueueAppliedProfileRebuilds(indexProfileId: string) {
    let enqueued = 0;
    for (const row of this.#rows.values()) {
      if (
        row.current && row.operation === "index" && row.state === "applied" &&
        row.appliedIndexProfileId !== indexProfileId
      ) {
        row.profileRebuildRequired = true;
        row.state = "pending";
        enqueued += 1;
      }
    }
    return { enqueued, remaining: false } as const;
  }

  public async acceptRelease(
    binding: HistoricalReleaseBindingV1,
  ): Promise<"accepted" | "replayed"> {
    if (this.#rows.has(binding.releaseId)) {
      return "replayed";
    }
    for (const row of this.#rows.values()) {
      if (row.current && row.binding.meetingId === binding.meetingId) {
        row.current = false;
        row.operation = "delete_release";
        row.state = row.state === "deleted"
          ? "deleted"
          : row.state === "in_flight"
            ? "in_flight"
            : "deleting";
      }
    }
    this.#rows.set(binding.releaseId, {
      appliedIndexProfileId: null,
      attempt: 0,
      binding,
      current: true,
      fence: 0,
      operation: "index",
      plan: null,
      profileRebuildRequired: false,
      remoteDocumentIds: {},
      state: "pending",
    });
    return "accepted";
  }

  public async claimNext(
    options: HistoricalSyncClaimOptionsV1,
  ): Promise<HistoricalSyncLeaseV1 | null> {
    const eligible = [...this.#rows.values()].filter((row) =>
      ["deleting", "pending", "retry_wait"].includes(row.state) &&
      (options.allowIndex || row.operation !== "index")
    ).toSorted((left, right) =>
      Number(left.operation === "index") - Number(right.operation === "index") ||
      compare(left.binding.releaseId, right.binding.releaseId)
    );
    const row = eligible[0];
    if (row === undefined) {
      return null;
    }
    row.state = "in_flight";
    row.attempt += 1;
    row.fence += 1;
    return this.#lease(row);
  }

  public async recordPlan(
    lease: HistoricalSyncLeaseV1,
    plan: HistoricalIndexPlanV1,
  ): Promise<void> {
    this.#requireIndexLease(lease).plan = plan;
  }

  public async recordApplied(
    lease: HistoricalSyncLeaseV1,
    plan: HistoricalIndexPlanV1,
    remoteDocumentIds: Readonly<Record<string, string>>,
    indexProfileId = "meeting-knowledge.unqualified-index-profile.v1",
  ): Promise<void> {
    const row = this.#requireIndexLease(lease);
    row.plan = plan;
    row.appliedIndexProfileId = indexProfileId;
    row.profileRebuildRequired = false;
    row.remoteDocumentIds = remoteDocumentIds;
    row.state = "applied";
  }

  public async recordRetry(lease: HistoricalSyncLeaseV1): Promise<void> {
    this.#requireLease(lease).state = "retry_wait";
  }

  public async recordDeadLetter(lease: HistoricalSyncLeaseV1): Promise<void> {
    this.#requireLease(lease).state = "dead_letter";
  }

  public async recordDeleted(lease: HistoricalSyncLeaseV1): Promise<void> {
    this.#requireLease(lease).state = "deleted";
  }

  public async requestMeetingDeletion(meetingId: string): Promise<void> {
    for (const row of this.#rows.values()) {
      if (row.binding.meetingId === meetingId && row.state !== "deleted") {
        row.current = false;
        row.operation = "delete_meeting";
        row.state = "deleting";
      }
    }
  }

  public async findCurrentCandidate(
    scopeId: string,
    roomId: string,
    candidateLocator: string,
  ): Promise<HistoricalCandidateRecordV1 | null> {
    for (const row of this.#rows.values()) {
      if (
        !row.current ||
        row.operation !== "index" ||
        row.state !== "applied" ||
        row.binding.scopeId !== scopeId ||
        row.binding.roomId !== roomId ||
        row.plan === null
      ) {
        continue;
      }
      const document = row.plan.documents.find(({ manifest }) =>
        manifest.candidateLocator === candidateLocator
      );
      if (document !== undefined) {
        return {
          binding: row.binding,
          ordinal: document.manifest.ordinal,
          plan: row.plan,
          remoteDocumentIds: row.remoteDocumentIds,
        };
      }
    }
    return null;
  }

  public async findCurrentCandidates(
    scopeId: string,
    roomId: string,
    candidateLocators: readonly string[],
  ): Promise<readonly HistoricalCandidateRecordV1[]> {
    const records = await Promise.all(candidateLocators.map((candidateLocator) =>
      this.findCurrentCandidate(scopeId, roomId, candidateLocator)
    ));
    return records.filter((record): record is HistoricalCandidateRecordV1 => record !== null);
  }

  public async listCurrentRoomPlans(
    scopeId: string,
    roomId: string,
  ): Promise<readonly HistoricalAppliedPlanV1[]> {
    return [...this.#rows.values()]
      .filter((row) =>
        row.current &&
        row.operation === "index" &&
        row.state === "applied" &&
        row.binding.scopeId === scopeId &&
        row.binding.roomId === roomId &&
        row.plan !== null
      )
      .map((row) => ({
        binding: row.binding,
        plan: row.plan as HistoricalIndexPlanV1,
        remoteDocumentIds: row.remoteDocumentIds,
      }));
  }

  public async listDesiredRoomBindings(
    scopeId: string,
    roomId: string,
  ): Promise<readonly HistoricalReleaseBindingV1[]> {
    return [...this.#rows.values()]
      .filter((row) =>
        row.current && row.operation === "index" && row.state !== "deleted" &&
        row.binding.scopeId === scopeId && row.binding.roomId === roomId
      )
      .map(({ binding }) => binding)
      .toSorted((left, right) => compare(left.meetingId, right.meetingId));
  }

  public async isCurrentGeneration(
    binding: HistoricalReleaseBindingV1,
    indexGeneration: string,
  ): Promise<boolean> {
    const row = this.#rows.get(binding.releaseId);
    return row !== undefined && row.current && row.operation === "index" &&
      row.state === "applied" && row.plan !== null &&
      row.binding.desiredGeneration === binding.desiredGeneration &&
      row.plan.topology.indexGeneration === indexGeneration;
  }

  public state(releaseId: string): RowState | null {
    return this.#rows.get(releaseId)?.state ?? null;
  }

  public plan(releaseId: string): HistoricalIndexPlanV1 | null {
    return this.#rows.get(releaseId)?.plan ?? null;
  }

  /** Simulates expiry of a superseded provider write's retained lease fence. */
  public expireSupersededLease(releaseId: string): void {
    const row = this.#rows.get(releaseId);
    if (
      row !== undefined &&
      row.state === "in_flight" &&
      row.operation !== "index"
    ) {
      row.state = "deleting";
    }
  }

  /** Simulates a crash after provider commit but before remote IDs were checkpointed. */
  public forgetRemoteDocumentIds(releaseId: string): void {
    const row = this.#rows.get(releaseId);
    if (row !== undefined) {
      row.remoteDocumentIds = {};
    }
  }

  #lease(row: StateRow): HistoricalSyncLeaseV1 {
    return {
      appliedIndexProfileId: row.appliedIndexProfileId,
      attempt: row.attempt,
      binding: row.binding,
      fence: row.fence,
      operation: row.operation,
      plan: row.plan,
      profileRebuildRequired: row.profileRebuildRequired,
      remoteDocumentIds: row.remoteDocumentIds,
    };
  }

  #requireLease(lease: HistoricalSyncLeaseV1): StateRow {
    const row = this.#rows.get(lease.binding.releaseId);
    if (row === undefined || row.state !== "in_flight" || row.fence !== lease.fence) {
      throw new Error("historical test store lost its lease fence");
    }
    return row;
  }

  #requireIndexLease(lease: HistoricalSyncLeaseV1): StateRow {
    const row = this.#requireLease(lease);
    if (!row.current || row.operation !== "index") {
      throw new Error("historical test index lease was superseded");
    }
    return row;
  }
}

export class MemoryCoverageCheckpoints implements ExhaustiveCoverageStore {
  readonly #rows = new Map<string, CoverageCheckpointLeaseV1>();
  public completed = false;
  public reduction: CoverageReductionV1 | null = null;

  public async open(input: {
    readonly blockLocators: readonly string[];
    readonly checkpointId: string;
    readonly planDigest: string;
  }): Promise<CoverageCheckpointLeaseV1> {
    const existing = this.#rows.get(input.checkpointId);
    if (existing !== undefined) {
      if (existing.state !== "active") {
        return existing;
      }
      const reopened = {
        ...existing,
        attempt: existing.attempt + 1,
        fence: existing.fence + 1,
      };
      this.#rows.set(input.checkpointId, reopened);
      return reopened;
    }
    const created = {
      attempt: 1,
      bitmap: input.blockLocators.map(() => false),
      checkpointId: input.checkpointId,
      extracts: {},
      fence: 1,
      planDigest: input.planDigest,
      reduction: null,
      state: "active" as const,
      terminalReason: null,
    };
    this.#rows.set(input.checkpointId, created);
    return created;
  }

  public async recordExtract(input: {
    readonly blockOrdinal: number;
    readonly checkpointId: string;
    readonly extract: CoverageExtractV1;
    readonly fence: number;
  }): Promise<CoverageCheckpointLeaseV1> {
    const row = this.#require(input.checkpointId, input.fence);
    const bitmap = [...row.bitmap];
    bitmap[input.blockOrdinal] = true;
    const updated = {
      ...row,
      bitmap,
      extracts: { ...row.extracts, [input.extract.blockLocator]: input.extract },
    };
    this.#rows.set(input.checkpointId, updated);
    return updated;
  }

  public async recordReduction(input: {
    readonly checkpointId: string;
    readonly fence: number;
    readonly reduction: CoverageReductionV1;
  }): Promise<void> {
    const row = this.#require(input.checkpointId, input.fence);
    this.reduction = input.reduction;
    this.#rows.set(input.checkpointId, {
      ...row,
      reduction: input.reduction,
    });
  }

  public async complete(input: { readonly checkpointId: string; readonly fence: number }): Promise<void> {
    const row = this.#require(input.checkpointId, input.fence);
    if (row.bitmap.some((bit) => !bit) || this.reduction === null) {
      throw new Error("historical test coverage is incomplete");
    }
    this.#rows.set(input.checkpointId, {
      ...row,
      reduction: this.reduction,
      state: "completed",
      terminalReason: null,
    });
    this.completed = true;
  }

  public async terminate(input: {
    readonly checkpointId: string;
    readonly fence: number;
    readonly reason: string;
    readonly state: "failed" | "invalidated";
  }): Promise<void> {
    const row = this.#require(input.checkpointId, input.fence);
    this.#rows.set(input.checkpointId, {
      ...row,
      state: input.state,
      terminalReason: input.reason,
    });
  }

  public scrubExpired(): Promise<number> {
    return Promise.resolve(0);
  }

  #require(checkpointId: string, fence: number): CoverageCheckpointLeaseV1 {
    const row = this.#rows.get(checkpointId);
    if (row === undefined || row.fence !== fence) {
      throw new Error("historical test checkpoint lost its fence");
    }
    return row;
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
