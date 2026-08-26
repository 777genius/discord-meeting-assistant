import { describe, expect, it, vi } from "vitest";

import {
  HistoricalIndexPlannerUnavailableError,
  HISTORICAL_RETRIEVAL_PROJECTION_CONTRACT_VERSION,
  HistoricalSyncWorker,
  RequestHistoricalMeetingDeletion,
  admitAcceptedFinalMeeting,
  buildHistoricalIndexPlan,
  createHistoricalReleaseBinding,
  type AcceptedFinalMeetingV1,
  type HistoricalAppliedPlanV1,
  type HistoricalCandidateRecordV1,
  type HistoricalIndexPlanV1,
  type HistoricalEmbeddingTokenizerPort,
  type HistoricalMemoryPort,
  type HistoricalOpaqueIdPort,
  type HistoricalReleaseBindingV1,
  type HistoricalSyncClaimOptionsV1,
  type HistoricalSyncLeaseV1,
  type HistoricalSyncStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";

const exactTokenizer: HistoricalEmbeddingTokenizerPort = Object.freeze({
  countTokens: (text: string) => 2 + Array.from(text).length,
  profile: Object.freeze({
    conformanceVectorSetSha256: `sha256:${"c".repeat(64)}`,
    embeddingModelRevision: "a".repeat(40),
    servingRuntimeRevision: "b".repeat(40),
    id: "fixture-exact-tokenizer",
    maxInputTokens: 128,
    tokenizerArtifactSha256: `sha256:${"d".repeat(64)}`,
    tokenizerConfigSha256: `sha256:${"e".repeat(64)}`,
  }),
});

class TestIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    return Buffer.from(`${namespace}:${parts.join("|")}`).toString("base64url");
  }
}

class RecordingIds extends TestIds {
  public readonly calls: { readonly namespace: string; readonly parts: readonly string[] }[] = [];

  public override keyedId(namespace: string, parts: readonly string[]): string {
    this.calls.push({ namespace, parts: [...parts] });
    return super.keyedId(namespace, parts);
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

  public async enqueueAppliedProfileRebuilds(): Promise<{
    readonly enqueued: number; readonly remaining: boolean;
  }> {
    return { enqueued: 0, remaining: false };
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

  public async findCurrentCandidates(): Promise<readonly HistoricalCandidateRecordV1[]> {
    return [];
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

class LegacyProfileRebuildStore extends QueueStore {
  #checkpointedPlan: HistoricalIndexPlanV1 | null = null;

  public override async recordPlan(
    syncLease: HistoricalSyncLeaseV1,
    plan: HistoricalIndexPlanV1,
  ): Promise<void> {
    await super.recordPlan(syncLease, plan);
    this.#checkpointedPlan = plan;
  }

  public override async recordRetry(
    syncLease: HistoricalSyncLeaseV1,
    failure: { readonly code: string; readonly retryAfterMs: number },
  ): Promise<void> {
    await super.recordRetry(syncLease, failure);
    if (this.#checkpointedPlan === null) {
      throw new Error("profile rebuild retry has no durable plan checkpoint");
    }
    this.claims.push({
      ...syncLease,
      attempt: syncLease.attempt + 1,
      fence: syncLease.fence + 1,
      plan: this.#checkpointedPlan,
    });
  }
}

function lease(
  accepted: AcceptedFinalMeetingV1,
  operation: HistoricalSyncLeaseV1["operation"],
  attempt: number,
  plan: HistoricalIndexPlanV1 | null = null,
): HistoricalSyncLeaseV1 {
  return {
    appliedIndexProfileId: null,
    attempt,
    binding: accepted.binding,
    fence: attempt,
    operation,
    plan,
    profileRebuildRequired: false,
    remoteDocumentIds: {},
  };
}

describe("historical exact planning", () => {
  it("retries a transiently unavailable exact planner without dead-lettering", async () => {
    const accepted = meeting();
    const store = new QueueStore([lease(accepted, "index", 1)]);
    const indexFinalMeeting = vi.fn();
    const worker = new HistoricalSyncWorker({
      authority: { loadAcceptedFinalMeeting: async () => accepted },
      ids: new TestIds(),
      memory: { deleteMeeting: vi.fn(), indexFinalMeeting, searchRoom: vi.fn() },
      planner: {
        prepareWindows: async () => {
          throw new HistoricalIndexPlannerUnavailableError("planner busy");
        },
      },
      store,
    });

    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      status: "retry_scheduled",
    });
    expect(store.retries).toEqual(["historical_index_planner.unavailable"]);
    expect(store.deadLetters).toEqual([]);
    expect(store.plans).toEqual([]);
    expect(indexFinalMeeting).not.toHaveBeenCalled();
  });

});

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
      deleteMutationId: plan.deleteMutationId,
      documentExternalIds: plan.documents.map(({ manifest }) => manifest.documentExternalId),
      mode: "release",
      reconciliationDocuments: plan.documents,
      remoteDocumentIds: {},
    }));
  });

  it("retains persisted reconciliation documents after an unknown ingest outcome", async () => {
    const accepted = meeting();
    const ids = new TestIds();
    const indexingStore = new QueueStore([lease(accepted, "index", 1)]);
    const indexFinalMeeting = vi.fn().mockResolvedValue({
      code: "memory.network_error",
      retryable: true,
      status: "outcome_unknown",
    });
    const indexing = new HistoricalSyncWorker({
      authority: { loadAcceptedFinalMeeting: async () => accepted },
      ids,
      memory: { deleteMeeting: vi.fn(), indexFinalMeeting, searchRoom: vi.fn() },
      store: indexingStore,
    });

    await expect(indexing.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      status: "retry_scheduled",
    });
    const persisted = indexingStore.plans[0];
    if (persisted === undefined) {
      throw new Error("unknown ingest outcome did not retain its persisted plan");
    }
    const deletionStore = new QueueStore([
      lease(accepted, "delete_release", 2, persisted),
    ]);
    const deleteMeeting = vi.fn().mockResolvedValue({ status: "verified_absent" });
    const deleting = new HistoricalSyncWorker({
      authority: { loadAcceptedFinalMeeting: async () => accepted },
      ids,
      memory: { deleteMeeting, indexFinalMeeting: vi.fn(), searchRoom: vi.fn() },
      store: deletionStore,
    });

    await expect(deleting.executeOnce({ indexingEnabled: false })).resolves.toMatchObject({
      status: "deleted",
    });
    expect(deleteMeeting).toHaveBeenCalledWith({
      deleteMutationId: persisted.deleteMutationId,
      documentExternalIds: persisted.documents.map(
        ({ manifest }) => manifest.documentExternalId,
      ),
      mode: "release",
      reconciliationDocuments: persisted.documents,
      remoteDocumentIds: {},
      schemaVersion: 1,
      topology: persisted.topology,
    });
    expect(persisted.documents.map(({ mutationId }) => mutationId)).toEqual(
      indexingStore.plans[0]?.documents.map(({ mutationId }) => mutationId),
    );
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

  it("deletes and rebuilds a persisted pre-tokenizer plan before restart convergence", async () => {
    const accepted = meeting();
    const ids = new TestIds();
    const stale = buildHistoricalIndexPlan(accepted, ids);
    const store = new QueueStore([lease(accepted, "index", 2, stale)]);
    const deleteMeeting = vi.fn().mockResolvedValue({ status: "verified_absent" });
    const indexFinalMeeting = vi.fn().mockImplementation(
      async (plan: HistoricalIndexPlanV1) => ({
        remoteDocumentIds: {
          [plan.documents[0]!.manifest.documentExternalId]: "remote-rebuilt",
        },
        status: "applied",
      }),
    );
    const worker = new HistoricalSyncWorker({
      authority: { loadAcceptedFinalMeeting: async () => accepted },
      ids,
      memory: { deleteMeeting, indexFinalMeeting, searchRoom: vi.fn() },
      store,
      tokenizer: () => exactTokenizer,
    });

    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      status: "applied",
    });
    expect(deleteMeeting).toHaveBeenCalledWith(expect.objectContaining({
      documentExternalIds: stale.documents.map(({ manifest }) => manifest.documentExternalId),
    }), {});
    expect(store.plans[0]?.documents[0]?.manifest.embeddingTokenProfile)
      .toContain("meeting-knowledge.multilingual-minilm-exact.v1");
    expect(store.plans[0]?.planDigest).not.toBe(stale.planDigest);
  });

});

describe("historical retrieval projection generation identity", () => {
  it("isolates generation, locator, document, and mutation identities from legacy ingest", () => {
    const ids = new RecordingIds();
    const plan = buildHistoricalIndexPlan(meeting(), ids, undefined, exactTokenizer);
    const generationCall = ids.calls.find(({ namespace }) =>
      namespace === "historical-index-generation"
    );
    expect(generationCall?.parts.at(-1)).toBe(
      HISTORICAL_RETRIEVAL_PROJECTION_CONTRACT_VERSION,
    );
    const legacyGeneration = `mkgen1.${ids.keyedId(
      "historical-index-generation",
      generationCall!.parts.slice(0, -1),
    )}`;
    const document = plan.documents[0]!;
    const legacyLocator = `mkcandidate1.${ids.keyedId("historical-candidate", [
      legacyGeneration,
      String(document.manifest.ordinal),
      document.manifest.contentHash,
    ])}`;
    const legacyDocumentId = `mkdocument1.${ids.keyedId(
      "historical-document",
      [legacyLocator],
    )}`;
    const legacyDocumentMutation = `mkmutation1.${ids.keyedId(
      "historical-index-mutation",
      [legacyDocumentId],
    )}`;
    const legacyReleaseMutation = `mkmutation1.${ids.keyedId(
      "historical-release-index-mutation",
      [plan.topology.releaseRef],
    )}`;

    expect(plan.topology.indexGeneration).not.toBe(legacyGeneration);
    expect(document.manifest.candidateLocator).not.toBe(legacyLocator);
    expect(document.manifest.documentExternalId).not.toBe(legacyDocumentId);
    expect(document.mutationId).not.toBe(legacyDocumentMutation);
    expect(plan.indexMutationId).not.toBe(legacyReleaseMutation);
  });

  it("deletes and rebuilds a persisted legacy projection before indexing", async () => {
    const accepted = meeting();
    const ids = new TestIds();
    const current = buildHistoricalIndexPlan(accepted, ids);
    const legacy = {
      ...current,
      topology: {
        ...current.topology,
        projectionContractVersion: "legacy.document-retrieval-projection.none",
      },
    };
    const store = new QueueStore([{
      ...lease(accepted, "index", 2, legacy),
      appliedIndexProfileId: "legacy-profile",
    }]);
    const deleteMeeting = vi.fn().mockResolvedValue({ status: "verified_absent" });
    let indexedProjectionContractVersion: string | null = null;
    const indexFinalMeeting = vi.fn(
      async (plan: HistoricalIndexPlanV1) => {
        indexedProjectionContractVersion = plan.topology.projectionContractVersion;
        return {
          remoteDocumentIds: {
            [plan.documents[0]!.manifest.documentExternalId]: "remote-v2",
          },
          status: "applied" as const,
        };
      },
    );
    const worker = new HistoricalSyncWorker({
      authority: { loadAcceptedFinalMeeting: async () => accepted },
      ids,
      memory: { deleteMeeting, indexFinalMeeting, searchRoom: vi.fn() },
      store,
    });

    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      status: "applied",
    });
    expect(deleteMeeting).toHaveBeenCalledWith(expect.objectContaining({
      topology: legacy.topology,
    }), {});
    expect(indexFinalMeeting).toHaveBeenCalledTimes(1);
    expect(indexedProjectionContractVersion).toBe(
      HISTORICAL_RETRIEVAL_PROJECTION_CONTRACT_VERSION,
    );
  });
});

describe("historical profile rebuild retry", () => {
  it.each([
    {
      code: "memory.network_error",
      retryable: true,
      status: "outcome_unknown",
    },
    {
      code: "memory.known_failure",
      retryable: true,
      status: "rejected",
    },
  ] as const)(
    "converges a profile rebuild after $status without leaking the old projection",
    async (firstIndexResult) => {
      const accepted = meeting();
      const ids = new TestIds();
      const blockPolicy = {
        maxBlockUtf8Bytes: 4_096,
        maxBlocksPerMeeting: 100,
        maxTurnsPerBlock: 64,
        version: "meeting-knowledge.block-policy.v1" as const,
      };
      const oldPlan = buildHistoricalIndexPlan(accepted, ids, blockPolicy);
      const oldExternalId = oldPlan.documents[0]!.manifest.documentExternalId;
      const oldRemoteIds = { [oldExternalId]: "remote-old" };
      const initialLease = {
        ...lease(accepted, "index", 1, oldPlan),
        appliedIndexProfileId: "old-profile",
        profileRebuildRequired: true,
        remoteDocumentIds: oldRemoteIds,
      };
      const store = new LegacyProfileRebuildStore([initialLease]);
      const remoteDocuments = new Map([["remote-old", oldExternalId]]);
      let remoteSequence = 0;
      const deleteMeeting = vi.fn(async (request: Parameters<
        HistoricalMemoryPort["deleteMeeting"]
      >[0]) => {
        const targets = new Set(request.documentExternalIds);
        if (Object.keys(request.remoteDocumentIds).some((externalId) =>
          !targets.has(externalId)
        )) {
          return {
            code: "memory.contract_rejected",
            retryable: false,
            status: "absence_unverified" as const,
          };
        }
        for (const [remoteId, externalId] of remoteDocuments) {
          if (targets.has(externalId)) {
            remoteDocuments.delete(remoteId);
          }
        }
        return { status: "verified_absent" as const };
      });
      const indexFinalMeeting = vi.fn(async (plan: HistoricalIndexPlanV1) => {
        const externalId = plan.documents[0]!.manifest.documentExternalId;
        remoteSequence += 1;
        remoteDocuments.set(`remote-new-${remoteSequence}`, externalId);
        return remoteSequence === 1
          ? firstIndexResult
          : {
              remoteDocumentIds: { [externalId]: `remote-new-${remoteSequence}` },
              status: "applied" as const,
            };
      });
      const worker = new HistoricalSyncWorker({
        authority: { loadAcceptedFinalMeeting: async () => accepted },
        ids,
        indexProfileId: "new-profile",
        memory: { deleteMeeting, indexFinalMeeting, searchRoom: vi.fn() },
        store,
        tokenizer: () => exactTokenizer,
      }, {
        blockPolicy,
        leaseDurationMs: 30_000,
        maximumIndexAttempts: 3,
        retryBackoffMs: [1],
        version: "meeting-knowledge.historical-sync.v1",
      });

      await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
        status: "retry_scheduled",
      });
      await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
        status: "applied",
      });

      const rebuiltPlan = store.plans[0]!;
      const rebuiltExternalId = rebuiltPlan.documents[0]!.manifest.documentExternalId;
      expect(rebuiltExternalId).not.toBe(oldExternalId);
      expect(deleteMeeting).toHaveBeenNthCalledWith(1, expect.objectContaining({
        documentExternalIds: [oldExternalId],
        remoteDocumentIds: oldRemoteIds,
      }), {});
      expect(deleteMeeting).toHaveBeenNthCalledWith(2, expect.objectContaining({
        documentExternalIds: [rebuiltExternalId],
        remoteDocumentIds: {},
      }), {});
      expect([...remoteDocuments.values()]).toEqual([rebuiltExternalId]);
      expect(store.retries).toEqual([firstIndexResult.code]);
      expect(store.applied).toEqual([accepted.binding.releaseId]);
      expect(store.deadLetters).toEqual([]);
    },
  );

});

describe("historical projection sync worker recovery", () => {
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
