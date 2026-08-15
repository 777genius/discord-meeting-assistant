import {
  MeetingKnowledgeInvariantError,
  requireKnowledgeInteger,
  requireKnowledgeText,
  requireSha256,
} from "./errors.js";
import type {
  CanonicalEvidenceTurn,
  GroundingPlan,
  RehydratedEvidenceTurn,
} from "./grounding-plan.js";

function compareCanonicalTurns(
  left: Pick<CanonicalEvidenceTurn, "endMs" | "startMs" | "turnId">,
  right: Pick<CanonicalEvidenceTurn, "endMs" | "startMs" | "turnId">,
): number {
  return left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    (left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0);
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
        : {
            source: Object.freeze({
              meetingId: requireKnowledgeText(
                turn.source.meetingId,
                "evidence.source.meetingId",
                1_024,
              ),
              transcriptId: requireKnowledgeText(
                turn.source.transcriptId,
                "evidence.source.transcriptId",
                1_024,
              ),
              transcriptVersion: requireKnowledgeInteger(
                turn.source.transcriptVersion,
                "evidence.source.transcriptVersion",
                1,
              ),
            }),
          }),
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
      turn.source?.meetingId ?? "current",
      turn.source?.transcriptId ?? "current",
      turn.source?.transcriptVersion ?? 0,
      turn.turnId,
    ].join("\u0000"))).size !== normalized.length ||
    new Set(normalized.map((turn) => [
      turn.source?.meetingId ?? "current",
      turn.source?.transcriptId ?? "current",
      turn.source?.transcriptVersion ?? 0,
      turn.turnHash,
    ].join("\u0000"))).size !== normalized.length
  ) {
    throw new MeetingKnowledgeInvariantError(
      "DUPLICATE_EVIDENCE",
      "grounding evidence requires a qualified bounded set of unique turn identities",
    );
  }
  return Object.freeze(normalized);
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
