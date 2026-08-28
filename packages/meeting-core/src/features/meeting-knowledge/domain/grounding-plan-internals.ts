import {
  MeetingKnowledgeInvariantError,
  requireKnowledgeInteger,
  requireKnowledgeText,
  requireSha256,
} from "./errors.js";
import type { GroundingPlan, RehydratedEvidenceTurn } from "./grounding-plan.js";
import { historicalEvidenceSourceKey } from "./historical-evidence-source.js";

function compareCanonicalTurns(
  left: RehydratedEvidenceTurn,
  right: RehydratedEvidenceTurn,
): number {
  const leftSource = canonicalSourceKey(left);
  const rightSource = canonicalSourceKey(right);
  return (leftSource < rightSource ? -1 : leftSource > rightSource ? 1 : 0) ||
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    (left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0) ||
    (left.source?.sourceStartCodePoint ?? -1) -
      (right.source?.sourceStartCodePoint ?? -1) ||
    (left.source?.sourceEndCodePoint ?? -1) -
      (right.source?.sourceEndCodePoint ?? -1);
}

function canonicalSourceKey(turn: RehydratedEvidenceTurn): string {
  const source = turn.source;
  return source === undefined
    ? "0:current"
    : [
        "1",
        historicalEvidenceSourceKey(source.historicalSource),
        source.meetingId,
        source.transcriptId,
        source.transcriptVersion,
      ].join("\u0000");
}

function normalizeEvidenceSource(
  source: NonNullable<RehydratedEvidenceTurn["source"]>,
): NonNullable<RehydratedEvidenceTurn["source"]> {
  const hasStart = source.sourceStartCodePoint !== undefined;
  const hasEnd = source.sourceEndCodePoint !== undefined;
  if (hasStart !== hasEnd) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_EVIDENCE",
      "historical evidence source range must be complete",
    );
  }
  const sourceStartCodePoint = hasStart
    ? requireKnowledgeInteger(source.sourceStartCodePoint, "evidence.sourceStartCodePoint")
    : undefined;
  const sourceEndCodePoint = hasEnd
    ? requireKnowledgeInteger(source.sourceEndCodePoint, "evidence.sourceEndCodePoint", 1)
    : undefined;
  if (
    sourceStartCodePoint !== undefined &&
    sourceEndCodePoint !== undefined &&
    sourceEndCodePoint <= sourceStartCodePoint
  ) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_EVIDENCE",
      "historical evidence source range is invalid",
    );
  }
  return Object.freeze({
    ...(source.historicalSource === undefined
      ? {}
      : {
          historicalSource: Object.freeze({
            candidateLocator: requireKnowledgeText(
              source.historicalSource.candidateLocator,
              "evidence.source.historicalSource.candidateLocator",
              1_024,
            ),
            indexGeneration: requireKnowledgeText(
              source.historicalSource.indexGeneration,
              "evidence.source.historicalSource.indexGeneration",
              1_024,
            ),
            releaseId: requireKnowledgeText(
              source.historicalSource.releaseId,
              "evidence.source.historicalSource.releaseId",
              1_024,
            ),
          }),
        }),
    meetingId: requireKnowledgeText(source.meetingId, "evidence.source.meetingId", 1_024),
    ...(sourceEndCodePoint === undefined
      ? {}
      : { sourceEndCodePoint, sourceStartCodePoint: sourceStartCodePoint! }),
    transcriptId: requireKnowledgeText(
      source.transcriptId,
      "evidence.source.transcriptId",
      1_024,
    ),
    transcriptVersion: requireKnowledgeInteger(
      source.transcriptVersion,
      "evidence.source.transcriptVersion",
      1,
    ),
  });
}

export function normalizeRehydratedTurns(
  turns: readonly RehydratedEvidenceTurn[],
  humanActorIds: readonly string[],
  allowEmpty = false,
): readonly RehydratedEvidenceTurn[] {
  const humanActors = new Set(
    humanActorIds.map((actorId) =>
      requireKnowledgeText(actorId, "humanActorIds", 256)
    ),
  );
  if (humanActors.size !== humanActorIds.length) {
    throw new MeetingKnowledgeInvariantError(
      "DUPLICATE_EVIDENCE",
      "human actor IDs must be unique",
    );
  }
  const normalized = turns.map((turn) => {
    const startMs = requireKnowledgeInteger(turn.startMs, "evidence.startMs");
    const endMs = requireKnowledgeInteger(turn.endMs, "evidence.endMs", 1);
    if (endMs <= startMs) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_EVIDENCE",
        "evidence endMs must be greater than startMs",
      );
    }
    const speakerId = requireKnowledgeText(
      turn.speakerId,
      "evidence.speakerId",
      256,
    );
    if (!humanActors.has(speakerId)) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_EVIDENCE",
        "focused evidence must belong to a positively identified human actor",
      );
    }
    return Object.freeze({
      endMs,
      speakerId,
      ...(turn.source === undefined
        ? {}
        : { source: normalizeEvidenceSource(turn.source) }),
      ...(turn.retrievalAudit === undefined
        ? {}
        : { retrievalAudit: normalizeRetrievalAudit(turn.retrievalAudit) }),
      startMs,
      text: requireKnowledgeText(turn.text, "evidence.text", 32_768),
      turnHash: requireSha256(turn.turnHash, "evidence.turnHash"),
      turnId: requireKnowledgeText(turn.turnId, "evidence.turnId", 256),
    });
  }).toSorted(compareCanonicalTurns);
  if (
    (!allowEmpty && normalized.length === 0) ||
    normalized.length > 256 ||
    new Set(normalized.map((turn) => [
      historicalEvidenceSourceKey(turn.source?.historicalSource),
      turn.source?.meetingId ?? "current",
      turn.source?.transcriptId ?? "current",
      turn.source?.transcriptVersion ?? 0,
      turn.turnId,
      turn.source?.sourceStartCodePoint ?? "whole",
      turn.source?.sourceEndCodePoint ?? "whole",
    ].join("\u0000"))).size !== normalized.length ||
    new Set(normalized.map((turn) => [
      historicalEvidenceSourceKey(turn.source?.historicalSource),
      turn.source?.meetingId ?? "current",
      turn.source?.transcriptId ?? "current",
      turn.source?.transcriptVersion ?? 0,
      turn.turnHash,
      turn.source?.sourceStartCodePoint ?? "whole",
      turn.source?.sourceEndCodePoint ?? "whole",
    ].join("\u0000"))).size !== normalized.length
  ) {
    throw new MeetingKnowledgeInvariantError(
      "DUPLICATE_EVIDENCE",
      "grounding evidence requires a qualified bounded set of unique turn identities",
    );
  }
  return Object.freeze(normalized);
}

function normalizeRetrievalAudit(
  audit: NonNullable<RehydratedEvidenceTurn["retrievalAudit"]>,
): NonNullable<RehydratedEvidenceTurn["retrievalAudit"]> {
  if (!Number.isFinite(audit.fusedScore) ||
    !Number.isSafeInteger(audit.providerRank) || audit.providerRank < 1 ||
    audit.contributions.length < 1 || audit.contributions.length > 32) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_EVIDENCE",
      "retrieval provenance is outside its bounded contract",
    );
  }
  return Object.freeze({
    capabilityFingerprint: requireSha256(
      audit.capabilityFingerprint,
      "evidence.retrievalAudit.capabilityFingerprint",
    ),
    contributions: Object.freeze(audit.contributions.map((contribution) =>
      Object.freeze({ ...contribution })
    )),
    fusedScore: audit.fusedScore,
    locator: requireKnowledgeText(audit.locator, "evidence.retrievalAudit.locator", 1_024),
    profileId: requireKnowledgeText(audit.profileId, "evidence.retrievalAudit.profileId", 256),
    providerRank: audit.providerRank,
    requestDigest: requireSha256(audit.requestDigest, "evidence.retrievalAudit.requestDigest"),
    responseDigest: requireSha256(audit.responseDigest, "evidence.retrievalAudit.responseDigest"),
  });
}

export function opaqueEvidenceId(index: number): string {
  return `evidence-${String(index + 1).padStart(6, "0")}`;
}

export function freezeGroundingPlan(input: GroundingPlan): GroundingPlan {
  return Object.freeze({
    authorityGeneration: input.authorityGeneration,
    ...(input.coverageBitmap === undefined
      ? {}
      : { coverageBitmap: Object.freeze([...input.coverageBitmap]) }),
    ...(input.coveragePlanDigest === undefined
      ? {}
      : { coveragePlanDigest: input.coveragePlanDigest }),
    ...(input.coverageReduction === undefined
      ? {}
      : {
          coverageReduction: Object.freeze({
            ...input.coverageReduction,
            payload: Object.freeze({ ...input.coverageReduction.payload }),
          }),
        }),
    evidence: Object.freeze(input.evidence.map((evidence) =>
      Object.freeze({ ...evidence })
    )),
    mode: input.mode,
  });
}
