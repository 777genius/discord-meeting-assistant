import {
  HistoricalFocusedRetrieval,
  buildHistoricalIndexPlan,
  HistoricalSyncWorker,
  type AcceptedFinalMeetingV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  HmacHistoricalOpaqueIds,
  InfinityContextHistoricalMemoryAdapter,
} from "../src/index.js";
import {
  MemoryHistoricalAuthority,
  MemoryHistoricalStore,
} from "./historical-e2e-test-kit.js";
import { frozenSemanticQualityCorpus } from "./semantic-quality-corpus.js";

const blockPolicy = {
  maxBlockUtf8Bytes: 1_536,
  maxBlocksPerMeeting: 100,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1",
} as const;

export interface SemanticQualityRetrievalConfig {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly token?: string;
}

export interface SemanticQualityRetrievalOutcome {
  readonly candidateBlockCountAt5: number;
  readonly localRehydrationVerified: boolean;
  readonly providerPayloadWasReferenceOnly: true;
  readonly queryId: string;
  readonly rehydratedTurnIds: readonly string[];
  readonly status: "ready" | "unavailable";
  readonly topFiveTurnIds: readonly string[];
  readonly wholeTranscriptIncluded: false;
}

export interface SemanticQualityRetrievalRun {
  readonly corpusSha256: string;
  readonly outcomes: readonly SemanticQualityRetrievalOutcome[];
  readonly remoteCleanupVerified: true;
  readonly service: {
    readonly apiVersion: string;
    readonly enabledAdapters: readonly string[];
    readonly name: string;
  };
}

/**
 * Runs the frozen holdout through the production adapter, which is the sole
 * official-SDK transport. The returned artifact contains opaque/local IDs only:
 * provider text and the full transcript cannot cross this boundary.
 */
export async function runSemanticQualityRetrieval(
  config: SemanticQualityRetrievalConfig,
): Promise<SemanticQualityRetrievalRun> {
  const corpus = frozenSemanticQualityCorpus();
  const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0xb6));
  const authority = new MemoryHistoricalAuthority();
  const store = new MemoryHistoricalStore();
  const adapter = new InfinityContextHistoricalMemoryAdapter({
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    schemaVersion: 1,
    ...(config.token === undefined ? {} : { token: config.token }),
  });
  const worker = new HistoricalSyncWorker({ authority, ids, memory: adapter, store }, {
    blockPolicy,
    leaseDurationMs: 120_000,
    maximumIndexAttempts: 3,
    retryBackoffMs: [1_000, 5_000],
    version: "meeting-knowledge.historical-sync.v1",
  });
  authority.put(corpus.meeting);
  await store.acceptRelease(corpus.meeting.binding);

  const capabilities = await adapter.qualifyCapabilities();
  if (!capabilities.supportsQdrant || capabilities.apiVersion === null ||
    capabilities.serviceName === null || !capabilities.enabledAdapters.includes("qdrant")) {
    throw new Error("semantic quality retrieval requires a healthy identified qdrant service");
  }
  let resultRun: Omit<SemanticQualityRetrievalRun, "remoteCleanupVerified"> | null = null;
  const topology = buildHistoricalIndexPlan(corpus.meeting, ids, blockPolicy).topology;
  let failure: unknown;
  try {
    const indexed = await worker.executeOnce({ indexingEnabled: true });
    if (indexed.status !== "applied") {
      throw new Error("semantic quality corpus was not indexed");
    }
    const retrieval = focusedRetrieval(adapter, authority, store, ids);
    const outcomes: SemanticQualityRetrievalOutcome[] = [];
    for (const question of corpus.questions) {
      const result = await retrieval.buildPlan({
        authorizationPrincipalRef: "semantic-quality-principal",
        currentMeetingId: corpus.meeting.binding.meetingId,
        question: question.question,
        roomId: corpus.meeting.binding.roomId,
        scopeId: corpus.meeting.binding.scopeId,
        searchEnabled: true,
        servingAuthorized: true,
        sourceSet: "current",
      });
      if (result.status !== "ready") {
        outcomes.push(Object.freeze({
          candidateBlockCountAt5: 0,
          localRehydrationVerified: true,
          providerPayloadWasReferenceOnly: true,
          queryId: question.id,
          rehydratedTurnIds: Object.freeze([]),
          status: "unavailable",
          topFiveTurnIds: Object.freeze([]),
          wholeTranscriptIncluded: false,
        }));
        continue;
      }
      const blocksByLocator = new Map(result.plan.blocks.map((block) => [
        block.candidateLocator,
        block,
      ]));
      const topLocators = result.plan.evidenceLocators.slice(0, 5);
      const topFiveTurnIds = unique(topLocators.flatMap((locator) =>
        blocksByLocator.get(locator)?.turns.map(({ turnId }) => turnId) ?? []));
      const rehydratedTurnIds = unique(result.plan.blocks.flatMap((block) =>
        block.turns.map(({ turnId }) => turnId)));
      outcomes.push(Object.freeze({
        candidateBlockCountAt5: topLocators.length,
        localRehydrationVerified: locallyMatches(corpus.meeting, result.plan.blocks),
        providerPayloadWasReferenceOnly: true,
        queryId: question.id,
        rehydratedTurnIds,
        status: "ready",
        topFiveTurnIds,
        wholeTranscriptIncluded: false,
      }));
    }
    resultRun = Object.freeze({
      corpusSha256: corpus.corpusSha256,
      outcomes: Object.freeze(outcomes),
      service: Object.freeze({
        apiVersion: capabilities.apiVersion,
        enabledAdapters: Object.freeze([...capabilities.enabledAdapters]),
        name: capabilities.serviceName,
      }),
    });
  } catch (error) {
    failure = error;
  }
  await store.requestMeetingDeletion(corpus.meeting.binding.meetingId);
  const deleted = await worker.executeOnce({ indexingEnabled: false });
  if (deleted.status !== "deleted") {
    const cleanupFailure = new Error("semantic quality cleanup did not delete remote evidence");
    if (failure !== undefined) {
      throw new AggregateError([failure, cleanupFailure], "semantic quality run and cleanup failed");
    }
    throw cleanupFailure;
  }
  try {
    await expectRemoteAbsence(adapter, {
      requestTimeoutMs: config.requestTimeoutMs,
      roomScopeExternalRef: topology.roomScopeExternalRef,
      spaceSlug: topology.spaceSlug,
    });
  } catch (cleanupError) {
    if (failure !== undefined) {
      throw combinedFailure(failure, cleanupError);
    }
    throw cleanupError;
  }
  if (failure !== undefined) {
    throw failure;
  }
  if (resultRun === null) {
    throw new Error("semantic quality run produced no retrieval artifact");
  }
  return Object.freeze({
    ...resultRun,
    remoteCleanupVerified: true,
  });
}

function focusedRetrieval(
  adapter: InfinityContextHistoricalMemoryAdapter,
  authority: MemoryHistoricalAuthority,
  store: MemoryHistoricalStore,
  ids: HmacHistoricalOpaqueIds,
): HistoricalFocusedRetrieval {
  return new HistoricalFocusedRetrieval({
    authority,
    authorization: { authorize: async () => ({
      authorizationDigest: "fixture-quality-scope:fixture-quality-room:policy-v1",
      authorizationEpoch: "1",
      authorized: true,
      policyVersion: "room-authorization.v1",
    }) },
    ids,
    memory: adapter,
    store,
  }, {
    blockPolicy,
    candidateLimitPerQuery: 8,
    maximumDecomposedQueries: 4,
    maximumEvidenceBytes: 16_000,
    maximumLocalScanBlocks: 100,
    minimumProviderScore: 0.01,
    neighborRadius: 1,
    rerankLimit: 5,
    searchTimeoutMs: 30_000,
    version: "meeting-knowledge.focused-retrieval.v1",
  });
}

function locallyMatches(
  meeting: AcceptedFinalMeetingV1,
  blocks: readonly { readonly turns: readonly { readonly text: string; readonly turnId: string }[] }[],
): boolean {
  const local = new Map(meeting.humanTurns.map(({ text, turnId }) => [turnId, text]));
  return blocks.every((block) => block.turns.every((turn) => local.get(turn.turnId) === turn.text));
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function combinedFailure(primary: unknown, cleanup: unknown): AggregateError {
  return new AggregateError(
    [primary, cleanup],
    "semantic quality run and cleanup failed",
    { cause: cleanup },
  );
}

async function expectRemoteAbsence(
  adapter: InfinityContextHistoricalMemoryAdapter,
  input: {
    readonly requestTimeoutMs: number;
    readonly roomScopeExternalRef: string;
    readonly spaceSlug: string;
  },
): Promise<void> {
  const deadline = Date.now() + 60_000;
  do {
    const result = await adapter.searchRoom({
      candidateLimit: 5,
      query: "verify synthetic quality corpus cleanup",
      roomScopeExternalRef: input.roomScopeExternalRef,
      schemaVersion: 1,
      spaceSlug: input.spaceSlug,
      timeoutMs: input.requestTimeoutMs,
    });
    if (result.status === "available" && result.candidates.length === 0) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  } while (Date.now() < deadline);
  throw new Error("semantic quality evidence remained remotely searchable after deletion");
}
