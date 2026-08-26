import { canonicalJson, digest, exactRecord, sha256 } from "./canonical.js";
import { MAIN_CARDINALITY, type AdmissionAuthority, type CampaignQuestion,
  validateCampaignQuestion } from "./admission.js";
import { assertAttemptIdentity, type AttemptIdentity,
  verifyExternalSignedValue } from "./execution.js";
import { type ArtifactStoreVerificationPort, type CleanupManifest,
  type ExpectedOutcomeInventory, type RetainedArtifact, verifyCleanupAbsenceReceipt,
  verifyExactRetentionInventory } from "./retention.js";

export interface QualificationOutcome extends ExpectedOutcomeInventory {
  readonly campaignRootSha256: string;
  readonly completeQuestionRecallAt5: boolean;
  readonly finalAdjudicationSha256: string;
  readonly locale: CampaignQuestion["locale"];
  readonly relevantLocatorCount: number;
  readonly repetition: 1 | 2 | 3;
  readonly retrievedRelevantLocatorCountAt5: number;
  readonly rootBindingSha256: string;
  readonly source: CampaignQuestion["source"];
  readonly structurePassed: boolean;
}

export interface QualificationMetricGroup {
  readonly applicableOutcomeCount: number;
  readonly completePassedCount: number;
  readonly group: "automatic" | "independent_review" | "locale:en" | "locale:mixed" |
    "locale:ru" | "overall";
  readonly relevantLocatorCount: number;
  readonly retrievedRelevantLocatorCountAt5: number;
  readonly thresholdPassed: boolean;
}

export interface RepetitionQualificationEvidence {
  readonly campaignRootSha256: string;
  readonly metrics: readonly QualificationMetricGroup[];
  readonly metricsSha256: string;
  readonly outcomes: readonly QualificationOutcome[];
  readonly outcomesSha256: string;
  readonly releaseRootSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly rootBindingSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_repetition_evidence.v2";
  readonly spendReservationSha256: string;
  readonly thresholdsPassed: boolean;
}

interface ExpectedRepetition {
  readonly campaignRootSha256: string;
  readonly questions: readonly CampaignQuestion[];
  readonly releaseRootSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly rootBindingSha256: string;
  readonly spendReservationSha256: string;
}

export async function admitFinalCampaign(input: { readonly artifactStore:
  ArtifactStoreVerificationPort; readonly artifacts: readonly RetainedArtifact[];
  readonly campaignByteCeiling: number; readonly campaignRootSha256: string;
  readonly cleanupAuthority: AdmissionAuthority; readonly cleanupManifest: CleanupManifest;
  readonly cleanupReceipt: unknown; readonly questions: readonly CampaignQuestion[];
  readonly releaseRootSha256: string; readonly repetitionAuthority: AdmissionAuthority;
  readonly repetitionEvidence: readonly unknown[]; readonly rootBindingSha256: string;
  readonly spendReservationSha256ByRepetition: readonly [string, string, string] }): Promise<{
    readonly finalAdmissionSha256: string; readonly inventorySha256: string;
    readonly qualified: true }> {
  digest(input.campaignRootSha256, "final campaign root");
  digest(input.releaseRootSha256, "final release root");
  const questions = validateExactQuestionSet(input.questions);
  const spendReservations = input.spendReservationSha256ByRepetition.map((value) =>
    digest(value, "final spend reservation"));
  const rootBindingSha256 = sha256({ campaignRootSha256: input.campaignRootSha256,
    questionSetSha256: sha256(questions), releaseRootSha256: input.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_final_root_binding.v1",
    spendReservationSetSha256: sha256(spendReservations) });
  if (input.rootBindingSha256 !== rootBindingSha256) {
    throw new Error("final admission root binding does not reconstruct");
  }
  if (input.repetitionEvidence.length !== MAIN_CARDINALITY.repetitions) {
    throw new Error("final admission requires three authenticated repetitions");
  }
  const expectedOutcomes: ExpectedOutcomeInventory[] = [];
  const evidenceReceipts = input.repetitionEvidence.map((unknownReceipt, index) => {
    const receipt = verifyExternalSignedValue<RepetitionQualificationEvidence>(unknownReceipt,
      input.repetitionAuthority.keyId, input.repetitionAuthority.publicKeyPem,
      "repetition qualification evidence");
    const evidence = decodeRepetitionEvidence(receipt.payload, { campaignRootSha256:
      input.campaignRootSha256, questions, releaseRootSha256: input.releaseRootSha256,
      repetition: (index + 1) as 1 | 2 | 3, rootBindingSha256,
      spendReservationSha256: spendReservations[index]! });
    expectedOutcomes.push(...evidence.outcomes);
    return receipt;
  });
  const inventory = await verifyExactRetentionInventory({ artifacts: input.artifacts,
    campaignByteCeiling: input.campaignByteCeiling, expectedOutcomes,
    store: input.artifactStore });
  const cleanupReceipt = verifyCleanupAbsenceReceipt({ authorityKeyId:
    input.cleanupAuthority.keyId, authorityPublicKeyPem: input.cleanupAuthority.publicKeyPem,
    campaignRootSha256: input.campaignRootSha256, cleanupManifest: input.cleanupManifest,
    receipt: input.cleanupReceipt });
  const finalBinding = { campaignRootSha256: input.campaignRootSha256,
    cleanupManifestSha256: sha256(input.cleanupManifest), cleanupReceiptSha256:
    sha256(cleanupReceipt), inventorySha256: inventory.inventorySha256,
    outcomeCount: expectedOutcomes.length, releaseRootSha256: input.releaseRootSha256,
    repetitionEvidenceSetSha256: sha256(evidenceReceipts), rootBindingSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_final_admission.v2" };
  return Object.freeze({ finalAdmissionSha256: sha256(finalBinding),
    inventorySha256: inventory.inventorySha256, qualified: true });
}

function validateExactQuestionSet(input: readonly CampaignQuestion[]): readonly CampaignQuestion[] {
  const questions = input.map((question) => validateCampaignQuestion(question));
  if (questions.length !== MAIN_CARDINALITY.perRepetition ||
    new Set(questions.map(({ questionId }) => questionId)).size !== questions.length ||
    new Set(questions.map(({ questionDigestSha256 }) => questionDigestSha256)).size !==
      questions.length) {
    throw new Error("final admission question set is not exact");
  }
  return Object.freeze(questions);
}

function decodeRepetitionEvidence(value: unknown,
  expected: ExpectedRepetition): RepetitionQualificationEvidence {
  const record = exactRecord(value, ["campaignRootSha256", "metrics", "metricsSha256",
    "outcomes", "outcomesSha256", "releaseRootSha256", "repetition", "rootBindingSha256",
    "schemaVersion", "spendReservationSha256", "thresholdsPassed"],
  "repetition qualification evidence payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_repetition_evidence.v2" ||
    record.campaignRootSha256 !== expected.campaignRootSha256 ||
    record.releaseRootSha256 !== expected.releaseRootSha256 ||
    record.repetition !== expected.repetition ||
    record.rootBindingSha256 !== expected.rootBindingSha256 ||
    record.spendReservationSha256 !== expected.spendReservationSha256 ||
    record.thresholdsPassed !== true || !Array.isArray(record.outcomes) ||
    record.outcomes.length !== MAIN_CARDINALITY.perRepetition || !Array.isArray(record.metrics)) {
    throw new Error("repetition evidence binding or structure is invalid");
  }
  const questionById = new Map(expected.questions.map((question) =>
    [question.questionId, question] as const));
  const outcomes = Object.freeze(record.outcomes.map((outcome) =>
    decodeQualificationOutcome(outcome, expected, questionById)));
  if (new Set(outcomes.map(({ identity }) => identity.questionId)).size !== outcomes.length ||
    outcomes.some(({ identity }) => !questionById.has(identity.questionId)) ||
    record.outcomesSha256 !== sha256(outcomes)) {
    throw new Error("repetition outcomes are not the exact sealed 240 questions");
  }
  const metrics = reconstructMetrics(outcomes);
  if (canonicalJson(record.metrics) !== canonicalJson(metrics) ||
    record.metricsSha256 !== sha256(metrics) || metrics.some(({ thresholdPassed }) =>
      !thresholdPassed)) {
    throw new Error("repetition thresholds do not reconstruct from outcomes");
  }
  return Object.freeze({ campaignRootSha256: expected.campaignRootSha256, metrics,
    metricsSha256: record.metricsSha256, outcomes,
    outcomesSha256: record.outcomesSha256, releaseRootSha256:
    expected.releaseRootSha256, repetition: expected.repetition,
    rootBindingSha256: expected.rootBindingSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_repetition_evidence.v2",
    spendReservationSha256: expected.spendReservationSha256, thresholdsPassed: true });
}

function decodeQualificationOutcome(value: unknown, expected: ExpectedRepetition,
  questionById: ReadonlyMap<string, CampaignQuestion>): QualificationOutcome {
  const record = exactRecord(value, ["artifactBindingSha256ByKind", "campaignRootSha256",
    "completeQuestionRecallAt5", "finalAdjudicationSha256", "identity", "locale",
    "relevantLocatorCount", "repetition", "resolverRequired",
    "retrievedRelevantLocatorCountAt5", "rootBindingSha256", "source", "structurePassed"],
  "qualification outcome");
  const identity = record.identity as AttemptIdentity;
  assertAttemptIdentity(identity, expected);
  const question = questionById.get(identity.questionId);
  assertOutcomeQuestionBinding(record, identity, expected, question);
  const counts = decodeOutcomeCounts(record);
  const flags = decodeOutcomeFlags(record);
  digest(record.finalAdjudicationSha256, "final adjudication");
  if (typeof record.artifactBindingSha256ByKind !== "object" ||
    record.artifactBindingSha256ByKind === null || Array.isArray(record.artifactBindingSha256ByKind)) {
    throw new Error("qualification artifact inventory is invalid");
  }
  return Object.freeze({ artifactBindingSha256ByKind:
    record.artifactBindingSha256ByKind,
    campaignRootSha256: expected.campaignRootSha256,
    completeQuestionRecallAt5: flags.completeQuestionRecallAt5,
    finalAdjudicationSha256: String(record.finalAdjudicationSha256), identity,
    locale: question.locale, relevantLocatorCount: counts.relevantLocatorCount,
    repetition: expected.repetition, resolverRequired: flags.resolverRequired,
    retrievedRelevantLocatorCountAt5: counts.retrievedRelevantLocatorCountAt5,
    rootBindingSha256: expected.rootBindingSha256, source: question.source,
    structurePassed: true });
}

function assertOutcomeQuestionBinding(record: Record<string, unknown>, identity: AttemptIdentity,
  expected: ExpectedRepetition, question: CampaignQuestion | undefined): asserts question is
CampaignQuestion {
  if (question === undefined || identity.callKind !== "answer" || identity.callOrdinal !== 0 ||
    identity.questionDigestSha256 !== question.questionDigestSha256 ||
    identity.repetition !== expected.repetition || record.repetition !== expected.repetition ||
    record.campaignRootSha256 !== expected.campaignRootSha256 ||
    record.rootBindingSha256 !== expected.rootBindingSha256 || record.locale !== question.locale ||
    record.source !== question.source || record.structurePassed !== true) {
    throw new Error("qualification outcome does not reconstruct from authoritative inputs");
  }
}

function decodeOutcomeFlags(record: Record<string, unknown>): {
  readonly completeQuestionRecallAt5: boolean; readonly resolverRequired: boolean } {
  if (typeof record.completeQuestionRecallAt5 !== "boolean" ||
    typeof record.resolverRequired !== "boolean") {
    throw new Error("qualification outcome flags are invalid");
  }
  return { completeQuestionRecallAt5: record.completeQuestionRecallAt5,
    resolverRequired: record.resolverRequired };
}

function decodeOutcomeCounts(record: Record<string, unknown>): {
  readonly relevantLocatorCount: number; readonly retrievedRelevantLocatorCountAt5: number } {
  if (!Number.isSafeInteger(record.relevantLocatorCount) ||
    !Number.isSafeInteger(record.retrievedRelevantLocatorCountAt5) ||
    Number(record.relevantLocatorCount) < 1 || Number(record.retrievedRelevantLocatorCountAt5) < 0 ||
    Number(record.retrievedRelevantLocatorCountAt5) > Number(record.relevantLocatorCount)) {
    throw new Error("qualification outcome metric counts are invalid");
  }
  return { relevantLocatorCount: Number(record.relevantLocatorCount),
    retrievedRelevantLocatorCountAt5: Number(record.retrievedRelevantLocatorCountAt5) };
}

export function reconstructMetrics(outcomes: readonly QualificationOutcome[]):
readonly QualificationMetricGroup[] {
  const groups: readonly [QualificationMetricGroup["group"],
    (outcome: QualificationOutcome) => boolean][] = [
    ["overall", () => true], ["automatic", ({ source }) => source === "automatic"],
    ["independent_review", ({ source }) => source === "independent_review"],
    ["locale:en", ({ locale }) => locale === "en"],
    ["locale:mixed", ({ locale }) => locale === "mixed"],
    ["locale:ru", ({ locale }) => locale === "ru"],
  ];
  return Object.freeze(groups.flatMap(([group, includes]) => {
    const applicable = outcomes.filter(includes);
    if (applicable.length === 0) {return [];}
    const completePassedCount = applicable.filter(({ completeQuestionRecallAt5 }) =>
      completeQuestionRecallAt5).length;
    const relevantLocatorCount = applicable.reduce((total, outcome) =>
      total + outcome.relevantLocatorCount, 0);
    const retrievedRelevantLocatorCountAt5 = applicable.reduce((total, outcome) =>
      total + outcome.retrievedRelevantLocatorCountAt5, 0);
    const thresholdPassed = completePassedCount * 10 >= applicable.length * 9 &&
      retrievedRelevantLocatorCountAt5 * 10 >= relevantLocatorCount * 9;
    return [Object.freeze({ applicableOutcomeCount: applicable.length, completePassedCount,
      group, relevantLocatorCount, retrievedRelevantLocatorCountAt5, thresholdPassed })];
  }));
}
