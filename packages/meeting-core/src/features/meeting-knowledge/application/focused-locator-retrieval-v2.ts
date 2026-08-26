import { compareRetrievalV2Utf8, retrievalV2ConsumerEvidenceByteLimit,
  type RetrievalBindingSnapshot } from
  "../domain/retrieval-admission.js";
import type { FocusedMemoryReference } from
  "../domain/grounding-plan.js";
import { buildHistoricalRoomTopology } from "./historical-index-plan.js";
import { hasAmbiguousRequestedActorAlias, resolveRequestedActorKeys,
  type RetrievalActorAliasOwnerV1, type RetrievalActorReferenceAuthorityV1 } from
  "./speaker-alias-resolution.js";
import { boundedRetrievalQuery, redactRetrievalQueryIdentities, relativeTimeFilter } from
  "./focused-locator-retrieval-v2-query.js";
import type { FocusedHistoricalEvidenceV2Port,
  FocusedLocatorRetrievalV2ProviderBinding,
  FocusedLocatorRetrievalV2RequestSnapshot } from
  "./ports/focused-locator-retrieval-v2.js";
import type { HistoricalOpaqueIdPort } from
  "./ports/historical-memory.js";
import type { HistoricalSyncStore } from
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
  resultLimit: 8,
  version: "meeting-knowledge.locator-retrieval.v2",
});
export class PrepareFocusedLocatorRetrievalV2Request {
  public constructor(
    private readonly dependencies: {
      readonly ids: HistoricalOpaqueIdPort;
      readonly providerBinding: FocusedLocatorRetrievalV2ProviderBinding;
      readonly actorReferences?: RetrievalActorReferenceAuthorityV1;
      readonly servingAuthorized?: () => boolean;
      readonly speakerAliases?: readonly RetrievalActorAliasOwnerV1[];
      readonly store: HistoricalSyncStore;
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
  }): Promise<FocusedLocatorRetrievalV2RequestSnapshot | null> {
    input.signal?.throwIfAborted();
    if (this.dependencies.servingAuthorized?.() === false) {
      return null;
    }
    const aliases = this.dependencies.speakerAliases ?? [];
    if (hasAmbiguousRequestedActorAlias(input.question, aliases)) {
      return null;
    }
    const requestedActorKeys = new Set([
      ...resolveRequestedActorKeys(input.question, aliases),
      ...(this.dependencies.actorReferences?.actorKeysForQuestion(input.question) ?? []),
    ]);
    const plans = (await this.dependencies.store.listCurrentRoomPlans(
      input.scopeId,
      input.roomId,
      this.policy.maximumSources + 2,
      input.signal === undefined ? {} : { signal: input.signal },
    )).filter(({ binding }) => binding.meetingId !== input.currentMeetingId);
    if (plans.length < 1 || plans.length > this.policy.maximumSources) {
      return null;
    }
    for (const plan of plans) {
      if (!await this.dependencies.store.isCurrentGeneration(
        plan.binding,
        plan.plan.topology.indexGeneration,
        input.signal === undefined ? {} : { signal: input.signal },
      )) {
        return null;
      }
    }
    if (this.dependencies.servingAuthorized?.() === false) {
      return null;
    }
    const topology = buildHistoricalRoomTopology(
      input.scopeId,
      input.roomId,
      this.dependencies.ids,
    );
    const query = boundedRetrievalQuery(redactRetrievalQueryIdentities(
      input.question,
      aliases,
    ));
    if (query.length === 0) {
      return null;
    }
    const actorKeys = Object.freeze([...requestedActorKeys]
      .toSorted(compareRetrievalV2Utf8));
    const relativeTimeInterval = relativeTimeFilter(input.question);
    return Object.freeze({
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
    if (request === null) {
      return Object.freeze({ status: "unavailable" as const });
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
    const [current, historical] = await Promise.all([
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
    if (current.status !== "current" && current.status !== "low_coverage") {
      return current;
    }
    if (historical.status !== "current") {
      return historical;
    }
    const maximum = Math.min(input.maximumCandidates, 256);
    const currentCandidates = current.status === "current" ? current.candidates : [];
    const candidates = interleave(currentCandidates, historical.candidates, maximum);
    return candidates.length === 0 ? unavailable() : Object.freeze({
      authorityGeneration: current.status === "current"
        ? current.authorityGeneration
        : input.expectedAuthorityGeneration,
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
  for (let index = 0; output.length < maximum &&
      (index < current.length || index < historical.length); index += 1) {
    const local = current[index];
    const remote = historical[index];
    if (local !== undefined) {
      output.push(local);
    }
    if (remote !== undefined && output.length < maximum) {
      output.push(remote);
    }
  }
  return Object.freeze(output);
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
