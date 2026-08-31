import {
  admitsHistoricalRetrieval,
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  type TwoHourHistoricalRetrievalProfileV1,
} from "../domain/historical-evidence.js";
import type {
  FocusedMemoryReference,
  RehydratedEvidenceTurn,
} from "../domain/grounding-plan.js";
import { decodeFocusedLocatorCandidate, historicalRetrievalAuditsBindRequest } from
  "./ports/focused-retrieval-provenance.js";
import {
  buildHistoricalRoomTopology,
  rehydrateHistoricalBlock,
} from "./historical-index-plan.js";
import type {
  FocusedHistoricalEvidenceV2Result,
  FocusedHistoricalEvidenceV2UnavailableReason,
  FocusedLocatorRetrievalV2Candidate,
  FocusedLocatorRetrievalV2Port,
  FocusedLocatorRetrievalV2RequestSnapshot,
} from "./ports/focused-locator-retrieval-v2.js";
import type { HistoricalAuthorizationPort } from "./ports/historical-grounding.js";
import type {
  HistoricalOpaqueIdPort,
  LocallyRehydratedEvidenceBlockV1,
} from "./ports/historical-memory.js";
import type {
  HistoricalEvidenceAuthority,
  HistoricalRoomAuthoritySnapshotEntryV1,
  HistoricalRoomAuthoritySnapshotPort,
} from "./ports/historical-state.js";
import type {
  CanonicalEvidenceTurnHashPort,
  FocusedMemoryRetrievalResult,
} from "./ports/final-reply.js";

interface HistoricalLocatorRetrievalV2Input {
  readonly authorizationPrincipalRef: string;
  readonly currentMeetingId: string;
  readonly request: FocusedLocatorRetrievalV2RequestSnapshot;
  readonly roomId: string;
  readonly scopeId: string;
  readonly signal?: AbortSignal;
}
type HistoricalCandidateRecord = HistoricalRoomAuthoritySnapshotEntryV1 & {
  readonly ordinal: number;
};
type HydratedHistoricalEvidence = {
  readonly authorityGeneration: string;
  readonly references: readonly FocusedMemoryReference[];
  readonly status: "current";
  readonly turns: readonly RehydratedEvidenceTurn[];
} | {
  readonly authorityGeneration: string;
  readonly status: "empty";
} | {
  readonly reason: FocusedHistoricalEvidenceV2UnavailableReason;
  readonly status: "unavailable";
};
type RehydratedLocators = {
  readonly references: readonly FocusedMemoryReference[];
  readonly status: "current";
  readonly turns: readonly RehydratedEvidenceTurn[];
} | {
  readonly reason: FocusedHistoricalEvidenceV2UnavailableReason;
  readonly status: "unavailable";
};
type AdmittedHistoricalCandidates = {
  readonly candidates: readonly FocusedLocatorRetrievalV2Candidate[];
  readonly status: "current";
} | Extract<HydratedHistoricalEvidence, { readonly status: "unavailable" }>;

export class HistoricalFocusedLocatorRetrievalV2 {
  public constructor(private readonly dependencies: {
    readonly authorization: HistoricalAuthorizationPort;
    /** Ignored; retained only for source-compatible test construction. */
    readonly authority?: HistoricalEvidenceAuthority;
    /** Maps one canonical actor to every retained opaque retrieval key. */
    readonly actorKeysForSpeaker?: (speakerId: string) => readonly string[];
    readonly ids: HistoricalOpaqueIdPort;
    readonly retrieval: FocusedLocatorRetrievalV2Port;
    readonly servingAuthorized?: () => boolean;
    readonly snapshot?: HistoricalRoomAuthoritySnapshotPort;
    /** Test fixtures may retain the old property name. */
    readonly store?: HistoricalRoomAuthoritySnapshotPort;
    readonly turnHashes: CanonicalEvidenceTurnHashPort;
  }, private readonly profile: TwoHourHistoricalRetrievalProfileV1 =
    DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE) {}

  public async retrieve(input: HistoricalLocatorRetrievalV2Input):
  Promise<FocusedMemoryRetrievalResult> {
    const hydrated = await this.retrieveHydrated(input);
    return hydrated.status === "unavailable" ? unavailable() : Object.freeze({
      authorityGeneration: hydrated.authorityGeneration,
      candidates: hydrated.status === "empty" ? Object.freeze([]) : hydrated.references,
      schemaVersion: 1,
      status: "current",
    });
  }

  public async retrieveEvidence(
    input: HistoricalLocatorRetrievalV2Input,
  ): Promise<FocusedHistoricalEvidenceV2Result> {
    const hydrated = await this.retrieveHydrated(input);
    return hydrated.status === "unavailable"
      ? Object.freeze({ reason: hydrated.reason, status: "unavailable" })
      : hydrated.status === "empty"
        ? Object.freeze({ authorityGeneration: hydrated.authorityGeneration,
            status: "empty" })
      : Object.freeze({
          authorityGeneration: hydrated.authorityGeneration,
          status: "current",
          turns: hydrated.turns,
        });
  }

  private async retrieveHydrated(
    input: HistoricalLocatorRetrievalV2Input,
  ): Promise<HydratedHistoricalEvidence> {
    input.signal?.throwIfAborted();
    if (this.dependencies.servingAuthorized?.() === false) {
      return rejected("serving_not_authorized");
    }
    const topology = buildHistoricalRoomTopology(input.scopeId, input.roomId,
      this.dependencies.ids);
    if (input.request.scope.memoryScopeId !== topology.roomScopeExternalRef ||
      input.request.scope.spaceId !== topology.spaceSlug) {
      return rejected("scope_not_bound");
    }
    const authorizationRequest = {
      authorizationPrincipalRef: input.authorizationPrincipalRef,
      roomId: input.roomId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      scopeId: input.scopeId,
    };
    const before = await this.dependencies.authorization.authorize(authorizationRequest);
    if (!before.authorized) {
      return rejected("authorization_denied");
    }
    const admittedCandidates = await this.retrieveCandidates(input);
    if (admittedCandidates.status === "unavailable") {return admittedCandidates;}
    const candidates = admittedCandidates.candidates;
    const hydrated = await this.rehydrateLocators(input, candidates);
    if (hydrated.status === "unavailable") {
      return hydrated;
    }
    const after = await this.dependencies.authorization.authorize(authorizationRequest);
    const hydratedAudits = [...new Map(hydrated.references.map((reference) => [
      reference.historicalSource!.candidateLocator,
      Object.freeze({ locator: reference.historicalSource!.candidateLocator,
        retrievalProvenance: reference.retrievalAudit! }),
    ])).values()];
    if (!sameAuthorization(before, after)) {
      return rejected("authorization_changed");
    }
    if (candidates.length > 0 && hydrated.references.length < 1) {
      return rejected("canonical_evidence_unavailable");
    }
    if (hydrated.references.length > 0 &&
      !await historicalRetrievalAuditsBindRequest(hydratedAudits, input.request)) {
      return rejected("canonical_provenance_invalid");
    }
    const generationParts = [
      ...input.request.filters.sourceGenerations.flatMap(
        ({ sourceKey, projectionGeneration }) => [sourceKey, projectionGeneration],
      ),
      ...hydrated.references.flatMap(({ meetingId, turnId, turnHash }) => [
        meetingId,
        turnId,
        turnHash,
      ]),
    ];
    const authorityGeneration = `historical-locator-v2:${this.dependencies.ids.keyedId(
        "focused-historical-generation",
        generationParts,
      )}`;
    return hydrated.references.length === 0
      ? Object.freeze({ authorityGeneration, status: "empty" as const })
      : Object.freeze({
      authorityGeneration,
      references: hydrated.references,
      status: "current",
      turns: hydrated.turns,
    });
  }

  private async retrieveCandidates(
    input: HistoricalLocatorRetrievalV2Input,
  ): Promise<AdmittedHistoricalCandidates> {
    input.signal?.throwIfAborted();
    if (this.dependencies.servingAuthorized?.() === false) {
      return rejected("serving_not_authorized");
    }
    const remote = await this.dependencies.retrieval.retrieve(
      input.request, input.signal === undefined ? {} : { signal: input.signal });
    if (!availableRemoteWithinLimit(remote, input.request.budgets.resultLimit)) {
      return rejected("provider_result_unavailable");
    }
    const candidates = remote.candidates.map(decodeFocusedLocatorCandidate)
      .filter(isLocatorCandidate);
    if (remote.candidates.length > 0 && candidates.length < 1) {
      return rejected("provider_candidate_invalid");
    }
    if (candidates.length > 0 &&
      !await historicalRetrievalAuditsBindRequest(candidates, input.request)) {
      return rejected("retrieval_provenance_invalid");
    }
    return Object.freeze({ candidates: Object.freeze(candidates), status: "current" });
  }

  private async rehydrateLocators(
    input: HistoricalLocatorRetrievalV2Input,
    candidates: readonly FocusedLocatorRetrievalV2Candidate[],
  ): Promise<RehydratedLocators> {
    const snapshotPort = this.dependencies.snapshot ?? this.dependencies.store;
    if (snapshotPort === undefined) {return rejected("historical_authority_unavailable");}
    const snapshot = await snapshotPort.loadRoomAuthoritySnapshot({
      maximumSources: 100,
      pageSize: 25,
      roomId: input.roomId,
      scopeId: input.scopeId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (snapshot.status !== "current") {
      return rejected("historical_authority_unavailable");
    }
    const records = snapshot.entries;
    const recordsByLocator = new Map<string, readonly HistoricalCandidateRecord[]>();
    for (const record of records) {
      for (const document of record.plan.documents) {
        const locator = document.manifest.candidateLocator;
        const candidateRecord = Object.freeze({
          ...record,
          ordinal: document.manifest.ordinal,
        });
        recordsByLocator.set(locator, Object.freeze([
          ...(recordsByLocator.get(locator) ?? []), candidateRecord,
        ]));
      }
    }
    const allowedSources = new Map(input.request.filters.sourceGenerations.map(
      (source) => [source.sourceKey, source.projectionGeneration],
    ));
    const references: FocusedMemoryReference[] = [];
    const turns: RehydratedEvidenceTurn[] = [];
    const observedLocators = new Set<string>();
    let evidenceBytes = 0;
    for (const candidate of candidates) {
      input.signal?.throwIfAborted();
      if (observedLocators.has(candidate.locator)) {
        continue;
      }
      observedLocators.add(candidate.locator);
      const ownedRecords = recordsByLocator.get(candidate.locator);
      const record = ownedRecords?.length === 1 ? ownedRecords[0] : undefined;
      const block = record === undefined ? null : this.rehydrateCandidate(
        record, allowedSources,
      );
      if (block === null) {continue;}
      const turnsAfterHardFilters = this.applyCanonicalHardFilters(input, block.turns);
      if (turnsAfterHardFilters.length === 0) {continue;}
      const candidateBytes = new TextEncoder().encode(
        turnsAfterHardFilters.map(({ text }) => text).join("\n"),
      ).byteLength;
      const delimiterBytes = references.length === 0 ? 0 : 1;
      if (candidateBytes < 1 ||
        candidateBytes > input.request.budgets.evidenceByteLimit ||
        evidenceBytes + delimiterBytes + candidateBytes >
          input.request.budgets.evidenceByteLimit) {
        continue;
      }
      evidenceBytes += delimiterBytes + candidateBytes;
      references.push(...turnsAfterHardFilters.map((turn) => Object.freeze({
        historicalSource: Object.freeze({
          candidateLocator: block.candidateLocator,
          indexGeneration: block.indexGeneration,
          releaseId: block.binding.releaseId,
        }),
        meetingId: block.binding.meetingId,
        retrievalAudit: candidate.retrievalProvenance,
        sourceEndCodePoint: turn.sourceEndCodePoint,
        sourceStartCodePoint: turn.sourceStartCodePoint,
        transcriptId: block.binding.transcriptId,
        transcriptVersion: block.binding.transcriptVersion,
        turnHash: this.dependencies.turnHashes.hash(turn),
        turnId: turn.turnId,
      })));
      turns.push(...turnsAfterHardFilters.map((turn) => Object.freeze({
        ...turn,
        retrievalAudit: candidate.retrievalProvenance,
        source: Object.freeze({
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
        }),
        turnHash: this.dependencies.turnHashes.hash(turn),
      })));
    }
    return Object.freeze({
      references: Object.freeze(references),
      status: "current",
      turns: Object.freeze(turns),
    });
  }

  private applyCanonicalHardFilters(
    input: HistoricalLocatorRetrievalV2Input,
    turns: LocallyRehydratedEvidenceBlockV1["turns"],
  ): LocallyRehydratedEvidenceBlockV1["turns"] {
    const actorKeys = input.request.filters.actorKeys;
    const interval = input.request.filters.relativeTimeInterval;
    if (actorKeys.length > 0 && this.dependencies.actorKeysForSpeaker === undefined) {
      return Object.freeze([]);
    }
    const requestedActors = new Set(actorKeys);
    return Object.freeze(turns.filter((turn) => {
      const actorMatches = requestedActors.size === 0 ||
        this.dependencies.actorKeysForSpeaker!(turn.speakerId)
          .some((key) => requestedActors.has(key));
      const timeMatches = interval === null ||
        (turn.startMs < interval.endMs && turn.endMs > interval.startMs);
      return actorMatches && timeMatches;
    }));
  }

  private rehydrateCandidate(
    record: HistoricalCandidateRecord,
    allowedSources: ReadonlyMap<string, string>,
  ): LocallyRehydratedEvidenceBlockV1 | null {
    if (allowedSources.get(record.plan.topology.releaseRef) !==
      record.plan.topology.indexGeneration) {
      return null;
    }
    const meeting = record.acceptedMeeting;
    if (meeting === null || !admitsHistoricalRetrieval(meeting, this.profile)) {
      return null;
    }
    try {
      return rehydrateHistoricalBlock(
        meeting, record.plan, record.ordinal, this.dependencies.ids,
      );
    } catch {return null;}
  }

  public async reauthorizeRoom(input: {
    readonly authorizationPrincipalRef: string;
    readonly roomId: string;
    readonly scopeId: string;
  }): Promise<boolean> {
    return (await this.dependencies.authorization.authorize(input)).authorized;
  }
}

function availableRemoteWithinLimit(
  remote: Awaited<ReturnType<FocusedLocatorRetrievalV2Port["retrieve"]>>,
  resultLimit: number,
): remote is Extract<typeof remote, { readonly status: "available" }> {
  return remote.status === "available" && remote.candidates.length <= resultLimit;
}

function unavailable(): FocusedMemoryRetrievalResult {
  return Object.freeze({ schemaVersion: 1, status: "unavailable" });
}

function rejected(
  reason: FocusedHistoricalEvidenceV2UnavailableReason,
): Extract<FocusedHistoricalEvidenceV2Result, { readonly status: "unavailable" }> {
  return Object.freeze({ reason, status: "unavailable" });
}

function isLocatorCandidate(value: FocusedLocatorRetrievalV2Candidate | null):
value is FocusedLocatorRetrievalV2Candidate {
  return value !== null;
}

function sameAuthorization(
  left: Awaited<ReturnType<HistoricalAuthorizationPort["authorize"]>>,
  right: Awaited<ReturnType<HistoricalAuthorizationPort["authorize"]>>,
): boolean {
  return left.authorized && right.authorized &&
    left.authorizationDigest === right.authorizationDigest &&
    left.authorizationEpoch === right.authorizationEpoch &&
    left.policyVersion === right.policyVersion;
}
