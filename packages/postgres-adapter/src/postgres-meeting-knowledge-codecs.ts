import { createHash } from "node:crypto";

import type {
  CanonicalEvidenceTurn,
  FocusedMemoryReference,
  GroundedAnswerCandidate,
  GroundingPlan,
  QuestionBindingSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedText = z.string().trim().min(1).max(32_768);
const localeSchema = z.enum(["en", "mixed", "ru"]);

export function canonicalFinalReplyTurns(
  snapshot: MeetingSnapshot,
): readonly CanonicalEvidenceTurn[] {
  const transcript = snapshot.transcript;
  if (transcript === null) {
    return [];
  }
  return Object.freeze(transcript.turns.map((turn) => Object.freeze({
    endMs: turn.endMs,
    speakerId: turn.speakerId,
    startMs: turn.startMs,
    text: turn.text,
    turnId: turn.turnId,
  })).toSorted((left, right) =>
    left.startMs - right.startMs || left.endMs - right.endMs ||
    (left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0)
  ));
}

export function canonicalFinalReplyEvidenceHash(snapshot: MeetingSnapshot): string {
  if (snapshot.transcript === null) {
    throw new Error("final reply authority requires an accepted transcript");
  }
  return createHash("sha256").update(JSON.stringify({
    transcriptId: snapshot.transcript.transcriptId,
    turns: canonicalFinalReplyTurns(snapshot),
    version: snapshot.transcript.version,
  }), "utf8").digest("hex");
}

const questionBindingV1Schema = z.object({
  authorizationDigest: sha256Schema,
  authorizationPolicyVersion: boundedText,
  authorizationPrincipalRef: boundedText,
  botApplicationIdentity: boundedText,
  canonicalEvidenceHash: sha256Schema,
  deliveryContainerId: boundedText,
  expectedLocale: localeSchema,
  finalProjectionEpoch: boundedText,
  finalProjectionReceipt: boundedText,
  humanActorIds: z.array(boundedText).min(1).max(10_000),
  meetingId: boundedText,
  meetingRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  memoryGeneration: boundedText,
  policyVersion: boundedText,
  projectionTargetContainerId: boundedText,
  questionHash: sha256Schema,
  questionId: boundedText,
  requesterSubject: sha256Schema,
  roomId: boundedText,
  scopeId: boundedText,
  transcriptId: boundedText,
  transcriptVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const groundingEvidenceSchema = z.object({
  endMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  evidenceId: boundedText,
  speakerId: boundedText,
  source: z.object({
    meetingId: boundedText,
    sourceEndCodePoint: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    sourceStartCodePoint: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    transcriptId: boundedText,
    transcriptVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict().superRefine((source, context) => {
    const hasStart = source.sourceStartCodePoint !== undefined;
    const hasEnd = source.sourceEndCodePoint !== undefined;
    if (hasStart !== hasEnd || (hasStart && source.sourceEndCodePoint! <= source.sourceStartCodePoint!)) {
      context.addIssue({ code: "custom", message: "evidence source range is invalid" });
    }
  }).optional(),
  startMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  text: boundedText,
  turnHash: sha256Schema,
  turnId: boundedText,
}).strict();

export function canonicalFinalReplyTurnHash(turn: CanonicalEvidenceTurn): string {
  return createHash("sha256").update(JSON.stringify({
    endMs: turn.endMs,
    speakerId: turn.speakerId,
    startMs: turn.startMs,
    text: turn.text,
    turnId: turn.turnId,
  }), "utf8").digest("hex");
}

export function sliceReferencedTurn(
  turn: CanonicalEvidenceTurn,
  reference: FocusedMemoryReference,
): CanonicalEvidenceTurn | null {
  const hasStart = reference.sourceStartCodePoint !== undefined;
  const hasEnd = reference.sourceEndCodePoint !== undefined;
  if (hasStart !== hasEnd) {
    return null;
  }
  if (!hasStart) {
    return turn;
  }
  const start = reference.sourceStartCodePoint;
  const end = reference.sourceEndCodePoint;
  if (start === undefined || end === undefined) {
    return null;
  }
  const codePoints = Array.from(turn.text);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || end <= start || end > codePoints.length) {
    return null;
  }
  return Object.freeze({ ...turn, text: codePoints.slice(start, end).join("") });
}

const coverageReductionValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string().max(32_768),
  z.array(z.string().max(32_768)).max(2_048),
]);

const groundingCoverageReductionSchema = z.object({
  evidenceBlockCount: z.number().int().nonnegative().max(10_000),
  payload: z.record(z.string().min(1).max(128), coverageReductionValueSchema),
  schemaVersion: z.literal(1),
  selectionStatus: z.enum(["no_match", "selected"]),
  selectedCanonicalTurnCount: z.number().int().nonnegative().max(256),
  selectedEvidenceBlockCount: z.number().int().nonnegative().max(256),
}).strict();

const groundingPlanV1Schema = z.object({
  authorityGeneration: boundedText,
  coverageBitmap: z.array(z.boolean()).max(10_000).optional(),
  coveragePlanDigest: boundedText.optional(),
  coverageReduction: groundingCoverageReductionSchema.optional(),
  evidence: z.array(groundingEvidenceSchema).max(256),
  mode: z.enum(["exhaustive_coverage", "focused_retrieval"]),
}).strict().superRefine((plan, context) => {
  const evidenceIds = new Set(plan.evidence.map(({ evidenceId }) => evidenceId));
  if (evidenceIds.size !== plan.evidence.length) {
    context.addIssue({
      code: "custom",
      message: "grounding evidence identities must be unique",
    });
  }
  if (plan.mode === "focused_retrieval" && plan.evidence.length === 0) {
    context.addIssue({
      code: "custom",
      message: "focused grounding evidence cannot be empty",
    });
  }
  if (
    (plan.mode === "exhaustive_coverage") !==
      (plan.coveragePlanDigest !== undefined) ||
    (plan.mode === "exhaustive_coverage") !==
      (plan.coverageReduction !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "exhaustive grounding plan digest is inconsistent with its mode",
    });
  }
  if (
    plan.coverageReduction !== undefined &&
    (plan.coverageBitmap === undefined ||
      plan.coverageReduction.evidenceBlockCount !== plan.coverageBitmap.length ||
      plan.coverageReduction.selectedCanonicalTurnCount !== plan.evidence.length ||
      (plan.coverageReduction.selectionStatus === "no_match") !==
        (plan.evidence.length === 0) ||
      plan.coverageReduction.selectedEvidenceBlockCount >
        plan.coverageReduction.evidenceBlockCount)
  ) {
    context.addIssue({
      code: "custom",
      message: "exhaustive grounding reduction does not bind the persisted plan",
    });
  }
});

const groundedClaimSchema = z.object({
  evidenceIds: z.array(boundedText).max(8),
  text: z.string().trim().min(1).max(600),
}).strict();

const groundedAnswerCandidateV1Schema = z.object({
  claims: z.array(groundedClaimSchema).max(12),
  locale: localeSchema,
  status: z.enum(["answered", "insufficient_evidence", "not_a_question"]),
}).strict();

export function decodeQuestionBinding(value: unknown): QuestionBindingSnapshot {
  return questionBindingV1Schema.parse(value);
}

export function decodeGroundingPlan(value: unknown): GroundingPlan {
  const parsed = groundingPlanV1Schema.parse(value);
  return {
    authorityGeneration: parsed.authorityGeneration,
    ...(parsed.coverageBitmap === undefined
      ? {}
      : { coverageBitmap: parsed.coverageBitmap }),
    ...(parsed.coveragePlanDigest === undefined
      ? {}
      : { coveragePlanDigest: parsed.coveragePlanDigest }),
    ...(parsed.coverageReduction === undefined
      ? {}
      : {
          coverageReduction: {
            evidenceBlockCount: parsed.coverageReduction.evidenceBlockCount,
            payload: parsed.coverageReduction.payload,
            schemaVersion: 1,
            selectionStatus: parsed.coverageReduction.selectionStatus,
            selectedCanonicalTurnCount:
              parsed.coverageReduction.selectedCanonicalTurnCount,
            selectedEvidenceBlockCount:
              parsed.coverageReduction.selectedEvidenceBlockCount,
          },
        }),
    evidence: parsed.evidence.map((evidence) => ({
      endMs: evidence.endMs,
      evidenceId: evidence.evidenceId,
      speakerId: evidence.speakerId,
      ...(evidence.source === undefined ? {} : { source: evidence.source }),
      startMs: evidence.startMs,
      text: evidence.text,
      turnHash: evidence.turnHash,
      turnId: evidence.turnId,
    })),
    mode: parsed.mode,
  };
}

export function decodeGroundedAnswerCandidate(value: unknown): GroundedAnswerCandidate {
  return groundedAnswerCandidateV1Schema.parse(value);
}
