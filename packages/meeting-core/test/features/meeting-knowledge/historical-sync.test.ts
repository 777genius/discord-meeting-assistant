import { describe, expect, it, vi } from "vitest";

import {
  HistoricalSyncWorker,
  RequestHistoricalMeetingDeletion,
  admitAcceptedFinalMeeting,
  buildHistoricalIndexPlan,
  createHistoricalReleaseBinding,
  type AcceptedFinalMeetingV1,
  type HistoricalAppliedPlanV1,
  type HistoricalCandidateRecordV1,
  type HistoricalIndexPlanV1,
  type HistoricalMemoryPort,
  type HistoricalOpaqueIdPort,
  type HistoricalReleaseBindingV1,
  type HistoricalSyncClaimOptionsV1,
  type HistoricalSyncLeaseV1,
  type HistoricalSyncStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";

class TestIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    return Buffer.from(`${namespace}:${parts.join("|")}`).toString("base64url");
  }
}

function meeting(): AcceptedFinalMeetingV1 {
  const binding = createHistoricalReleaseBinding({
    acceptedMeetingRevision: 3,
    desiredGeneration: 1,
    meetingId: "meeting-1",
    roomId: "room-1",
    scopeId: "scope-1",
    transcriptId: "transcript-1",
    transcriptVersion: 1,
  });
  const admitted = admitAcceptedFinalMeeting({
    actors: [{ actorId: "speaker-1", kind: "human" }],
    binding,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "fixture-r1",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingRevision: 3,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion: 1,
    turns: [{
      endMs: 1_000,
      speakerId: "speaker-1",
      startMs: 0,
      text: "launch on Tuesday",
      turnId: "turn-1",
    }],
  });
  if (admitted === null) {
    throw new Error("fixture admission failed");
  }
  return admitted;
}

class QueueStore implements HistoricalSyncStore {
  public readonly deadLetters: string[] = [];
  public readonly deleted: string[] = [];
  public readonly applied: string[] = [];
  public readonly claimedLeaseDurations: number[] = [];
  public readonly plans: HistoricalIndexPlanV1[] = [];
  public readonly retries: string[] = [];
  public readonly requestedMeetingDeletions: string[] = [];

  public constructor(public readonly claims: HistoricalSyncLeaseV1[]) {}

  public async acceptRelease(_binding: HistoricalReleaseBindingV1): Promise<"accepted"> {
    return "accepted";
  }

  public async claimNext(options: HistoricalSyncClaimOptionsV1): Promise<HistoricalSyncLeaseV1 | null> {
    this.claimedLeaseDurations.push(options.leaseDurationMs);
    return this.claims.shift() ?? null;
  }

  public async recordPlan(_lease: HistoricalSyncLeaseV1, plan: HistoricalIndexPlanV1): Promise<void> {
    this.plans.push(plan);
  }

  public async recordApplied(
    _lease: HistoricalSyncLeaseV1,
    _plan: HistoricalIndexPlanV1,
    _remoteDocumentIds: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.applied.push(_lease.binding.releaseId);
  }

  public async recordRetry(
    _lease: HistoricalSyncLeaseV1,
    failure: { readonly code: string; readonly retryAfterMs: number },
  ): Promise<void> {
    this.retries.push(failure.code);
  }

  public async recordDeadLetter(_lease: HistoricalSyncLeaseV1, code: string): Promise<void> {
    this.deadLetters.push(code);
  }

  public async recordDeleted(syncLease: HistoricalSyncLeaseV1): Promise<void> {
    this.deleted.push(syncLease.binding.releaseId);
  }

  public async requestMeetingDeletion(meetingId: string): Promise<void> {
    this.requestedMeetingDeletions.push(meetingId);
  }

  public async findCurrentCandidate(
    _scopeId: string,
    _roomId: string,
    _candidateLocator: string,
  ): Promise<HistoricalCandidateRecordV1 | null> {
    return null;
  }

  public async listCurrentRoomPlans(
    _scopeId: string,
    _roomId: string,
  ): Promise<readonly HistoricalAppliedPlanV1[]> {
    return [];
  }

  public async listDesiredRoomBindings(
    _scopeId: string,
    _roomId: string,
  ): Promise<readonly HistoricalReleaseBindingV1[]> {
    return [];
  }

  public async isCurrentGeneration(
    _binding: HistoricalReleaseBindingV1,
    _indexGeneration: string,
  ): Promise<boolean> {
    return false;
  }
}

function lease(
  accepted: AcceptedFinalMeetingV1,
  operation: HistoricalSyncLeaseV1["operation"],
  attempt: number,
  plan: HistoricalIndexPlanV1 | null = null,
): HistoricalSyncLeaseV1 {
  return {
    attempt,
    binding: accepted.binding,
    fence: attempt,
    operation,
    plan,
    remoteDocumentIds: {},
  };
}

describe("historical projection sync worker", () => {
  it("persists authorized source withdrawal independently of serving flags", async () => {
    const store = new QueueStore([]);
    const deletion = new RequestHistoricalMeetingDeletion(store);

    await deletion.execute("  meeting-1  ");
    expect(store.requestedMeetingDeletions).toEqual(["meeting-1"]);
    await expect(deletion.execute("   ")).rejects.toThrow(RangeError);
  });

  it("retries ambiguous index outcomes and dead-letters a bounded terminal failure", async () => {
    const accepted = meeting();
    const store = new QueueStore([
      lease(accepted, "index", 1),
      lease(accepted, "index", 2),
    ]);
    const memory: HistoricalMemoryPort = {
      deleteMeeting: vi.fn(),
      indexFinalMeeting: vi.fn()
        .mockResolvedValueOnce({ code: "memory.network_error", retryable: true, status: "outcome_unknown" })
        .mockResolvedValueOnce({ code: "memory.contract_rejected", retryable: false, status: "rejected" }),
      searchRoom: vi.fn(),
    };
    const worker = new HistoricalSyncWorker({
      authority: { loadAcceptedFinalMeeting: async () => accepted },
      ids: new TestIds(),
      memory,
      store,
    }, {
      blockPolicy: {
        maxBlockUtf8Bytes: 4_096,
        maxBlocksPerMeeting: 100,
        maxTurnsPerBlock: 64,
        version: "meeting-knowledge.block-policy.v1",
      },
      leaseDurationMs: 30_000,
      maximumIndexAttempts: 2,
      retryBackoffMs: [1],
      version: "meeting-knowledge.historical-sync.v1",
    });

    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      status: "retry_scheduled",
    });
    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      status: "dead_lettered",
    });
    expect(store.retries).toEqual(["memory.network_error"]);
    expect(store.deadLetters).toEqual(["memory.contract_rejected"]);
    expect(store.plans[0]).toEqual(store.plans[1]);
  });

  it("drains and reconciles deletion while indexing is disabled", async () => {
    const accepted = meeting();
    const ids = new TestIds();
    const plan = buildHistoricalIndexPlan(accepted, ids);
    const store = new QueueStore([lease(accepted, "delete_release", 1, plan)]);
    const deleteMeeting = vi.fn().mockResolvedValue({ status: "verified_absent" });
    const worker = new HistoricalSyncWorker({
      authority: { loadAcceptedFinalMeeting: async () => accepted },
      ids,
      memory: { deleteMeeting, indexFinalMeeting: vi.fn(), searchRoom: vi.fn() },
      store,
    });

    await expect(worker.executeOnce({ indexingEnabled: false })).resolves.toMatchObject({
      operation: "delete_release",
      status: "deleted",
    });
    expect(deleteMeeting).toHaveBeenCalledWith(expect.objectContaining({
      documentExternalIds: plan.documents.map(({ manifest }) => manifest.documentExternalId),
      mode: "release",
    }));
  });

  it("replays the persisted mutation plan exactly after policy drift", async () => {
    const accepted = meeting();
    const ids = new TestIds();
    const persisted = buildHistoricalIndexPlan(accepted, ids, {
      maxBlockUtf8Bytes: 512,
      maxBlocksPerMeeting: 100,
      maxTurnsPerBlock: 64,
      version: "meeting-knowledge.block-policy.v1",
    });
    const store = new QueueStore([lease(accepted, "index", 2, persisted)]);
    const indexFinalMeeting = vi.fn().mockResolvedValue({
      remoteDocumentIds: { [persisted.documents[0]!.manifest.documentExternalId]: "remote-1" },
      status: "applied",
    });
    const worker = new HistoricalSyncWorker({
      authority: { loadAcceptedFinalMeeting: async () => accepted },
      ids,
      memory: { deleteMeeting: vi.fn(), indexFinalMeeting, searchRoom: vi.fn() },
      store,
    });

    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      status: "applied",
    });
    expect(indexFinalMeeting).toHaveBeenCalledWith(persisted);
    expect(store.plans).toEqual([persisted]);
  });

  it("dead-letters a persisted projection that no longer matches authoritative evidence", async () => {
    const accepted = meeting();
    const ids = new TestIds();
    const persisted = buildHistoricalIndexPlan(accepted, ids);
    const first = persisted.documents[0]!;
    const tampered = {
      ...persisted,
      documents: [{ ...first, embeddingText: `${first.embeddingText} tampered` }],
    };
    const store = new QueueStore([lease(accepted, "index", 2, tampered)]);
    const indexFinalMeeting = vi.fn();
    const worker = new HistoricalSyncWorker({
      authority: { loadAcceptedFinalMeeting: async () => accepted },
      ids,
      memory: { deleteMeeting: vi.fn(), indexFinalMeeting, searchRoom: vi.fn() },
      store,
    });

    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      status: "dead_lettered",
    });
    expect(store.deadLetters).toEqual(["historical_index_plan.stale_plan"]);
    expect(store.plans).toEqual([]);
    expect(indexFinalMeeting).not.toHaveBeenCalled();
  });

  it("never abandons authorized deletion in a dead letter", async () => {
    const accepted = meeting();
    const ids = new TestIds();
    const plan = buildHistoricalIndexPlan(accepted, ids);
    const store = new QueueStore([lease(accepted, "delete_meeting", 9, plan)]);
    const worker = new HistoricalSyncWorker({
      authority: { loadAcceptedFinalMeeting: async () => accepted },
      ids,
      memory: {
        deleteMeeting: vi.fn().mockResolvedValue({
          code: "memory.absence_unverified",
          retryable: false,
          status: "absence_unverified",
        }),
        indexFinalMeeting: vi.fn(),
        searchRoom: vi.fn(),
      },
      store,
    });

    await expect(worker.executeOnce({ indexingEnabled: false })).resolves.toMatchObject({
      status: "retry_scheduled",
    });
    expect(store.retries).toEqual(["memory.absence_unverified"]);
    expect(store.deadLetters).toEqual([]);
  });

  it.each(["index", "delete_release"] as const)(
    "does not persist a late %s outcome after its active pass is cancelled",
    async (operation) => {
      const accepted = meeting();
      const ids = new TestIds();
      const storedPlan = buildHistoricalIndexPlan(accepted, ids);
      const store = new QueueStore([
        lease(accepted, operation, 1, operation === "index" ? null : storedPlan),
      ]);
      const controller = new AbortController();
      let settle: (() => void) | undefined;
      let providerStarted = 0;
      const provider = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const memory: HistoricalMemoryPort = {
        deleteMeeting: async () => {
          providerStarted += 1;
          await provider;
          return { status: "verified_absent" };
        },
        indexFinalMeeting: async () => {
          providerStarted += 1;
          await provider;
          return { remoteDocumentIds: {}, status: "applied" };
        },
        searchRoom: vi.fn(),
      };
      const worker = new HistoricalSyncWorker({
        authority: { loadAcceptedFinalMeeting: async () => accepted },
        ids,
        memory,
        store,
      }, {
        blockPolicy: {
          maxBlockUtf8Bytes: 4_096,
          maxBlocksPerMeeting: 100,
          maxTurnsPerBlock: 64,
          version: "meeting-knowledge.block-policy.v1",
        },
        leaseDurationMs: 630_000,
        maximumIndexAttempts: 2,
        retryBackoffMs: [1],
        version: "meeting-knowledge.historical-sync.v1",
      });

      const running = worker.executeOnce({
        indexingEnabled: true,
        signal: controller.signal,
      });
      await vi.waitFor(() => {
        expect(providerStarted).toBe(1);
      });
      controller.abort(new DOMException("runtime closing", "AbortError"));
      settle?.();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
      expect(store.claimedLeaseDurations).toEqual([630_000]);
      expect(store.applied).toEqual([]);
      expect(store.deleted).toEqual([]);
      expect(store.retries).toEqual([]);
      expect(store.deadLetters).toEqual([]);
    },
  );
});
