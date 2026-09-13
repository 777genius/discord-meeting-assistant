import { resolveFocusedRetrievalScope, historicalSnapshotMatchesScope } from "./focused-locator-retrieval-v2-scope.js";
import { compareRetrievalV2Utf8, retrievalV2ConsumerEvidenceByteLimit, isLocatorRetrievalBinding,
  validateFocusedLocatorRetrievalV3Request,
  type FocusedLocatorRetrievalRequestSnapshot,
  type FocusedLocatorRetrievalV3RequestSnapshot,
  type RetrievalBindingSnapshot } from
  "../domain/retrieval-admission.js";
import type { FocusedMemoryReference } from
  "../domain/grounding-plan.js";
import { buildHistoricalRoomTopology } from "./historical-index-plan.js";
import { hasAmbiguousRequestedActorAlias, hasUncertainRequestedActorAlias,
  resolveRequestedActorKeys, type IdentitySkeletonPortV1,
  type RetrievalActorAliasOwnerV1, type RetrievalActorReferenceAuthorityV1 } from
  "./speaker-alias-resolution.js";
import { boundedRetrievalQuery, classifyRelativeTimeFilter,
  redactRetrievalQueryIdentities } from
  "./focused-locator-retrieval-v2-query.js";
import type { FocusedHistoricalEvidenceV2Port,
  FocusedRetrievalScopeResolutionPort,
  FocusedRetrievalScopeResolutionEffects,
  FocusedLocatorRetrievalPreparation,
  FocusedLocatorRetrievalV2Preparation,
  FocusedLocatorRetrievalV2RequestSnapshot } from
  "./ports/focused-locator-retrieval-v2.js";
import type { HistoricalOpaqueIdPort } from
  "./ports/historical-memory.js";
import type { HistoricalRoomAuthoritySnapshotPort } from
  "./ports/historical-state.js";
import type { FocusedMemoryRetrievalPort,
  FocusedMemoryRetrievalResult } from
  "./ports/final-reply.js";
import { decodeFocusedMemoryRetrievalResult } from
  "./ports/focused-memory-contract.js";
import { HistoricalFocusedLocatorRetrievalV2, HistoricalFocusedLocatorRetrievalV3 } from
  "./focused-locator-historical-rehydration-v2.js";
import { deduplicateEvidenceTurns } from "./grounded-question-internals.js";

export { HistoricalFocusedLocatorRetrievalV2, HistoricalFocusedLocatorRetrievalV3 } from
  "./focused-locator-historical-rehydration-v2.js";
export interface FocusedLocatorRetrievalV2Policy {
  readonly candidateLimit: number;
  readonly deadlineMs: number;
  readonly evidenceByteLimit: number;
  readonly maximumSources: number;
  readonly responseByteLimit: number;
  readonly resultLimit: number;
  readonly version: "meeting-knowledge.locator-retrieval.v2";
}
export const DEFAULT_FOCUSED_LOCATOR_RETRIEVAL_V2_POLICY:
FocusedLocatorRetrievalV2Policy = Object.freeze({
  candidateLimit: 100,
  deadlineMs: 2_000,
  evidenceByteLimit: retrievalV2ConsumerEvidenceByteLimit,
  maximumSources: 100,
  responseByteLimit: 16_384,
  resultLimit: 10,
  version: "meeting-knowledge.locator-retrieval.v2",
});
abstract class PrepareFocusedLocatorRetrievalRequest<T extends FocusedLocatorRetrievalRequestSnapshot> {
  protected abstract readonly contractVersion: T["binding"]["contractVersion"];
  public constructor(
    private readonly dependencies: {
      readonly ids: HistoricalOpaqueIdPort;
      readonly scopeResolution?: FocusedRetrievalScopeResolutionPort;
      readonly identitySkeletons?: IdentitySkeletonPortV1;
      readonly providerBinding: T["binding"];
      readonly actorReferences?: RetrievalActorReferenceAuthorityV1;
      readonly servingAuthorized?: () => boolean;
      readonly speakerAliases?: readonly RetrievalActorAliasOwnerV1[];
      readonly snapshot?: HistoricalRoomAuthoritySnapshotPort;
      /** Test fixtures may retain the old property name. */
      readonly store?: HistoricalRoomAuthoritySnapshotPort;
    },
    private readonly policy: FocusedLocatorRetrievalV2Policy =
      DEFAULT_FOCUSED_LOCATOR_RETRIEVAL_V2_POLICY,
  ) {}

  public async prepare(input: {
    readonly scopeResolutionEffects?: FocusedRetrievalScopeResolutionEffects;
    readonly currentMeetingId: string;
    readonly question: string;
    readonly roomId: string;
    readonly scopeId: string;
    readonly signal?: AbortSignal;
  }): Promise<FocusedLocatorRetrievalPreparation<T>> {
    input.signal?.throwIfAborted();
    if (this.dependencies.providerBinding.contractVersion !== this.contractVersion) {throw new TypeError("Retrieval contract mismatch");}
    if (this.dependencies.servingAuthorized?.() === false) {return unavailablePreparation("serving_not_authorized");}
    const aliases = this.dependencies.speakerAliases ?? [];
    const skeletons = this.dependencies.identitySkeletons;
    if (speakerFilterIsDenied(input.question, aliases, skeletons)) {return unavailablePreparation("retrieval_filter_denied");}
    const timeFilter = classifyRelativeTimeFilter(input.question);
    if (timeFilter.status === "denied") {return unavailablePreparation("retrieval_filter_denied");}
    const requestedActorKeys = new Set([
      ...resolveRequestedActorKeys(input.question, aliases, skeletons),
      ...(this.dependencies.actorReferences?.actorKeysForQuestion(input.question) ?? []),
    ]);
    const snapshot = await this.loadSnapshot(input);
    if (snapshot.status !== "current") { return snapshot; }
    const plans = snapshot.entries;
    if (plans.length === 0) {return Object.freeze({ reason: "no_history_or_index", status: "empty" });}
    if (plans.length > this.policy.maximumSources) {return unavailablePreparation("historical_authority_overflow");}
    if (this.dependencies.servingAuthorized?.() === false) {return unavailablePreparation("serving_not_authorized");}
    const topology = buildHistoricalRoomTopology(
      input.scopeId,
      input.roomId,
      this.dependencies.ids,
    );
    const query = boundedRetrievalQuery(redactRetrievalQueryIdentities(
      input.question,
      aliases,
      skeletons,
    ));
    if (query.length === 0) {return unavailablePreparation("query_not_admitted");}
    const actorKeys = Object.freeze([...requestedActorKeys]
      .toSorted(compareRetrievalV2Utf8));
    const relativeTimeInterval = timeFilter.status === "valid"
      ? timeFilter.interval : null;
    const scope = await resolveFocusedRetrievalScope(this.dependencies.scopeResolution, input, topology);
    if (scope === null) {return unavailablePreparation("scope_resolution_unavailable");}
    const common = {
      binding: Object.freeze({ ...this.dependencies.providerBinding,
        requiredProviderLanes: Object.freeze([...this.dependencies.providerBinding.requiredProviderLanes]) }),
      budgets: Object.freeze({
        candidateLimit: this.policy.candidateLimit,
        deadlineMs: this.policy.deadlineMs,
        evidenceByteLimit: this.policy.evidenceByteLimit,
        neighborRadius: 0 as const,
        responseByteLimit: this.policy.responseByteLimit,
        resultLimit: this.policy.resultLimit,
      }),
      filters: Object.freeze({
        actorKeys,
        category: null,
        documentKeys: Object.freeze([]),
        excludedSourceKeys: Object.freeze([]),
        kinds: Object.freeze(["record_block"]),
        relativeTimeInterval,
        sourceGenerations: Object.freeze(plans.map(({ plan }) => Object.freeze({
          projectionGeneration: plan.topology.indexGeneration,
          sourceKey: plan.topology.releaseRef,
        })).toSorted((left, right) =>
          compareRetrievalV2Utf8(left.sourceKey, right.sourceKey))),
        tagsAll: Object.freeze([]),
        tagsAny: Object.freeze([]),
        tagsNone: Object.freeze([]),
        timeInterval: null,
      }),
      queries: Object.freeze([Object.freeze({
        query,
        queryId: "original-question",
      })]),
      schemaVersion: 2 as const,
      scope: Object.freeze({
        memoryScopeId: scope.memoryScopeId,
        spaceId: scope.spaceId,
        threadId: null,
      }),
      softPreferences: Object.freeze({
        actorPreferences: Object.freeze([]),
        relativeTimeInterval: null,
        sourcePreferences: Object.freeze([]),
        timeInterval: null,
        timeWeightMicros: null,
      }),
    };
    const versioned = this.dependencies.providerBinding.contractVersion === "context-retrieval.v3"
      ? validateFocusedLocatorRetrievalV3Request({ ...common, schemaVersion: 3,
          scope: { memoryScopeId: scope.memoryScopeId, spaceId: scope.spaceId,
            thread: { mode: "any" } } })
      : common;
    // Build the status-bearing object before freezing; validation never grants scope authority.
    const request = preparedRequest({ ...versioned } as T);
    try { scope.bind(request); } catch {
      return unavailablePreparation("scope_resolution_unavailable");
    }
    return request;
  }

  private async loadSnapshot(
    input: Parameters<PrepareFocusedLocatorRetrievalRequest<T>["prepare"]>[0],
  ) {
    const snapshotPort = this.dependencies.snapshot ?? this.dependencies.store;
    if (snapshotPort === undefined) {return unavailablePreparation("historical_authority_unavailable");}
    const snapshot = await snapshotPort.loadRoomAuthoritySnapshot({
      maximumSources: this.policy.maximumSources,
      pageSize: Math.min(25, this.policy.maximumSources),
      roomId: input.roomId, scopeId: input.scopeId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!historicalSnapshotMatchesScope(snapshot, input, this.dependencies.providerBinding.contractVersion)) {
      return unavailablePreparation(snapshot.status === "overflow"
        ? "historical_authority_overflow"
        : "historical_authority_unavailable");
    }
    return snapshot;
  }


}

export class PrepareFocusedLocatorRetrievalV2Request extends
  PrepareFocusedLocatorRetrievalRequest<FocusedLocatorRetrievalV2RequestSnapshot> { protected readonly contractVersion = "context-retrieval.v2"; }

export class PrepareFocusedLocatorRetrievalV3Request extends
  PrepareFocusedLocatorRetrievalRequest<FocusedLocatorRetrievalV3RequestSnapshot> { protected readonly contractVersion = "context-retrieval.v3"; }

function preparedRequest<T extends FocusedLocatorRetrievalRequestSnapshot>(
  request: T,
): T & { readonly status: "prepared" } {
  const result = request as T & {
    readonly status: "prepared";
  };
  Object.defineProperty(result, "status", {
    configurable: false,
    enumerable: false,
    value: "prepared",
    writable: false,
  });
  return Object.freeze(result);
}

function unavailablePreparation(
  reason: Extract<FocusedLocatorRetrievalV2Preparation,
    { readonly status: "unavailable" }>["reason"],
): Extract<FocusedLocatorRetrievalV2Preparation, { readonly status: "unavailable" }> {
  return Object.freeze({ reason, status: "unavailable" });
}

function speakerFilterIsDenied(
  question: string,
  aliases: readonly RetrievalActorAliasOwnerV1[],
  skeletons: IdentitySkeletonPortV1 | undefined,
): boolean {
  return (aliases.length > 0 && skeletons === undefined) ||
    hasUncertainRequestedActorAlias(question, aliases, skeletons) ||
    hasAmbiguousRequestedActorAlias(question, aliases, skeletons);
}

class FocusedHistoricalEvidence<T extends FocusedLocatorRetrievalRequestSnapshot> implements FocusedHistoricalEvidenceV2Port {
  public constructor(private readonly dependencies: {
    readonly admission: { prepare(input: Parameters<PrepareFocusedLocatorRetrievalV2Request["prepare"]>[0]):
      Promise<FocusedLocatorRetrievalPreparation<T>> };
    readonly retrieval: { retrieveEvidence(input: Omit<Parameters<HistoricalFocusedLocatorRetrievalV2["retrieveEvidence"]>[0], "request"> &
      { readonly request: T }): ReturnType<HistoricalFocusedLocatorRetrievalV2["retrieveEvidence"]> };
  }) {}

  public async retrieve(
    input: Parameters<FocusedHistoricalEvidenceV2Port["retrieve"]>[0],
  ) {
    input.signal.throwIfAborted();
    const request = await this.dependencies.admission.prepare({
      currentMeetingId: input.currentMeetingId,
      question: input.question,
      roomId: input.roomId, scopeId: input.scopeId,
      signal: input.signal,
    });
    if (request.status === "unavailable") {
      return Object.freeze({ reason: "request_not_admitted" as const,
        status: "unavailable" as const });
    }
    if (request.status === "empty") {
      return Object.freeze({ authorityGeneration: "historical-empty:v1",
        status: "empty" as const });
    }
    const result = await this.dependencies.retrieval.retrieveEvidence({
      authorizationPrincipalRef: input.authorizationPrincipalRef,
      currentMeetingId: input.currentMeetingId,
      request,
      roomId: input.roomId, scopeId: input.scopeId,
      signal: input.signal,
    });
    if (result.status !== "current") {return result;}
    const canonicalTurns = [...deduplicateEvidenceTurns(result.turns, {
      meetingId: input.currentMeetingId,
      transcriptId: `live-memory-v1:${input.currentMeetingId}`,
      transcriptVersion: 1,
    }).values()];
    return Object.freeze({
      ...result,
      turns: Object.freeze(canonicalTurns.slice(0, input.maximumCandidates)),
    });
  }
}

export class FocusedHistoricalEvidenceV2 extends FocusedHistoricalEvidence<FocusedLocatorRetrievalV2RequestSnapshot> {}
export class FocusedHistoricalEvidenceV3 extends FocusedHistoricalEvidence<FocusedLocatorRetrievalV3RequestSnapshot> {}

class PersistedFocusedMemoryRetrieval implements FocusedMemoryRetrievalPort {
  public constructor(private readonly dependencies: {
    readonly current: FocusedMemoryRetrievalPort;
  } & (
    | { readonly retrievalPath: "infinity_locator_v2";
        readonly historical: HistoricalFocusedLocatorRetrievalV2 }
    | { readonly retrievalPath: "infinity_locator_v3";
        readonly historical: HistoricalFocusedLocatorRetrievalV3 }
  )) {}

  public async retrieve(input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0]):
  Promise<FocusedMemoryRetrievalResult> {
    input.signal?.throwIfAborted();
    const binding = input.retrievalBinding;
    if (!isLocatorRetrievalBinding(binding) ||
      input.authorizationPrincipalRef === undefined) {
      return unavailable();
    }
    const authorizationPrincipalRef = input.authorizationPrincipalRef;
    const invoke = <T,>(lane: () => Promise<T>): Promise<T> => {
      input.signal?.throwIfAborted();
      return lane();
    };
    const [currentLane, historicalLane] = await settleWithAbort(Promise.allSettled([
      invoke(() => this.dependencies.current.retrieve(input)),
      invoke(async () => {
        const dependencies = this.dependencies;
        const scope = { authorizationPrincipalRef, currentMeetingId: input.meetingId,
          roomId: input.roomId, scopeId: input.scopeId,
          ...(input.signal === undefined ? {} : { signal: input.signal }) };
        if (binding.retrievalPath === "infinity_locator_v3" &&
          dependencies.retrievalPath === "infinity_locator_v3") {
          return dependencies.historical.retrieve({ ...scope, request: binding.request });
        }
        if (binding.retrievalPath === "infinity_locator_v2" &&
          dependencies.retrievalPath === "infinity_locator_v2") {
          return dependencies.historical.retrieve({ ...scope, request: binding.request });
        }
        return unavailable();
      }),
    ]), input.signal);
    const current = currentLane.status === "fulfilled" ? decodeLane(currentLane.value) : null;
    const historical = historicalLane.status === "fulfilled" ? decodeLane(historicalLane.value) : null;
    if (current === null || historical === null) {return unavailable();}
    // The local lane owns the bound current authority. Its explicit stale or
    // pending result cannot be repaired with historical evidence.
    if (current.status === "stale" || current.status === "pending") {return current;}
    if (historical.status !== "current" ||
      (current.status !== "current" && current.status !== "low_coverage")) {
      return unavailable();
    }
    if (current.authorityGeneration !== input.expectedAuthorityGeneration) {return unavailable();}
    const maximum = Math.min(input.maximumCandidates, 256);
    // Local low coverage is established only after the current adapter's
    // authority fence. It contributes no candidates; it does not erase valid
    // evidence from the independently authorized historical lane.
    const currentCandidates = current.status === "current" ? current.candidates : [];
    const historicalCandidates = historical.candidates;
    const candidates = interleave(currentCandidates, historicalCandidates, maximum);
    if (candidates.length === 0 && current.status === "low_coverage") {
      return Object.freeze({
        authorityGeneration: current.authorityGeneration,
        schemaVersion: 1,
        status: "low_coverage",
      });
    }
    return candidates.length === 0 ? unavailable() : Object.freeze({
      authorityGeneration: current.authorityGeneration,
      candidates,
      schemaVersion: 1,
      status: "current",
    });
  }

  public reauthorizeHistoricalEvidence(input: {
    readonly authorizationPrincipalRef: string;
    readonly roomId: string;
    readonly scopeId: string;
  }): Promise<boolean> {
    return this.dependencies.historical.reauthorizeRoom(input);
  }
}

export class PersistedFocusedMemoryRetrievalV2 extends PersistedFocusedMemoryRetrieval {
  public constructor(dependencies: { readonly current: FocusedMemoryRetrievalPort;
    readonly historical: HistoricalFocusedLocatorRetrievalV2 }) {
    super({ ...dependencies, retrievalPath: "infinity_locator_v2" });
  }
}
export class PersistedFocusedMemoryRetrievalV3 extends PersistedFocusedMemoryRetrieval {
  public constructor(dependencies: { readonly current: FocusedMemoryRetrievalPort;
    readonly historical: HistoricalFocusedLocatorRetrievalV3 }) {
    super({ ...dependencies, retrievalPath: "infinity_locator_v3" });
  }
}

function interleave(current: readonly FocusedMemoryReference[], historical: readonly FocusedMemoryReference[], maximum: number): readonly FocusedMemoryReference[] {
  const currentLane = dedupe(current);
  const currentIds = new Set(currentLane.map(canonicalKey));
  const historicalLane = dedupe(historical).filter((candidate) => !currentIds.has(canonicalKey(candidate)));
  const output: FocusedMemoryReference[] = [];
  for (let index = 0; output.length < maximum && (index < currentLane.length || index < historicalLane.length); index += 1) {
    if (currentLane[index] !== undefined) { output.push(currentLane[index]!); }
    if (historicalLane[index] !== undefined && output.length < maximum) { output.push(historicalLane[index]!); }
  }
  return Object.freeze(output);
}
function canonicalKey(reference: FocusedMemoryReference): string {
  return [reference.meetingId, reference.transcriptId,
    reference.transcriptVersion, reference.turnId,
    reference.sourceStartCodePoint ?? "",
    reference.sourceEndCodePoint ?? ""].join("\u0000");
}
function dedupe(references: readonly FocusedMemoryReference[]): FocusedMemoryReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => { const key = canonicalKey(reference); if (seen.has(key)) { return false; } seen.add(key); return true; });
}

function decodeLane(value: unknown): FocusedMemoryRetrievalResult | null {
  try { return decodeFocusedMemoryRetrievalResult(value); } catch { return null; }
}

async function settleWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) { return operation; }
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => { reject(signal.reason ?? new DOMException("Aborted", "AbortError")); }; signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([operation, aborted]); } finally { signal.removeEventListener("abort", onAbort); }
}

function unavailable(): FocusedMemoryRetrievalResult {
  return Object.freeze({ schemaVersion: 1, status: "unavailable" });
}

export function isPersistedRetrievalV2Binding(
  binding: RetrievalBindingSnapshot,
): binding is Extract<RetrievalBindingSnapshot,
  { readonly retrievalPath: "infinity_locator_v2" }> {
  return binding.retrievalPath === "infinity_locator_v2";
}
