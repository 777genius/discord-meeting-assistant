import {
  admitsHistoricalRetrieval,
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  type TwoHourHistoricalRetrievalProfileV1,
} from "../domain/historical-evidence.js";
import type {
  FocusedMemoryReference,
  FocusedRetrievalAudit,
  RehydratedEvidenceTurn,
} from "../domain/grounding-plan.js";
import {
  buildHistoricalRoomTopology,
  rehydrateHistoricalBlock,
} from "./historical-index-plan.js";
import type {
  FocusedHistoricalEvidenceV2Result,
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
  HistoricalSyncStore,
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
type HistoricalCandidateRecord = Awaited<
  ReturnType<HistoricalSyncStore["findCurrentCandidates"]>
>[number];

export class HistoricalFocusedLocatorRetrievalV2 {
  public constructor(private readonly dependencies: {
    readonly authority: HistoricalEvidenceAuthority;
    readonly authorization: HistoricalAuthorizationPort;
    readonly ids: HistoricalOpaqueIdPort;
    readonly retrieval: FocusedLocatorRetrievalV2Port;
    readonly servingAuthorized?: () => boolean;
    readonly store: HistoricalSyncStore;
    readonly turnHashes: CanonicalEvidenceTurnHashPort;
  }, private readonly profile: TwoHourHistoricalRetrievalProfileV1 =
    DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE) {}

  public async retrieve(input: HistoricalLocatorRetrievalV2Input):
  Promise<FocusedMemoryRetrievalResult> {
    const hydrated = await this.retrieveHydrated(input);
    return hydrated === null ? unavailable() : Object.freeze({
      authorityGeneration: hydrated.authorityGeneration,
      candidates: hydrated.references,
      schemaVersion: 1,
      status: "current",
    });
  }

  public async retrieveEvidence(
    input: HistoricalLocatorRetrievalV2Input,
  ): Promise<FocusedHistoricalEvidenceV2Result> {
    const hydrated = await this.retrieveHydrated(input);
    return hydrated === null
      ? Object.freeze({ status: "unavailable" })
      : Object.freeze({
          authorityGeneration: hydrated.authorityGeneration,
          status: "current",
          turns: hydrated.turns,
        });
  }

  private async retrieveHydrated(input: HistoricalLocatorRetrievalV2Input): Promise<{
    readonly authorityGeneration: string;
    readonly references: readonly FocusedMemoryReference[];
    readonly turns: readonly RehydratedEvidenceTurn[];
  } | null> {
    input.signal?.throwIfAborted();
    if (this.dependencies.servingAuthorized?.() === false) {
      return null;
    }
    const topology = buildHistoricalRoomTopology(input.scopeId, input.roomId,
      this.dependencies.ids);
    if (input.request.scope.memoryScopeId !== topology.roomScopeExternalRef ||
      input.request.scope.spaceId !== topology.spaceSlug) {
      return null;
    }
    const authorizationRequest = {
      authorizationPrincipalRef: input.authorizationPrincipalRef,
      roomId: input.roomId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      scopeId: input.scopeId,
    };
    const before = await this.dependencies.authorization.authorize(authorizationRequest);
    if (!before.authorized) {
      return null;
    }
    input.signal?.throwIfAborted();
    if (this.dependencies.servingAuthorized?.() === false) {
      return null;
    }
    const remote = await this.dependencies.retrieval.retrieve(
      input.request,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    if (remote.status !== "available" || remote.candidates.length < 1 ||
      remote.candidates.length > input.request.budgets.resultLimit) {
      return null;
    }
    const candidates = remote.candidates
      .map(decodeLocatorCandidate)
      .filter(isLocatorCandidate);
    if (candidates.length < 1) {
      return null;
    }
    const hydrated = await this.rehydrateLocators(input, candidates);
    if (hydrated === null) {
      return null;
    }
    const after = await this.dependencies.authorization.authorize(authorizationRequest);
    if (!sameAuthorization(before, after) || hydrated.references.length < 1) {
      return null;
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
    return Object.freeze({
      authorityGeneration: `historical-locator-v2:${this.dependencies.ids.keyedId(
        "focused-historical-generation",
        generationParts,
      )}`,
      references: hydrated.references,
      turns: hydrated.turns,
    });
  }

  private async rehydrateLocators(
    input: HistoricalLocatorRetrievalV2Input,
    candidates: readonly FocusedLocatorRetrievalV2Candidate[],
  ): Promise<{
    readonly references: readonly FocusedMemoryReference[];
    readonly turns: readonly RehydratedEvidenceTurn[];
  } | null> {
    const uniqueLocators = [...new Set(candidates.map(({ locator }) => locator))];
    const records = await this.dependencies.store.findCurrentCandidates(
      input.scopeId,
      input.roomId,
      uniqueLocators,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    const recordsByLocator = new Map<string, typeof records>();
    for (const record of records) {
      const locator = record.plan.documents[record.ordinal]?.manifest.candidateLocator;
      if (locator !== undefined) {
        recordsByLocator.set(locator, Object.freeze([
          ...(recordsByLocator.get(locator) ?? []), record,
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
      const block = record === undefined ? null : await this.rehydrateCandidate(
        input, record, allowedSources,
      );
      if (block === null) {continue;}
      const candidateBytes = new TextEncoder().encode(
        block.turns.map(({ text }) => text).join("\n"),
      ).byteLength;
      const delimiterBytes = references.length === 0 ? 0 : 1;
      if (candidateBytes < 1 ||
        candidateBytes > input.request.budgets.evidenceByteLimit ||
        evidenceBytes + delimiterBytes + candidateBytes >
          input.request.budgets.evidenceByteLimit) {
        continue;
      }
      evidenceBytes += delimiterBytes + candidateBytes;
      references.push(...block.turns.map((turn) => Object.freeze({
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
      turns.push(...block.turns.map((turn) => Object.freeze({
        ...turn,
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
      turns: Object.freeze(turns),
    });
  }

  private async rehydrateCandidate(
    input: HistoricalLocatorRetrievalV2Input,
    record: HistoricalCandidateRecord,
    allowedSources: ReadonlyMap<string, string>,
  ): Promise<LocallyRehydratedEvidenceBlockV1 | null> {
    if (allowedSources.get(record.plan.topology.releaseRef) !==
      record.plan.topology.indexGeneration) {
      return null;
    }
    try {
      const current = await this.dependencies.store.isCurrentGeneration(
        record.binding,
        record.plan.topology.indexGeneration,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (!current) {return null;}
      const meeting = await this.dependencies.authority.loadAcceptedFinalMeeting(
        record.binding,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (meeting === null || !admitsHistoricalRetrieval(meeting, this.profile)) {
        return null;
      }
      return rehydrateHistoricalBlock(
        meeting, record.plan, record.ordinal, this.dependencies.ids,
      );
    } catch {
      input.signal?.throwIfAborted();
      return null;
    }
  }

  public async reauthorizeRoom(input: {
    readonly authorizationPrincipalRef: string;
    readonly roomId: string;
    readonly scopeId: string;
  }): Promise<boolean> {
    return (await this.dependencies.authorization.authorize(input)).authorized;
  }
}

function unavailable(): FocusedMemoryRetrievalResult {
  return Object.freeze({ schemaVersion: 1, status: "unavailable" });
}

function decodeLocatorCandidate(value: FocusedLocatorRetrievalV2Candidate):
FocusedLocatorRetrievalV2Candidate | null {
  if (!exactKeys(value, ["locator", "retrievalProvenance"]) ||
    typeof value.locator !== "string" || value.locator.length < 1 ||
    value.locator.length > 1_024) {
    return null;
  }
  const provenance = decodeRetrievalAudit(value.retrievalProvenance);
  return provenance === null ? null : Object.freeze({
    locator: value.locator,
    retrievalProvenance: provenance,
  });
}

function decodeRetrievalAudit(value: FocusedRetrievalAudit): FocusedRetrievalAudit | null {
  if (typeof value !== "object" || value === null ||
    !exactKeys(value, ["contributions", "fusedScore", "providerRank"]) ||
    !finite(value.fusedScore) || !rank(value.providerRank) ||
    !Array.isArray(value.contributions) || value.contributions.length < 1 ||
    value.contributions.length > 32) {
    return null;
  }
  const contributions: Array<FocusedRetrievalAudit["contributions"][number]> = [];
  for (const contribution of value.contributions) {
    const decoded = decodeRetrievalContribution(contribution);
    if (decoded === null) {return null;}
    contributions.push(decoded);
  }
  return Object.freeze({
    contributions: Object.freeze(contributions),
    fusedScore: value.fusedScore,
    providerRank: value.providerRank,
  });
}

function decodeRetrievalContribution(
  contribution: FocusedRetrievalAudit["contributions"][number],
): FocusedRetrievalAudit["contributions"][number] | null {
  if (typeof contribution !== "object" || contribution === null ||
    !exactKeys(contribution, ["contributionScorePicos", "providerLaneId",
      "providerRank", "queryId", "rawScoreKind", "rawScoreValue"]) ||
    !Number.isSafeInteger(contribution.contributionScorePicos) ||
    !rank(contribution.providerRank) || !boundedAuditId(contribution.providerLaneId) ||
    !boundedAuditId(contribution.queryId) || !rawScoreKind(contribution.rawScoreKind) ||
    (contribution.rawScoreValue !== null && !finite(contribution.rawScoreValue))) {
    return null;
  }
  return Object.freeze({ ...contribution });
}

function boundedAuditId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  return keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index]);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function rank(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function rawScoreKind(value: unknown):
value is FocusedRetrievalAudit["contributions"][number]["rawScoreKind"] {
  return value === null || value === "bm25" || value === "distance" ||
    value === "relevance" || value === "similarity";
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
