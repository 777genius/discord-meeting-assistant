import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  assertSemanticQualityV4CorpusIntegrity,
  frozenSemanticQualityCorpusV4,
  type FrozenSemanticQualityCorpusV4,
} from "./semantic-quality-v4-corpus.js";
import { QUALIFICATION_PROVIDER_INPUT_CONTRACT, QUALIFICATION_THRESHOLDS } from
  "../src/quality-campaign/qualification-contract.js";

export const v4EvaluationBounds = Object.freeze({
  maximumEvidenceBytes: QUALIFICATION_PROVIDER_INPUT_CONTRACT.retrieval.evidenceByteLimit,
  maximumPromptBytes: QUALIFICATION_PROVIDER_INPUT_CONTRACT.answer.maximumInputUtf8Bytes,
  maximumRankedLocators: QUALIFICATION_PROVIDER_INPUT_CONTRACT.retrieval.resultLimit,
});

export const v4Thresholds = Object.freeze({
  abstentionPrecision: QUALIFICATION_THRESHOLDS.abstentionPrecision,
  abstentionRecall: QUALIFICATION_THRESHOLDS.abstentionRecall,
  citationEntailment: QUALIFICATION_THRESHOLDS.citationEntailment,
  citationMembership: QUALIFICATION_THRESHOLDS.citationMembership,
  claimPrecision: QUALIFICATION_THRESHOLDS.claimPrecision,
  crossScopeLeakageMaximum: QUALIFICATION_THRESHOLDS.crossScopeLeakageMaximum,
  finalAnswerRecall: QUALIFICATION_THRESHOLDS.completeQuestionRecallAt5,
  markerBlindRecallAt5: Object.freeze({ denominator: 25, numerator: 23 }),
  maximumMarkerBlindDegradation: Object.freeze({ denominator: 20, numerator: 1 }),
  maximumRetrievalLatencyP95Us: QUALIFICATION_THRESHOLDS.maximumRetrievalLatencyP95Us,
  mrrAt10: QUALIFICATION_THRESHOLDS.firstRelevantReciprocalRank,
  blockLocatorRecallAt5: QUALIFICATION_THRESHOLDS.locatorRecallAt5,
  completeQuestionRecallAt5: QUALIFICATION_THRESHOLDS.completeQuestionRecallAt5,
  speakerAccuracy: QUALIFICATION_THRESHOLDS.speakerTimeAccuracy,
  timeAccuracy: QUALIFICATION_THRESHOLDS.speakerTimeAccuracy,
  unsupportedFactualClaimsMaximum: QUALIFICATION_THRESHOLDS.unsupportedFactualClaimsMaximum,
  wholeTranscriptIncludedMaximum: 0,
});

export const v4ThresholdApplicability = Object.freeze({
  automated: Object.freeze(["overall", "en", "ru", "mixed"] as const),
  overall: Object.freeze(["overall", "en", "ru", "mixed"] as const),
  real: Object.freeze(["overall", "en", "ru"] as const),
  recallAt5MetricIds: Object.freeze(
    ["blockLocatorRecallAt5", "completeQuestionRecallAt5"] as const),
});

interface ComponentHashes {
  readonly automatedQuestionPatchesSha256: string;
  readonly automatedQuestionsSha256: string;
  readonly auxiliaryTurnsSha256: string;
  readonly factFamilyNegativesSha256: string;
  readonly humanReviewQuestionsSha256: string;
  readonly locatorAuthoritySha256: string;
  readonly manifestSchemaSha256: string;
  readonly primaryTurnOverridesSha256: string;
  readonly primaryTurnsSha256: string;
  readonly scopeTopologySha256: string;
}

const frozenComponentHashes: ComponentHashes = Object.freeze({
  automatedQuestionPatchesSha256:
    "348972b48bedb7ee2c7ae7d6c149f8783d90291df1d4b0b8814c4a80a0545130",
  automatedQuestionsSha256:
    "461ea0e31a6336cb2023bf1593552573f30640b6b6793f2274a6994e9dd429d9",
  auxiliaryTurnsSha256:
    "376c6af3cb2c8f5ab952f2a0bb54cbedd8cde0adc364873cc2d665146d4c5b47",
  factFamilyNegativesSha256:
    "be626b92a996b4191e4bf92b8109500db461da6aa8dc48423dbf0a48bf01fb39",
  humanReviewQuestionsSha256:
    "a8a2ee0782561c1aab2a2b7cb18430a6909bf4e52a4037e227402cc0593625b1",
  locatorAuthoritySha256:
    "e06c883f0282d8d0e77b128e6c45dbd1e96b179b773203c685ad4f776b304a11",
  manifestSchemaSha256:
  "b669846a24511df8ef7705913c5c8db17f1e165ae4977f76597fa16063267408",
  primaryTurnOverridesSha256:
    "b993ed9dc1fccb17547cea432ed23bc0aa6107b3a21abef48821505167235fe3",
  primaryTurnsSha256:
    "8b6fd9be477f0cc94593003d235c92b346da0adac69431548f6b73d6ab390cec",
  scopeTopologySha256:
    "b24ee4b758850af9067e2b2098b68ce4239d21df8a122d29fe0193a4c90fd292",
});
const frozenManifestSha256 =
  "e4ed7689cb399b0deeae0bcaf645afd336dbc9d9deccd0145c0dbb82a1a9dd17";
const frozenCorpusSha256 =
  "f6b78fa91d1763519c5d3189e1b38b4f54060e4eb22ee1ae1dcfa86cd7e740f0";
const frozenHumanQuestionSetSha256 =
  "a8a2ee0782561c1aab2a2b7cb18430a6909bf4e52a4037e227402cc0593625b1";
const frozenAutomatedQuestionSetSha256 =
  "465e81440b9be0b5d9321596ea1791307e93cba23f8cdfbd6c5a333c28a34c15";
const frozenThresholdProfileSha256 =
  "b39d24f57a99e86ff2ef30b8ef517cbc0146ebf43743d023bc6d562f63908390";

export interface SemanticQualityV4Manifest {
  readonly components: ComponentHashes;
  readonly corpus: {
    readonly corpusSha256: string;
    readonly primaryDurationMs: 8_418_500;
    readonly primaryTurnCount: 421;
    readonly sourceKind: "synthetic";
    readonly totalDurationMs: 10_658_500;
  };
  readonly evaluation: {
    readonly applicability: typeof v4ThresholdApplicability;
    readonly bounds: typeof v4EvaluationBounds;
    readonly reportedWithoutThreshold: readonly ["blockLocatorRecallAt10",
      "completeQuestionRecallAt10", "ndcgAt10"];
    readonly thresholdProfileSha256: string;
    readonly thresholds: typeof v4Thresholds;
  };
  readonly manifestSha256: string;
  readonly qualification: {
    readonly exactBindingRealRunsPresent: 0;
    readonly independentAnswerAdjudicationReceiptsPresent: 0;
    readonly independentQuestionReviewReceiptsPresent: 0;
    readonly requiredExactBindingRealRuns: 3;
    readonly requiredIndependentAnswerAdjudicationReceipts: 2;
    readonly requiredIndependentQuestionReviewReceipts: 2;
    readonly status: "unqualified";
  };
  readonly questionSets: {
    readonly automated: {
      readonly answerable: 100;
      readonly count: 200;
      readonly questionSetSha256: string;
      readonly unsupported: 100;
    };
    readonly humanReviewCandidates: {
      readonly answerable: 20;
      readonly count: 40;
      readonly locales: { readonly en: 12; readonly mixed: 16; readonly ru: 12 };
      readonly questionSetSha256: string;
      readonly reviewStatus: "unreviewed";
      readonly unsupported: 20;
    };
  };
  readonly schemaVersion: "meeting_knowledge.semantic_quality_manifest.v4";
}

export interface SemanticQualityV4ExactBinding {
  readonly answerModelConfigurationSha256: string;
  readonly automatedQuestionSetSha256: string;
  readonly capabilityFingerprintSha256: string;
  readonly corpusSha256: string;
  readonly embeddingProfileSha256: string;
  readonly humanQuestionSetSha256: string;
  readonly rootManifestSha256: string;
  readonly releaseRevision: string;
  readonly releaseTree: string;
  readonly runtimeRevision: string;
  readonly sdkPackageSha256: string;
  readonly serviceRevision: string;
  readonly tokenizerSha256: string;
  readonly thresholdProfileSha256: string;
}

export interface SemanticQualityV4BoundRun {
  readonly adjudicatedOutcomesSha256: string;
  readonly binding: SemanticQualityV4ExactBinding;
  readonly failedThresholdIds: readonly string[];
  readonly independentAnswerAdjudicationReceiptDigests: readonly string[];
  readonly repetition: number;
  readonly runResultSha256: string;
  readonly runKind: "provider_free_fixture" | "real_exact_binding";
}

export type V4QualificationBlocker =
  | "answer_adjudication_receipts"
  | "exact_binding_match"
  | "exact_binding_real_runs"
  | "independent_evidence_unverified"
  | "question_review_receipts"
  | "threshold_runs";

export interface V4QualificationReadiness {
  readonly blockers: readonly V4QualificationBlocker[];
  readonly status: "unqualified";
}

/** Canonical JSON sorts object keys, preserves array order, and rejects non-integer numbers. */
export function canonicalIntegerJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, "$"));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalIntegerJson(value), "utf8").digest("hex");
}

export function createSemanticQualityV4Manifest(
  corpus: FrozenSemanticQualityCorpusV4 = frozenSemanticQualityCorpusV4(),
): SemanticQualityV4Manifest {
  assertSemanticQualityV4CorpusIntegrity(corpus);
  const topology = Object.freeze([
    Object.freeze({ meetingId: corpus.primaryMeeting.binding.meetingId,
      role: "primary", roomId: corpus.primaryMeeting.binding.roomId,
      scopeId: corpus.primaryMeeting.binding.scopeId }),
    ...[...Map.groupBy(corpus.auxiliaryTurns, ({ meetingId }) => meetingId)].map(
      ([meetingId, turns]) => Object.freeze({ meetingId,
        role: topologyRole(meetingId),
        roomId: turns[0]?.roomId ?? "", scopeId: turns[0]?.scopeId ?? "" }),
    ),
  ]);
  const components = Object.freeze({
    automatedQuestionPatchesSha256:
      canonicalSha256(corpus.fixtureComponents.automatedQuestionPatches),
    automatedQuestionsSha256: canonicalSha256(corpus.automatedQuestions),
    auxiliaryTurnsSha256: canonicalSha256(corpus.auxiliaryTurns),
    factFamilyNegativesSha256: canonicalSha256(corpus.fixtureComponents.factFamilyNegatives),
    humanReviewQuestionsSha256: canonicalSha256(corpus.humanReviewQuestions),
    locatorAuthoritySha256: canonicalSha256({
      globalForbiddenLocatorIds: corpus.globalForbiddenLocatorIds,
      knownLocatorIds: corpus.knownLocatorIds,
    }),
    manifestSchemaSha256: canonicalSha256(JSON.parse(readFileSync(new URL(
      "./fixtures/meeting-memory-v4/manifest.schema.json",
      import.meta.url,
    ), "utf8")) as unknown),
    primaryTurnOverridesSha256: canonicalSha256(corpus.fixtureComponents.primaryTurnOverrides),
    primaryTurnsSha256: canonicalSha256(corpus.primaryMeeting.humanTurns),
    scopeTopologySha256: canonicalSha256(topology),
  });
  if (canonicalIntegerJson(components) !== canonicalIntegerJson(frozenComponentHashes)) {
    throw new Error("V4 frozen component digest mismatch");
  }
  const corpusSha256 = canonicalSha256({
    auxiliaryTurnsSha256: components.auxiliaryTurnsSha256,
    primaryTurnsSha256: components.primaryTurnsSha256,
    scopeTopologySha256: components.scopeTopologySha256,
  });
  const automatedQuestionSetSha256 = canonicalSha256({
    patchesSha256: components.automatedQuestionPatchesSha256,
    questionsSha256: components.automatedQuestionsSha256,
  });
  const humanQuestionSetSha256 = components.humanReviewQuestionsSha256;
  const thresholdProfileSha256 = canonicalSha256({ applicability: v4ThresholdApplicability,
    bounds: v4EvaluationBounds,
    reportedWithoutThreshold: ["blockLocatorRecallAt10", "completeQuestionRecallAt10", "ndcgAt10"],
    thresholds: v4Thresholds });
  const unsigned = Object.freeze({
    components,
    corpus: Object.freeze({ corpusSha256, primaryDurationMs: 8_418_500 as const,
      primaryTurnCount: 421 as const, sourceKind: "synthetic" as const,
      totalDurationMs: 10_658_500 as const }),
    evaluation: Object.freeze({ applicability: v4ThresholdApplicability,
      bounds: v4EvaluationBounds,
      reportedWithoutThreshold: Object.freeze(
        ["blockLocatorRecallAt10", "completeQuestionRecallAt10", "ndcgAt10"] as const,
      ),
      thresholdProfileSha256,
      thresholds: v4Thresholds }),
    qualification: Object.freeze({ exactBindingRealRunsPresent: 0 as const,
      independentAnswerAdjudicationReceiptsPresent: 0 as const,
      independentQuestionReviewReceiptsPresent: 0 as const,
      requiredExactBindingRealRuns: 3 as const,
      requiredIndependentAnswerAdjudicationReceipts: 2 as const,
      requiredIndependentQuestionReviewReceipts: 2 as const,
      status: "unqualified" as const }),
    questionSets: Object.freeze({
      automated: Object.freeze({ answerable: 100 as const, count: 200 as const,
        questionSetSha256: automatedQuestionSetSha256, unsupported: 100 as const }),
      humanReviewCandidates: Object.freeze({ answerable: 20 as const, count: 40 as const,
        locales: Object.freeze({ en: 12 as const, mixed: 16 as const, ru: 12 as const }),
        questionSetSha256: humanQuestionSetSha256, reviewStatus: "unreviewed" as const,
        unsupported: 20 as const }),
    }),
    schemaVersion: "meeting_knowledge.semantic_quality_manifest.v4" as const,
  });
  const manifestSha256 = canonicalSha256(unsigned);
  if (manifestSha256 !== frozenManifestSha256) {
    throw new Error("V4 frozen root manifest digest mismatch");
  }
  const manifest = Object.freeze({ ...unsigned, manifestSha256 });
  const committedManifest = JSON.parse(readFileSync(new URL(
    "./fixtures/meeting-memory-v4/manifest.v4.json",
    import.meta.url,
  ), "utf8")) as unknown;
  if (canonicalIntegerJson(committedManifest) !== canonicalIntegerJson(manifest)) {
    throw new Error("V4 committed root manifest does not match reconstructed fixture authority");
  }
  return manifest;
}

function topologyRole(meetingId: string): string {
  if (meetingId.includes("wrong-room")) {return "wrong_room";}
  if (meetingId.includes("wrong-scope")) {return "wrong_scope";}
  if (meetingId.includes("stale")) {return "same_room_stale";}
  if (meetingId.includes("contradictory")) {return "same_room_contradictory";}
  throw new Error(`unknown V4 auxiliary topology role ${meetingId}`);
}

export function assertSemanticQualityV4Manifest(
  expected: SemanticQualityV4Manifest,
  corpus: FrozenSemanticQualityCorpusV4,
): void {
  const actual = createSemanticQualityV4Manifest(corpus);
  if (canonicalIntegerJson(actual) !== canonicalIntegerJson(expected)) {
    throw new Error("V4 canonical manifest or component digest mismatch");
  }
}

/**
 * Checks structural completeness without authorizing production. Digest-shaped
 * evidence cannot establish authorship or a real run until a trusted signed
 * receipt verifier exists, so independent_evidence_unverified always blocks.
 */
export function evaluateV4QualificationReadiness(input: {
  readonly independentQuestionReviewReceiptDigests: readonly string[];
  readonly runs: readonly SemanticQualityV4BoundRun[];
}): V4QualificationReadiness {
  const blockers: V4QualificationBlocker[] = [];
  const realRuns = input.runs.filter(({ runKind }) => runKind === "real_exact_binding");
  const repetitions = new Set(realRuns.map(({ repetition }) => repetition));
  if (realRuns.length !== 3 || repetitions.size !== 3 ||
    ![1, 2, 3].every((value) => repetitions.has(value))) {
    blockers.push("exact_binding_real_runs");
  }
  if (realRuns.length > 0 && (new Set(realRuns.map(({ binding }) =>
    canonicalIntegerJson(binding))).size !== 1 ||
    realRuns.some(({ binding }) => !validExactBinding(binding)))) {
    blockers.push("exact_binding_match");
  }
  if (realRuns.length !== 3 || !validRunDigests(realRuns) ||
    realRuns.some(({ failedThresholdIds }) => failedThresholdIds.length > 0)) {
    blockers.push("threshold_runs");
  }
  if (!hasIndependentDigests(input.independentQuestionReviewReceiptDigests, 2)) {
    blockers.push("question_review_receipts");
  }
  if (realRuns.length !== 3 || realRuns.some(({ independentAnswerAdjudicationReceiptDigests }) =>
    !hasIndependentDigests(independentAnswerAdjudicationReceiptDigests, 2))) {
    blockers.push("answer_adjudication_receipts");
  }
  blockers.push("independent_evidence_unverified");
  return Object.freeze({ blockers: Object.freeze(blockers), status: "unqualified" });
}

function canonicalValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {return value;}
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {throw new Error(`${path} must be a safe integer`);}
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalValue(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).toSorted()) {
      const item = record[key];
      if (item === undefined) {throw new Error(`${path}.${key} cannot be undefined`);}
      output[key] = canonicalValue(item, `${path}.${key}`);
    }
    return output;
  }
  throw new Error(`${path} contains a non-canonical value`);
}

function hasIndependentDigests(values: readonly string[], minimum: number): boolean {
  return values.length >= minimum && new Set(values).size === values.length &&
    values.every((value) => /^[a-f0-9]{64}$/u.test(value));
}

function validExactBinding(binding: SemanticQualityV4ExactBinding): boolean {
  const digests = [binding.answerModelConfigurationSha256,
    binding.capabilityFingerprintSha256, binding.embeddingProfileSha256,
    binding.sdkPackageSha256, binding.tokenizerSha256];
  const revisions = [binding.releaseRevision, binding.releaseTree,
    binding.runtimeRevision, binding.serviceRevision];
  return binding.corpusSha256 === frozenCorpusSha256 &&
    binding.automatedQuestionSetSha256 === frozenAutomatedQuestionSetSha256 &&
    binding.humanQuestionSetSha256 === frozenHumanQuestionSetSha256 &&
    binding.rootManifestSha256 === frozenManifestSha256 &&
    binding.thresholdProfileSha256 === frozenThresholdProfileSha256 &&
    digests.every((value) => /^[a-f0-9]{64}$/u.test(value)) &&
    revisions.every((value) => /^[a-f0-9]{40}$/u.test(value));
}

function validRunDigests(runs: readonly SemanticQualityV4BoundRun[]): boolean {
  return runs.every(({ adjudicatedOutcomesSha256, runResultSha256 }) =>
    /^[a-f0-9]{64}$/u.test(adjudicatedOutcomesSha256) &&
    /^[a-f0-9]{64}$/u.test(runResultSha256) &&
    adjudicatedOutcomesSha256 !== runResultSha256);
}
