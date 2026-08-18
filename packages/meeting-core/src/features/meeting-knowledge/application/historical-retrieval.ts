import { classifyHistoricalGroundingMode, normalizeHistoricalQuestion } from "../domain/grounding-mode.js";
import {
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  admitsHistoricalRetrieval,
  type TwoHourHistoricalRetrievalProfileV1,
} from "../domain/historical-evidence.js";
import {
  buildHistoricalRoomTopology,
  HistoricalIndexPlanError,
  rehydrateHistoricalBlock,
  type HistoricalEvidenceBlockPolicyV1,
  DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
} from "./historical-index-plan.js";
import type { HistoricalAuthorizationObservationV1, HistoricalAuthorizationPort } from "./ports/historical-grounding.js";
import type { HistoricalCandidateLocatorV1, HistoricalMemoryPort, HistoricalOpaqueIdPort, LocallyRehydratedEvidenceBlockV1 } from "./ports/historical-memory.js";
import type { HistoricalAppliedPlanV1, HistoricalEvidenceAuthority, HistoricalSyncStore } from "./ports/historical-state.js";
import {
  decomposeHistoricalQuery,
  isRequestedMeeting,
  mergeQualifiedHistoricalSearchResults,
  rerankHistoricalBlocks,
} from "./historical-retrieval-ranking.js";
import { refreshStrictFocusedBlocks } from "./historical-focused-refresh.js";

export interface FocusedRetrievalPolicyV1 {
  readonly blockPolicy: HistoricalEvidenceBlockPolicyV1;
  readonly candidateLimitPerQuery: number;
  readonly maximumDecomposedQueries: number;
  readonly maximumEvidenceBytes: number;
  readonly maximumLocalScanBlocks: number;
  readonly minimumProviderScore: number;
  readonly neighborRadius: number;
  readonly rerankLimit: number;
  readonly searchTimeoutMs: number;
  readonly version: "meeting-knowledge.focused-retrieval.v1";
}

type FocusedRetrievalPolicyInputV1 = Omit<FocusedRetrievalPolicyV1, "version"> & { readonly version: string };

export const DEFAULT_FOCUSED_RETRIEVAL_POLICY: FocusedRetrievalPolicyV1 = Object.freeze({
  blockPolicy: DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
  candidateLimitPerQuery: 40,
  maximumDecomposedQueries: 4,
  maximumEvidenceBytes: 24_000,
  maximumLocalScanBlocks: 512,
  minimumProviderScore: 0.01,
  neighborRadius: 1,
  rerankLimit: 8,
  searchTimeoutMs: 3_000,
  version: "meeting-knowledge.focused-retrieval.v1",
});

export interface FocusedGroundingPlanV1 {
  readonly blocks: readonly LocallyRehydratedEvidenceBlockV1[];
  readonly completenessClaim: false;
  readonly evidenceLocators: readonly string[];
  readonly queries: readonly string[];
  readonly retrievalSource: "local_fallback" | "qualified_hybrid";
  readonly sources: readonly {
    readonly kind: "current" | "historical";
    readonly locator: string;
    readonly providerRank: number | null;
    readonly providerScore: number | null;
    readonly qualifiedScore: number;
  }[];
  readonly selection: "locally_rehydrated_focused_blocks_only";
  readonly schemaVersion: 1;
  readonly strategy: "focused_retrieval";
}

export type FocusedRetrievalResultV1 =
  | { readonly mode: "exhaustive_coverage"; readonly status: "route_required" }
  | { readonly reason: string; readonly status: "insufficient_evidence" | "unauthorized" }
  | { readonly plan: FocusedGroundingPlanV1; readonly status: "ready" };

function authorizationMatches(before: HistoricalAuthorizationObservationV1, after: HistoricalAuthorizationObservationV1): boolean {
  return before.authorized && after.authorized &&
    before.authorizationDigest === after.authorizationDigest &&
    before.authorizationEpoch === after.authorizationEpoch &&
    before.policyVersion === after.policyVersion;
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function assertPolicy(policy: FocusedRetrievalPolicyInputV1): FocusedRetrievalPolicyV1 {
  if (
    policy.version !== "meeting-knowledge.focused-retrieval.v1" ||
    !isBoundedInteger(policy.candidateLimitPerQuery, 1, 100) ||
    !isBoundedInteger(policy.maximumDecomposedQueries, 1, 8) ||
    !isBoundedInteger(policy.maximumEvidenceBytes, 256, 131_072) ||
    !isBoundedInteger(policy.maximumLocalScanBlocks, 1, 2_048) ||
    !Number.isFinite(policy.minimumProviderScore) ||
    policy.minimumProviderScore < 0 ||
    policy.minimumProviderScore > 1 ||
    !isBoundedInteger(policy.neighborRadius, 0, 4) ||
    !isBoundedInteger(policy.rerankLimit, 1, 64) ||
    !isBoundedInteger(policy.searchTimeoutMs, 1, 60_000)
  ) {
    throw new RangeError("focused historical retrieval policy is outside its qualified bounds");
  }
  return Object.freeze({ ...policy, version: "meeting-knowledge.focused-retrieval.v1" });
}

export class HistoricalFocusedRetrieval {
  readonly #policy: FocusedRetrievalPolicyV1;
  readonly #twoHourProfile: TwoHourHistoricalRetrievalProfileV1;

  public constructor(
    private readonly dependencies: {
      readonly authority: HistoricalEvidenceAuthority;
      readonly authorization: HistoricalAuthorizationPort;
      readonly ids: HistoricalOpaqueIdPort;
      readonly memory: HistoricalMemoryPort;
      readonly store: HistoricalSyncStore;
    },
    policy: FocusedRetrievalPolicyV1 = DEFAULT_FOCUSED_RETRIEVAL_POLICY,
    twoHourProfile: TwoHourHistoricalRetrievalProfileV1 =
      DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  ) {
    this.#policy = assertPolicy(policy);
    this.#twoHourProfile = Object.freeze({ ...twoHourProfile });
  }

  public async buildPlan(input: {
    readonly authorizationPrincipalRef: string;
    readonly currentMeetingId?: string;
    readonly question: string;
    readonly roomId: string;
    readonly servingAuthorized: boolean;
    readonly signal?: AbortSignal;
    readonly scopeId: string;
    readonly searchEnabled: boolean;
    readonly sourceSet: "current" | "historical" | "room";
  }): Promise<FocusedRetrievalResultV1> {
    const question = normalizeHistoricalQuestion(input.question);
    input.signal?.throwIfAborted();
    if (!input.servingAuthorized) {
      return { reason: "historical_serving_disabled", status: "insufficient_evidence" };
    }
    if (classifyHistoricalGroundingMode(question) === "exhaustive_coverage") {
      return { mode: "exhaustive_coverage", status: "route_required" };
    }
    const authorizationRequest = {
      authorizationPrincipalRef: input.authorizationPrincipalRef,
      roomId: input.roomId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      scopeId: input.scopeId,
    };
    const before = await this.dependencies.authorization.authorize(authorizationRequest);
    if (!before.authorized) {
      return { reason: "room_authorization_denied", status: "unauthorized" };
    }

    const queries = decomposeHistoricalQuery(
      question,
      this.#policy.maximumDecomposedQueries,
    );
    const remoteCandidates = await this.remoteCandidates(input, queries);
    const candidates = remoteCandidates?.candidates ?? [];
    let retrievalSource: FocusedGroundingPlanV1["retrievalSource"] =
      remoteCandidates === null ? "local_fallback" : "qualified_hybrid";
    let rehydrated = remoteCandidates === null
      ? await this.localFallback(input)
      : await this.rehydrateCandidates(input, candidates);
    if (remoteCandidates !== null && rehydrated?.length === 0) {
      rehydrated = await this.localFallback(input);
      retrievalSource = "local_fallback";
    }
    if (rehydrated === null || rehydrated.length === 0) {
      return { reason: "no_current_authorized_evidence", status: "insufficient_evidence" };
    }

    const ranked = rerankHistoricalBlocks(
      rehydrated,
      queries,
      candidates,
      this.#policy,
    );
    if (ranked.length === 0) {
      return { reason: "focused_evidence_budget_exhausted", status: "insufficient_evidence" };
    }
    input.signal?.throwIfAborted();
    const refreshed = await refreshStrictFocusedBlocks({
      authority: this.dependencies.authority,
      blockPolicy: this.#policy.blockPolicy,
      ids: this.dependencies.ids,
      requestedMeeting: (meetingId) => isRequestedMeeting(meetingId, input),
      roomId: input.roomId,
      scopeId: input.scopeId,
      selected: ranked.map(({ block }) => block),
      signal: input.signal,
      store: this.dependencies.store,
    });
    if (refreshed.length === 0) {
      return { reason: "selected_evidence_became_stale", status: "insufficient_evidence" };
    }
    const after = await this.dependencies.authorization.authorize(authorizationRequest);
    if (!authorizationMatches(before, after)) {
      return { reason: "authorization_changed", status: "unauthorized" };
    }
    const refreshedSignals = new Map(
      ranked.map((item) => [item.block.candidateLocator, item]),
    );
    return {
      plan: Object.freeze({
        blocks: refreshed,
        completenessClaim: false,
        evidenceLocators: Object.freeze(
          refreshed.map(({ candidateLocator }) => candidateLocator),
        ),
        queries,
        retrievalSource,
        selection: "locally_rehydrated_focused_blocks_only",
        schemaVersion: 1,
        sources: Object.freeze(refreshed.map((block) => {
          const signals = refreshedSignals.get(block.candidateLocator);
          return Object.freeze({
            kind: input.currentMeetingId === block.binding.meetingId
              ? "current" as const
              : "historical" as const,
            locator: block.candidateLocator,
            providerRank: signals?.providerRank ?? null,
            providerScore: signals?.providerScore ?? null,
            qualifiedScore: signals?.qualifiedScore ?? 0,
          });
        })),
        strategy: "focused_retrieval",
      }),
      status: "ready",
    };
  }

  public async reauthorizeRoom(input: {
    readonly authorizationPrincipalRef: string;
    readonly roomId: string;
    readonly scopeId: string;
  }): Promise<boolean> {
    const observation = await this.dependencies.authorization.authorize(input);
    return observation.authorized;
  }

  private async search(
    scopeId: string,
    roomId: string,
    queries: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ readonly candidates: readonly HistoricalCandidateLocatorV1[] } | null> {
    const topology = buildHistoricalRoomTopology(scopeId, roomId, this.dependencies.ids);
    let results: readonly Awaited<ReturnType<HistoricalMemoryPort["searchRoom"]>>[];
    try {
      results = await Promise.all(queries.map((query) =>
        this.dependencies.memory.searchRoom({
          candidateLimit: this.#policy.candidateLimitPerQuery,
          query,
          roomScopeExternalRef: topology.roomScopeExternalRef,
          schemaVersion: 1,
          ...(signal === undefined ? {} : { signal }),
          spaceSlug: topology.spaceSlug,
          timeoutMs: this.#policy.searchTimeoutMs,
        })
      ));
    } catch {
      signal?.throwIfAborted();
      return null;
    }
    return mergeQualifiedHistoricalSearchResults(results);
  }

  private async rehydrateCandidates(
    input: Parameters<HistoricalFocusedRetrieval["buildPlan"]>[0],
    candidates: readonly HistoricalCandidateLocatorV1[],
  ): Promise<readonly LocallyRehydratedEvidenceBlockV1[]> {
    const output = new Map<string, LocallyRehydratedEvidenceBlockV1>();
    for (const candidate of candidates) {
      const record = await this.dependencies.store.findCurrentCandidate(
        input.scopeId,
        input.roomId,
        candidate.locator,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (
        record === null ||
        !isRequestedMeeting(record.binding.meetingId, input)
      ) {
        continue;
      }
      await this.rehydratePlanNeighborhood(record, output, input.signal);
    }
    return Object.freeze([...output.values()]);
  }

  private async rehydratePlanNeighborhood(
    record: HistoricalAppliedPlanV1 & { readonly ordinal: number },
    output: Map<string, LocallyRehydratedEvidenceBlockV1>,
    signal?: AbortSignal,
  ): Promise<void> {
    const meeting = await this.dependencies.authority.loadAcceptedFinalMeeting(
      record.binding,
      signal === undefined ? {} : { signal },
    );
    if (
      meeting === null ||
      !admitsHistoricalRetrieval(meeting, this.#twoHourProfile) ||
      !await this.dependencies.store.isCurrentGeneration(
      record.binding,
      record.plan.topology.indexGeneration,
      signal === undefined ? {} : { signal },
    )) {
      return;
    }
    const first = Math.max(0, record.ordinal - this.#policy.neighborRadius);
    const last = Math.min(
      record.plan.documents.length - 1,
      record.ordinal + this.#policy.neighborRadius,
    );
    try {
      for (let ordinal = first; ordinal <= last; ordinal += 1) {
        const block = rehydrateHistoricalBlock(
          meeting,
          record.plan,
          ordinal,
          this.dependencies.ids,
          this.#policy.blockPolicy,
        );
        output.set(block.candidateLocator, block);
      }
    } catch (error) {
      if (!(error instanceof HistoricalIndexPlanError)) {
        throw error;
      }
    }
  }

  private async remoteCandidates(
    input: Parameters<HistoricalFocusedRetrieval["buildPlan"]>[0],
    queries: readonly string[],
  ): Promise<{ readonly candidates: readonly HistoricalCandidateLocatorV1[] } | null> {
    if (!input.searchEnabled || !await this.remoteSearchAdmitted(input)) {
      return null;
    }
    return this.search(input.scopeId, input.roomId, queries, input.signal);
  }

  private async remoteSearchAdmitted(
    input: Parameters<HistoricalFocusedRetrieval["buildPlan"]>[0],
  ): Promise<boolean> {
    const plans = (await this.dependencies.store.listCurrentRoomPlans(
      input.scopeId,
      input.roomId,
      this.#policy.maximumLocalScanBlocks + 1,
      input.signal === undefined ? {} : { signal: input.signal },
    )).filter(({ binding }) => isRequestedMeeting(binding.meetingId, input));
    for (const { binding } of plans) {
      const meeting = await this.dependencies.authority.loadAcceptedFinalMeeting(
        binding,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (
        meeting === null ||
        !admitsHistoricalRetrieval(meeting, this.#twoHourProfile)
      ) {
        return false;
      }
    }
    return true;
  }

  private async localFallback(
    input: Parameters<HistoricalFocusedRetrieval["buildPlan"]>[0],
  ): Promise<readonly LocallyRehydratedEvidenceBlockV1[] | null> {
    const plans = (await this.dependencies.store.listCurrentRoomPlans(
      input.scopeId,
      input.roomId,
      this.#policy.maximumLocalScanBlocks + 1,
      input.signal === undefined ? {} : { signal: input.signal },
    )).filter(({ binding }) => isRequestedMeeting(binding.meetingId, input));
    const blockCount = plans.reduce((count, { plan }) => count + plan.documents.length, 0);
    if (blockCount > this.#policy.maximumLocalScanBlocks) {
      return null;
    }
    const output: LocallyRehydratedEvidenceBlockV1[] = [];
    for (const record of plans) {
      const meeting = await this.dependencies.authority.loadAcceptedFinalMeeting(
        record.binding,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (
        meeting === null ||
        !admitsHistoricalRetrieval(meeting, this.#twoHourProfile) ||
        !await this.dependencies.store.isCurrentGeneration(
        record.binding,
        record.plan.topology.indexGeneration,
        input.signal === undefined ? {} : { signal: input.signal },
      )) {
        continue;
      }
      try {
        const recordBlocks = record.plan.documents.map((document) =>
          rehydrateHistoricalBlock(
            meeting,
            record.plan,
            document.manifest.ordinal,
            this.dependencies.ids,
            this.#policy.blockPolicy,
          )
        );
        output.push(...recordBlocks);
      } catch (error) {
        if (!(error instanceof HistoricalIndexPlanError)) {
          throw error;
        }
      }
    }
    return Object.freeze(output);
  }

}
