import { compareRetrievalV2Utf8, retrievalV2ConsumerEvidenceByteLimit,
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
  FocusedLocatorRetrievalV2ProviderBinding,
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
import { HistoricalFocusedLocatorRetrievalV2 } from
  "./focused-locator-historical-rehydration-v2.js";

export { HistoricalFocusedLocatorRetrievalV2 } from
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
  deadlineMs: 1_000,
  evidenceByteLimit: retrievalV2ConsumerEvidenceByteLimit,
  maximumSources: 100,
  responseByteLimit: 16_384,
  resultLimit: 10,
  version: "meeting-knowledge.locator-retrieval.v2",
});
export class PrepareFocusedLocatorRetrievalV2Request {
  public constructor(
    private readonly dependencies: {
      readonly ids: HistoricalOpaqueIdPort;
      readonly identitySkeletons?: IdentitySkeletonPortV1;
      readonly providerBinding: FocusedLocatorRetrievalV2ProviderBinding;
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
    readonly currentMeetingId: string;
    readonly question: string;
    readonly roomId: string;
    readonly scopeId: string;
    readonly signal?: AbortSignal;
  }): Promise<FocusedLocatorRetrievalV2Preparation> {
    input.signal?.throwIfAborted();
    if (this.dependencies.servingAuthorized?.() === false) {
      return unavailablePreparation("serving_not_authorized");
    }
    const aliases = this.dependencies.speakerAliases ?? [];
    const skeletons = this.dependencies.identitySkeletons;
    if (speakerFilterIsDenied(input.question, aliases, skeletons)) {
      return unavailablePreparation("retrieval_filter_denied");
    }
    const timeFilter = classifyRelativeTimeFilter(input.question);
    if (timeFilter.status === "denied") {
      return unavailablePreparation("retrieval_filter_denied");
    }
    const requestedActorKeys = new Set([
      ...resolveRequestedActorKeys(input.question, aliases, skeletons),
      ...(this.dependencies.actorReferences?.actorKeysForQuestion(input.question) ?? []),
    ]);
    const snapshotPort = this.dependencies.snapshot ?? this.dependencies.store;
    if (snapshotPort === undefined) {
      return unavailablePreparation("historical_authority_unavailable");
    }
    const snapshot = await snapshotPort.loadRoomAuthoritySnapshot({
      maximumSources: this.policy.maximumSources,
      pageSize: Math.min(25, this.policy.maximumSources),
      roomId: input.roomId,
      scopeId: input.scopeId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (snapshot.status !== "current") {
      return unavailablePreparation(snapshot.status === "overflow"
        ? "historical_authority_overflow"
        : "historical_authority_unavailable");
    }
    const plans = snapshot.entries;
    if (plans.length === 0) {
      return Object.freeze({ reason: "no_history_or_index", status: "empty" });
    }
    if (plans.length > this.policy.maximumSources) {
      return unavailablePreparation("historical_authority_overflow");
    }
    if (this.dependencies.servingAuthorized?.() === false) {
      return unavailablePreparation("serving_not_authorized");
    }
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
    if (query.length === 0) {
      return unavailablePreparation("query_not_admitted");
    }
    const actorKeys = Object.freeze([...requestedActorKeys]
      .toSorted(compareRetrievalV2Utf8));
    const relativeTimeInterval = timeFilter.status === "valid"
      ? timeFilter.interval : null;
    return preparedRequest({
      binding: Object.freeze({ ...this.dependencies.providerBinding,
        requiredProviderLanes: Object.freeze([
          ...this.dependencies.providerBinding.requiredProviderLanes,
        ]) }),
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
        memoryScopeId: topology.roomScopeExternalRef,
        spaceId: topology.spaceSlug,
        threadId: null,
      }),
      softPreferences: Object.freeze({
        actorPreferences: Object.freeze([]),
        relativeTimeInterval: null,
        sourcePreferences: Object.freeze([]),
        timeInterval: null,
        timeWeightMicros: null,
      }),
    });
  }
}

function preparedRequest(
  request: FocusedLocatorRetrievalV2RequestSnapshot,
): FocusedLocatorRetrievalV2Preparation {
  const result = request as FocusedLocatorRetrievalV2RequestSnapshot & {
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
): FocusedLocatorRetrievalV2Preparation {
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

export class FocusedHistoricalEvidenceV2 implements FocusedHistoricalEvidenceV2Port {
  public constructor(private readonly dependencies: {
    readonly admission: PrepareFocusedLocatorRetrievalV2Request;
    readonly retrieval: HistoricalFocusedLocatorRetrievalV2;
  }) {}

  public async retrieve(
    input: Parameters<FocusedHistoricalEvidenceV2Port["retrieve"]>[0],
  ) {
    input.signal.throwIfAborted();
    const request = await this.dependencies.admission.prepare({
      currentMeetingId: input.currentMeetingId,
      question: input.question,
      roomId: input.roomId,
      scopeId: input.scopeId,
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
      roomId: input.roomId,
      scopeId: input.scopeId,
      signal: input.signal,
    });
    return result.status !== "current" ? result : Object.freeze({
      ...result,
      turns: Object.freeze(result.turns.slice(0, input.maximumCandidates)),
    });
  }
}

export class PersistedFocusedMemoryRetrievalV2 implements FocusedMemoryRetrievalPort {
  public constructor(private readonly dependencies: {
    readonly current: FocusedMemoryRetrievalPort;
    readonly historical: HistoricalFocusedLocatorRetrievalV2;
  }) {}

  public async retrieve(input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0]):
  Promise<FocusedMemoryRetrievalResult> {
    const binding = input.retrievalBinding;
    if (binding?.retrievalPath !== "infinity_locator_v2" ||
      input.authorizationPrincipalRef === undefined) {
      return unavailable();
    }
    const [currentLane, historicalLane] = await Promise.allSettled([
      this.dependencies.current.retrieve(input),
      this.dependencies.historical.retrieve({
        authorizationPrincipalRef: input.authorizationPrincipalRef,
        currentMeetingId: input.meetingId,
        request: binding.request,
        roomId: input.roomId,
        scopeId: input.scopeId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    ]);
    input.signal?.throwIfAborted();
    const current = currentLane.status === "fulfilled"
      ? currentLane.value
      : unavailable();
    const historical = historicalLane.status === "fulfilled"
      ? historicalLane.value
      : unavailable();
    // The local lane owns the bound current authority. Its explicit stale or
    // pending result cannot be repaired with historical evidence.
    if (current.status === "stale" || current.status === "pending") {
      return current;
    }
    if (current.status !== "current" || historical.status !== "current") {
      return unavailable();
    }
    const maximum = Math.min(input.maximumCandidates, 256);
    const currentCandidates = current.candidates;
    const historicalCandidates = historical.candidates;
    const candidates = interleave(currentCandidates, historicalCandidates, maximum);
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

function interleave(current: readonly FocusedMemoryReference[],
  historical: readonly FocusedMemoryReference[], maximum: number):
readonly FocusedMemoryReference[] {
  const output: FocusedMemoryReference[] = [];
  const admitted = new Set<string>();
  for (let index = 0; output.length < maximum &&
      (index < current.length || index < historical.length); index += 1) {
    const local = current[index];
    const remote = historical[index];
    if (local !== undefined && admitCanonical(local, admitted)) {
      output.push(local);
    }
    if (remote !== undefined && output.length < maximum &&
      admitCanonical(remote, admitted)) {
      output.push(remote);
    }
  }
  return Object.freeze(output);
}

function admitCanonical(reference: FocusedMemoryReference, admitted: Set<string>): boolean {
  const key = [reference.meetingId, reference.transcriptId,
    reference.transcriptVersion, reference.turnId].join("\u0000");
  if (admitted.has(key)) {
    return false;
  }
  admitted.add(key);
  return true;
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
