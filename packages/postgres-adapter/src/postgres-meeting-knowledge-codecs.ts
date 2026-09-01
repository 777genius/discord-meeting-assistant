import { createHash } from "node:crypto";
import { QuestionBinding, isLegacyQuestionBinding,
  type CanonicalEvidenceTurn,
  type FocusedMemoryReference,
  type GroundedAnswerCandidate,
  type GroundingPlan,
  type QuestionBindingSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";
import { z } from "zod";
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedText = z.string().trim().min(1).max(32_768),
  localeSchema = z.enum(["en", "mixed", "ru"]);
const historicalEvidenceSourceSchema = z.object({
  candidateLocator: z.string().trim().min(1).max(1_024), indexGeneration: z.string().trim().min(1).max(1_024),
  releaseId: z.string().trim().min(1).max(1_024) }).strict();
const retrievalContributionSchema = z.object({
  contributionScorePicos: z.number().int(), providerLaneId: boundedText.max(128),
  providerRank: z.number().int().positive(), queryId: boundedText.max(128),
  rawScoreKind: z.enum(["bm25", "distance", "relevance", "similarity"]).nullable(),
  rawScoreValue: z.number().nullable(),
}).strict();
const focusedRetrievalAuditSchema = z.object({
  contributions: z.array(retrievalContributionSchema).min(1).max(32), fusedScore: z.number(),
  laneIdentity: z.object({
    algorithmId: z.literal("canonical_local_exact_lexical_v1"), lane: z.literal("local_current"),
    profileFingerprint: sha256Schema,
    profileId: z.literal("meeting-knowledge.local-current.v2"),
  }).strict().or(z.object({
    capabilityFingerprint: sha256Schema, lane: z.literal("historical"),
    profileId: boundedText.max(256),
  }).strict()),
  locator: boundedText.max(1_024), providerRank: z.number().int().positive(),
  requestDigest: sha256Schema,
  responseDigest: sha256Schema }).strict();
export function canonicalFinalReplyTurns(snapshot: MeetingSnapshot):
readonly CanonicalEvidenceTurn[] {
  const transcript = snapshot.transcript;
  if (transcript === null) {return [];}
  return Object.freeze(transcript.turns.map((turn) => Object.freeze({
    endMs: turn.endMs, speakerId: turn.speakerId, startMs: turn.startMs,
    text: turn.text, turnId: turn.turnId,
  })).toSorted((left, right) =>
    left.startMs - right.startMs || left.endMs - right.endMs ||
    (left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0)
  ));
}
export function canonicalFinalReplyEvidenceHash(snapshot: MeetingSnapshot): string {
  if (snapshot.transcript === null) {
    throw new Error("final reply authority requires an accepted transcript");}
  return createHash("sha256").update(JSON.stringify({
    transcriptId: snapshot.transcript.transcriptId,
    turns: canonicalFinalReplyTurns(snapshot),
    version: snapshot.transcript.version,
  }), "utf8").digest("hex");
}
export const questionBindingBaseSchema = z.object({
  authorizationDigest: sha256Schema, authorizationPolicyVersion: boundedText,
  authorizationPrincipalRef: boundedText, botApplicationIdentity: boundedText,
  canonicalEvidenceHash: sha256Schema, deliveryContainerId: boundedText,
  expectedLocale: localeSchema, finalProjectionEpoch: boundedText,
  finalProjectionReceipt: boundedText,
  humanActorIds: z.array(boundedText).min(1).max(10_000),
  meetingId: boundedText,
  meetingRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  memoryGeneration: boundedText,
  policyVersion: boundedText, projectionTargetContainerId: boundedText,
  questionHash: sha256Schema,
  questionId: boundedText,
  requesterSubject: sha256Schema, roomId: boundedText, scopeId: boundedText,
  transcriptId: boundedText,
  transcriptVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const retrievalV2IntervalSchema = z.object({ endAt: z.string(),
  startAt: z.string() }).strict();
const retrievalV2RelativeIntervalSchema = z.object({ endMs: z.number(),
  startMs: z.number() }).strict();
const retrievalV2WeightedKeySchema = z.object({ key: z.string(),
  weightMicros: z.number() }).strict();
export const canonicalEvidenceFiltersSchema = z.object({ relativeTimeInterval:
    retrievalV2RelativeIntervalSchema.nullable(),
  requiresSpeakerMatch: z.boolean(),
  speakerIds: z.array(boundedText.max(256)).max(10_000) }).strict();
const localCurrentIdentitySchema = z.object({
  algorithmId: z.literal("canonical_local_exact_lexical_v1"),
  profileFingerprint: sha256Schema, profileId: z.literal("meeting-knowledge.local-current.v2"),
}).strict();
const compositeProfileSchema = z.object({
  candidatePolicy: z.literal("bounded_lane_round_robin_dedupe.v1"),
  interleavePolicy: z.literal("local_then_historical_per_rank.v1"),
  profileId: z.literal("meeting-knowledge.composite-retrieval.v1"),
}).strict();
export const retrievalV2RequestSchema = z.object({
  binding: z.object({
    capabilityFingerprint: z.string(),
    contractVersion: z.literal("context-retrieval.v2"),
    indexProfileDigest: z.string(),
    profileId: z.string(),
    rankingPolicy: z.literal("weighted_rrf_canonical_preferences.v1"),
    requiredProviderLanes: z.array(z.string()),
    serviceRevision: z.string(),
  }).strict(),
  budgets: z.object({
    candidateLimit: z.number(),
    deadlineMs: z.number(),
    evidenceByteLimit: z.number(),
    neighborRadius: z.literal(0),
    responseByteLimit: z.number(),
    resultLimit: z.number(),
  }).strict(),
  filters: z.object({
    actorKeys: z.array(z.string()),
    category: z.string().nullable(),
    documentKeys: z.array(z.string()),
    excludedSourceKeys: z.array(z.string()),
    kinds: z.array(z.string()),
    relativeTimeInterval: retrievalV2RelativeIntervalSchema.nullable(),
    sourceGenerations: z.array(z.object({
      projectionGeneration: z.string(),
      sourceKey: z.string(),
    }).strict()),
    tagsAll: z.array(z.string()),
    tagsAny: z.array(z.string()),
    tagsNone: z.array(z.string()),
    timeInterval: retrievalV2IntervalSchema.nullable(),
  }).strict(),
  queries: z.array(z.object({
    query: z.string(),
    queryId: z.string(),
    weightMicros: z.number().optional(),
  }).strict()),
  schemaVersion: z.literal(2),
  scope: z.object({
    memoryScopeId: z.string(),
    spaceId: z.string(),
    threadId: z.string().nullable().optional(),
  }).strict(),
  softPreferences: z.object({
    actorPreferences: z.array(retrievalV2WeightedKeySchema),
    relativeTimeInterval: retrievalV2RelativeIntervalSchema.nullable(),
    sourcePreferences: z.array(retrievalV2WeightedKeySchema),
    timeInterval: retrievalV2IntervalSchema.nullable(),
    timeWeightMicros: z.number().nullable(),
  }).strict(),
}).strict();

export const retrievalBindingSchema = z.object({
  canonicalEvidenceFilters: canonicalEvidenceFiltersSchema,
  cutoverEpoch: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u),
  localCurrentIdentity: localCurrentIdentitySchema,
  originalQuestion: boundedText.max(2_000),
  profileFingerprint: sha256Schema,
  provenanceSchemaVersion: z.literal(1),
  retrievalPath: z.enum([
    "canonical_local_exact_lexical_v1",
    "infinity_locator_v1",
    "legacy_downstream_v1",
  ]),
}).strict().or(z.object({
  canonicalEvidenceFilters: canonicalEvidenceFiltersSchema,
  compositeProfile: compositeProfileSchema,
  cutoverEpoch: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u),
  localCurrentIdentity: localCurrentIdentitySchema,
  originalQuestion: boundedText.max(2_000),
  profileFingerprint: sha256Schema,
  provenanceSchemaVersion: z.literal(1),
  request: retrievalV2RequestSchema,
  retrievalPath: z.literal("infinity_locator_v2"),
}).strict());

const legacyQuestionBindingSchema = questionBindingBaseSchema.strict();
const currentQuestionBindingSchema = questionBindingBaseSchema.extend({
  bindingProtocolVersion: z.literal(2),
  retrievalBinding: retrievalBindingSchema,
}).strict();
const questionBindingSchema = z.union([
  currentQuestionBindingSchema,
  legacyQuestionBindingSchema,
]);

export const groundingEvidenceSchema = z.object({
  endMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  evidenceId: boundedText,
  speakerId: boundedText,
  retrievalAudit: focusedRetrievalAuditSchema.optional(),
  source: z.object({
    historicalSource: historicalEvidenceSourceSchema.optional(),
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
  const start: unknown = reference.sourceStartCodePoint;
  const end: unknown = reference.sourceEndCodePoint;
  if (start === undefined && end === undefined) {
    return turn;
  }
  if (typeof start !== "number" || typeof end !== "number") {
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

export const groundingCoverageReductionSchema = z.object({
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
  return QuestionBinding.create(
    questionBindingSchema.parse(value) as unknown as QuestionBindingSnapshot,
  ).toSnapshot();
}

export function questionAdmissionBindingHash(
  binding: QuestionBindingSnapshot,
): string {
  const { authorizationPrincipalRef: _ephemeralPrincipal, ...dedupeBinding } = binding;
  return hashJson(canonicalQuestionBindingValue(dedupeBinding));
}

export function preCanonicalProtocol2QuestionAdmissionBindingHash(
  binding: QuestionBindingSnapshot,
): string | null {
  if (isLegacyQuestionBinding(binding)) {
    return null;
  }
  const { authorizationPrincipalRef: _ephemeralPrincipal, ...dedupeBinding } = binding;
  return hashJson(dedupeBinding);
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function canonicalQuestionBindingValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalQuestionBindingValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalQuestionBindingValue(nested)]),
  );
}

export function legacyQuestionAdmissionBindingHash(
  binding: QuestionBindingSnapshot,
): string | null {
  if (!isLegacyQuestionBinding(binding)) {
    return null;
  }
  const {
    authorizationPrincipalRef: _ephemeralPrincipal,
    deliveryContainerId: _deliveryContainerId,
    ...legacyDedupeBinding
  } = binding;
  return createHash("sha256")
    .update(JSON.stringify(legacyDedupeBinding), "utf8")
    .digest("hex");
}

export function questionAdmissionBindingHashMatches(
  binding: QuestionBindingSnapshot,
  storedHash: string,
): boolean {
  const preCanonicalProtocol2Hash =
    preCanonicalProtocol2QuestionAdmissionBindingHash(binding);
  const deliverylessLegacyHash = legacyQuestionAdmissionBindingHash(binding);
  return storedHash === questionAdmissionBindingHash(binding) ||
    (preCanonicalProtocol2Hash !== null && storedHash === preCanonicalProtocol2Hash) ||
    (deliverylessLegacyHash !== null && storedHash === deliverylessLegacyHash);
}

export function decodePersistedQuestionBinding(
  value: unknown,
  storedHash: string,
): QuestionBindingSnapshot {
  const binding = decodeQuestionBinding(value);
  if (!questionAdmissionBindingHashMatches(binding, storedHash)) {
    throw new Error("persisted question binding hash does not match its JSON authority");
  }
  return binding;
}

export function decodeGroundingPlan(
  value: unknown,
  _binding: QuestionBindingSnapshot,
  _questionText: string,
): GroundingPlan {
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
      ...(evidence.retrievalAudit === undefined ? {} : {
        retrievalAudit: {
          ...evidence.retrievalAudit,
          contributions: evidence.retrievalAudit.contributions.map((entry) => ({
            ...entry,
          })),
        },
      }),
      ...(evidence.source === undefined
        ? {}
        : {
            source: {
              ...(evidence.source.historicalSource === undefined
                ? {}
                : {
                    historicalSource: {
                      candidateLocator:
                        evidence.source.historicalSource.candidateLocator,
                      indexGeneration:
                        evidence.source.historicalSource.indexGeneration,
                      releaseId: evidence.source.historicalSource.releaseId,
                    },
                  }),
              meetingId: evidence.source.meetingId,
              ...(evidence.source.sourceEndCodePoint === undefined
                ? {}
                : {
                    sourceEndCodePoint: evidence.source.sourceEndCodePoint,
                    sourceStartCodePoint: evidence.source.sourceStartCodePoint!,
                  }),
              transcriptId: evidence.source.transcriptId,
              transcriptVersion: evidence.source.transcriptVersion,
            },
          }),
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
