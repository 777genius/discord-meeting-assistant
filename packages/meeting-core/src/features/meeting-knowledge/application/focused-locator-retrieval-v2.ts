import { admitsHistoricalRetrieval, DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  type TwoHourHistoricalRetrievalProfileV1 } from "../domain/historical-evidence.js";
import { compareRetrievalV2Utf8, retrievalV2ConsumerEvidenceByteLimit,
  type RetrievalBindingSnapshot } from
  "../domain/retrieval-admission.js";
import type { FocusedMemoryReference } from "../domain/grounding-plan.js";
import { buildHistoricalRoomTopology, HistoricalIndexPlanError,
  rehydrateHistoricalBlock } from "./historical-index-plan.js";
import { resolveRequestedSpeakerIds, type SpeakerAliasMapV1 } from
  "./speaker-alias-resolution.js";
import { boundedRetrievalQuery, relativeTimeFilter } from
  "./focused-locator-retrieval-v2-query.js";
import type { FocusedLocatorRetrievalV2Port,
  FocusedLocatorRetrievalV2Candidate,
  FocusedLocatorRetrievalV2ProviderBinding,
  FocusedLocatorRetrievalV2RequestSnapshot } from
  "./ports/focused-locator-retrieval-v2.js";
import type { HistoricalAuthorizationPort } from "./ports/historical-grounding.js";
import type { HistoricalOpaqueIdPort, LocallyRehydratedEvidenceBlockV1 } from
  "./ports/historical-memory.js";
import type { HistoricalEvidenceAuthority, HistoricalSyncStore } from
  "./ports/historical-state.js";
import type { CanonicalEvidenceTurnHashPort, FocusedMemoryRetrievalPort,
  FocusedMemoryRetrievalResult } from
  "./ports/final-reply.js";
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
      readonly speakerAliases?: SpeakerAliasMapV1;
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
    const topology = buildHistoricalRoomTopology(
      input.scopeId,
      input.roomId,
      this.dependencies.ids,
    );
    const query = boundedRetrievalQuery(input.question);
    if (query.length === 0) {
      return null;
    }
    const actorKeys = Object.freeze([...resolveRequestedSpeakerIds(
      input.question,
      this.dependencies.speakerAliases,
    )].toSorted(compareRetrievalV2Utf8));
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

interface HistoricalLocatorRetrievalV2Input {
  readonly authorizationPrincipalRef: string;
  readonly currentMeetingId: string;
  readonly request: FocusedLocatorRetrievalV2RequestSnapshot;
  readonly roomId: string;
  readonly scopeId: string;
  readonly signal?: AbortSignal;
}

export class HistoricalFocusedLocatorRetrievalV2 {
  public constructor(private readonly dependencies: {
    readonly authority: HistoricalEvidenceAuthority;
    readonly authorization: HistoricalAuthorizationPort;
    readonly ids: HistoricalOpaqueIdPort;
    readonly retrieval: FocusedLocatorRetrievalV2Port;
    readonly store: HistoricalSyncStore;
    readonly turnHashes: CanonicalEvidenceTurnHashPort;
  }, private readonly profile: TwoHourHistoricalRetrievalProfileV1 =
    DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE) {}

  public async retrieve(input: HistoricalLocatorRetrievalV2Input):
  Promise<FocusedMemoryRetrievalResult> {
    const topology = buildHistoricalRoomTopology(input.scopeId, input.roomId,
      this.dependencies.ids);
    if (input.request.scope.memoryScopeId !== topology.roomScopeExternalRef ||
      input.request.scope.spaceId !== topology.spaceSlug) {
      return unavailable();
    }
    const authorizationRequest = {
      authorizationPrincipalRef: input.authorizationPrincipalRef,
      roomId: input.roomId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      scopeId: input.scopeId,
    };
    const before = await this.dependencies.authorization.authorize(authorizationRequest);
    if (!before.authorized) {
      return unavailable();
    }
    const remote = await this.dependencies.retrieval.retrieve(
      input.request,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    if (remote.status !== "available" || remote.candidates.length < 1) {
      return unavailable();
    }
    if (!remote.candidates.every(isExactLocatorCandidate)) {
      return unavailable();
    }
    const locators = remote.candidates.map(({ locator }) => locator);
    if (new Set(locators).size !== locators.length) {
      return unavailable();
    }
    const references = await this.rehydrateLocators(input, locators);
    if (references === null) {
      return unavailable();
    }
    const after = await this.dependencies.authorization.authorize(authorizationRequest);
    if (!sameAuthorization(before, after) || references.length < 1) {
      return unavailable();
    }
    return Object.freeze({
      authorityGeneration: "historical-locator-retrieval-v2",
      candidates: references,
      schemaVersion: 1,
      status: "current",
    });
  }

  private async rehydrateLocators(
    input: HistoricalLocatorRetrievalV2Input,
    locators: readonly string[],
  ): Promise<readonly FocusedMemoryReference[] | null> {
    const records = await this.dependencies.store.findCurrentCandidates(
      input.scopeId,
      input.roomId,
      locators,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    if (records.length !== locators.length) {
      return null;
    }
    const recordsByLocator = new Map(records.map((record) => [
      record.plan.documents[record.ordinal]?.manifest.candidateLocator,
      record,
    ]));
    if (recordsByLocator.size !== locators.length) {
      return null;
    }
    const allowedSources = new Map(input.request.filters.sourceGenerations.map(
      (source) => [source.sourceKey, source.projectionGeneration],
    ));
    const references: FocusedMemoryReference[] = [];
    let evidenceBytes = 0;
    for (const locator of locators) {
      input.signal?.throwIfAborted();
      const record = recordsByLocator.get(locator);
      if (record === undefined ||
        record.binding.meetingId === input.currentMeetingId ||
        allowedSources.get(record.plan.topology.releaseRef) !==
          record.plan.topology.indexGeneration ||
        !await this.dependencies.store.isCurrentGeneration(
          record.binding,
          record.plan.topology.indexGeneration,
          input.signal === undefined ? {} : { signal: input.signal },
        )) {
        return null;
      }
      const meeting = await this.dependencies.authority.loadAcceptedFinalMeeting(
        record.binding,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (meeting === null || !admitsHistoricalRetrieval(meeting, this.profile)) {
        return null;
      }
      let block: LocallyRehydratedEvidenceBlockV1;
      try {
        block = rehydrateHistoricalBlock(meeting, record.plan, record.ordinal,
          this.dependencies.ids);
      } catch (error) {
        if (error instanceof HistoricalIndexPlanError) {
          return null;
        }
        throw error;
      }
      evidenceBytes += new TextEncoder().encode(
        block.turns.map(({ text }) => text).join("\n"),
      ).byteLength;
      if (evidenceBytes > input.request.budgets.evidenceByteLimit) {
        return null;
      }
      references.push(...block.turns.map((turn) => Object.freeze({
        historicalSource: Object.freeze({
          candidateLocator: block.candidateLocator,
          indexGeneration: block.indexGeneration,
          releaseId: block.binding.releaseId,
        }),
        meetingId: block.binding.meetingId,
        sourceEndCodePoint: turn.sourceEndCodePoint,
        sourceStartCodePoint: turn.sourceStartCodePoint,
        transcriptId: block.binding.transcriptId,
        transcriptVersion: block.binding.transcriptVersion,
        turnHash: this.dependencies.turnHashes.hash(turn),
        turnId: turn.turnId,
      })));
    }
    return Object.freeze(references);
  }

  public async reauthorizeRoom(input: {
    readonly authorizationPrincipalRef: string;
    readonly roomId: string;
    readonly scopeId: string;
  }): Promise<boolean> {
    return (await this.dependencies.authorization.authorize(input)).authorized;
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

function isExactLocatorCandidate(value: FocusedLocatorRetrievalV2Candidate): boolean {
  const keys = Object.keys(value).toSorted();
  return keys.length === 1 && keys[0] === "locator";
}

function sameAuthorization(left: Awaited<ReturnType<HistoricalAuthorizationPort["authorize"]>>,
  right: Awaited<ReturnType<HistoricalAuthorizationPort["authorize"]>>): boolean {
  return left.authorized && right.authorized &&
    left.authorizationDigest === right.authorizationDigest &&
    left.authorizationEpoch === right.authorizationEpoch &&
    left.policyVersion === right.policyVersion;
}

export function isPersistedRetrievalV2Binding(
  binding: RetrievalBindingSnapshot,
): binding is Extract<RetrievalBindingSnapshot,
  { readonly retrievalPath: "infinity_locator_v2" }> {
  return binding.retrievalPath === "infinity_locator_v2";
}
