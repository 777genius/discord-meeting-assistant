import {
  admitsHistoricalRetrieval,
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  type TwoHourHistoricalRetrievalProfileV1,
} from "../domain/historical-evidence.js";
import type {
  FocusedMemoryReference,
  RehydratedEvidenceTurn,
} from "../domain/grounding-plan.js";
import {
  buildHistoricalRoomTopology,
  HistoricalIndexPlanError,
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
      !remote.candidates.every(isExactLocatorCandidate)) {
      return null;
    }
    const locators = remote.candidates.map(({ locator }) => locator);
    if (new Set(locators).size !== locators.length) {
      return null;
    }
    const hydrated = await this.rehydrateLocators(input, locators);
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
    locators: readonly string[],
  ): Promise<{
    readonly references: readonly FocusedMemoryReference[];
    readonly turns: readonly RehydratedEvidenceTurn[];
  } | null> {
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
    const turns: RehydratedEvidenceTurn[] = [];
    let evidenceBytes = 0;
    for (const locator of locators) {
      input.signal?.throwIfAborted();
      const record = recordsByLocator.get(locator);
      if (record === undefined || record.binding.meetingId === input.currentMeetingId ||
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

function isExactLocatorCandidate(value: FocusedLocatorRetrievalV2Candidate): boolean {
  const keys = Object.keys(value).toSorted();
  return keys.length === 1 && keys[0] === "locator";
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
