import { describe, expect, it } from "vitest";

import {
  HistoricalFocusedRetrieval,
  HistoricalSyncWorker,
  historicalEmbeddingTokenProfile,
  type HistoricalIndexPlannerPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  CooperativeHistoricalIndexPlanner,
  HmacHistoricalOpaqueIds,
  InfinityContextHistoricalMemoryAdapter,
  PinnedMultilingualMiniLmTokenizer,
  Sha256HistoricalReceiptDigest,
} from "../src/index.js";
import { DisposableInfinityEndpoint } from "./disposable-infinity-endpoint.js";
import {
  MemoryHistoricalAuthority,
  MemoryHistoricalStore,
  finalMeeting,
} from "./historical-e2e-test-kit.js";

const blockPolicy = {
  maxBlockUtf8Bytes: 512,
  maxBlocksPerMeeting: 100,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1",
} as const;

describe("historical planner query isolation", () => {
  it("never replans the whole meeting while answering focused questions", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const tokenizer = new PinnedMultilingualMiniLmTokenizer();
    const planner = new CooperativeHistoricalIndexPlanner();
    let plannerInvocations = 0;
    const countingPlanner: HistoricalIndexPlannerPort = {
      prepareWindows: async (...args) => {
        plannerInvocations += 1;
        return planner.prepareWindows(...args);
      },
    };
    const meeting = finalMeeting(1, "Tuesday");
    const authority = new MemoryHistoricalAuthority();
    const store = new MemoryHistoricalStore();
    const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x5a));
    authority.put(meeting);
    await store.acceptRelease(meeting.binding);
    const memory = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid",
      embeddingTokenProfile: () => historicalEmbeddingTokenProfile(tokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });
    await memory.qualifyCapabilities();
    const worker = new HistoricalSyncWorker({
      authority,
      ids,
      memory,
      planner: countingPlanner,
      receiptDigest: new Sha256HistoricalReceiptDigest(),
      store,
    }, {
      blockPolicy,
      leaseDurationMs: 30_000,
      maximumIndexAttempts: 3,
      retryBackoffMs: [1],
      version: "meeting-knowledge.historical-sync.v1",
    });

    await expect(worker.executeOnce({ indexingEnabled: true }))
      .resolves.toMatchObject({ operation: "index", status: "applied" });
    expect(plannerInvocations).toBe(1);
    await planner.close();

    const focused = new HistoricalFocusedRetrieval({
      authority,
      authorization: {
        authorize: async () => ({
          authorizationDigest: "scope:room:policy-v1",
          authorizationEpoch: "1",
          authorized: true,
          policyVersion: "room-authorization.v1",
        }),
      },
      ids,
      memory,
      store,
      tokenizer: () => tokenizer,
    }, {
      blockPolicy,
      candidateLimitPerQuery: 8,
      maximumDecomposedQueries: 4,
      maximumEvidenceBytes: 16_000,
      maximumLocalScanBlocks: 100,
      minimumProviderScore: 0.01,
      neighborRadius: 1,
      rerankLimit: 5,
      searchTimeoutMs: 500,
      version: "meeting-knowledge.focused-retrieval.v1",
    });
    const invocationsAfterIndex = plannerInvocations;
    for (const question of [
      "What is the Project Cedar launch day?",
      "When is Project Cedar launching?",
      "Which day did we choose for Cedar?",
      "Remind me of the Project Cedar launch day.",
    ]) {
      await expect(focused.buildPlan({
        authorizationPrincipalRef: "principal",
        currentMeetingId: meeting.binding.meetingId,
        question,
        roomId: meeting.binding.roomId,
        scopeId: meeting.binding.scopeId,
        searchEnabled: true,
        servingAuthorized: true,
        sourceSet: "current",
      })).resolves.toMatchObject({ status: "ready" });
    }

    expect(plannerInvocations).toBe(invocationsAfterIndex);
  }, 30_000);
});
