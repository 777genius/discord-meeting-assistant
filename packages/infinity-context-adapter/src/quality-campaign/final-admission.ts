import { MAIN_CARDINALITY, type AdmissionAuthority, type CampaignQuestion,
  validateCampaignQuestion } from "./admission.js";
import { canonicalJson, digest, exactRecord, publicKeyFingerprintSha256,
  safeId, sha256 } from "./canonical.js";
import { assertAttemptIdentity, type AttemptIdentity, verifyExternalSignedValue } from "./execution.js";
import { type PinnedReleaseDocument, verifyPinnedReleaseDocument } from "./release.js";
import { type ArtifactCustodyPort, type ExpectedOutcomeInventory, type RetainedArtifact,
  verifyCampaignCreatedTargetInventory, verifyCleanupAbsenceReceipt,
  verifyExactRetentionInventory } from "./retention.js";

export interface SpeakerTimeCheck {
  readonly canonicalTurnId: string; readonly expectedSpeakerId: string;
  readonly expectedStartMs: number; readonly observedSpeakerId: string;
  readonly observedStartMs: number; readonly toleranceMs: number;
}

export interface CitationCheck {
  readonly citedTurnId: string; readonly claimId: string; readonly entailed: boolean;
}

export interface ClaimCheck {
  readonly claimId: string; readonly factual: boolean; readonly supported: boolean;
}

export interface QualificationOutcome extends ExpectedOutcomeInventory {
  readonly abstention: { readonly expected: boolean; readonly observed: boolean };
  readonly campaignRootSha256: string; readonly citationChecks: readonly CitationCheck[];
  readonly claimChecks: readonly ClaimCheck[]; readonly evidenceTurnIds: readonly string[];
  readonly locale: CampaignQuestion["locale"]; readonly rankedLocatorIds: readonly string[];
  readonly relevantLocatorIds: readonly string[]; readonly repetition: 1 | 2 | 3;
  readonly rootBindingSha256: string; readonly source: CampaignQuestion["source"];
  readonly speakerTimeChecks: readonly SpeakerTimeCheck[];
  readonly structurePassed: boolean;
}

export interface QualificationMetricGroup {
  readonly abstentionCheckCount: number; readonly abstentionPassedCount: number;
  readonly applicableOutcomeCount: number; readonly citationCheckCount: number;
  readonly citationPassedCount: number; readonly completeRecallAt5PassedCount: number;
  readonly factualClaimCount: number;
  readonly firstRelevantReciprocalRankMillionthsTotal: number;
  readonly group: "automatic" | "independent_review" | "locale:en" | "locale:mixed" |
    "locale:ru" | "overall";
  readonly relevantLocatorCount: number; readonly retrievedRelevantLocatorCountAt5: number;
  readonly speakerTimeCheckCount: number; readonly speakerTimePassedCount: number;
  readonly supportedFactualClaimCount: number;
  readonly thresholdPassed: boolean;
}

export interface RepetitionQualificationEvidence {
  readonly campaignRootSha256: string; readonly metrics: readonly QualificationMetricGroup[];
  readonly metricsSha256: string; readonly outcomes: readonly QualificationOutcome[];
  readonly outcomesSha256: string; readonly releaseRootSha256: string;
  readonly repetition: 1 | 2 | 3; readonly rootBindingSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_repetition_evidence.v3";
  readonly spendReservationSha256: string;
  readonly thresholdsPassed: boolean;
}

interface ExpectedRepetition {
  readonly authorizedLocatorIds: ReadonlySet<string>;
  readonly campaignRootSha256: string;
  readonly questions: readonly CampaignQuestion[];
  readonly releaseRootSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly rootBindingSha256: string;
  readonly spendReservationSha256: string;
}

export async function admitFinalCampaign(input: { readonly artifactCustody:
  ArtifactCustodyPort; readonly artifacts: readonly RetainedArtifact[];
  readonly authorizedLocatorIds: readonly string[]; readonly campaignByteCeiling: number;
  readonly campaignRootSha256: string; readonly cleanupAuthority: AdmissionAuthority;
  readonly cleanupReceipt: unknown; readonly questions: readonly CampaignQuestion[];
  readonly release: PinnedReleaseDocument; readonly repetitionAuthority: AdmissionAuthority;
  readonly repetitionEvidence: readonly unknown[]; readonly rootBindingSha256: string;
  readonly spendReservationSha256ByRepetition: readonly [string, string, string];
  readonly targetInventoryAuthority: AdmissionAuthority;
  readonly targetInventoryReceipt: unknown }): Promise<{
    readonly finalAdmissionSha256: string; readonly inventorySha256: string;
    readonly qualified: true }> {
  digest(input.campaignRootSha256, "final campaign root");
  const release = verifyPinnedReleaseDocument(input.release); const questions = validateExactQuestionSet(input.questions);
  const authorizedLocatorIds = decodeAuthorizedLocatorIds(input.authorizedLocatorIds);
  const spendReservations = input.spendReservationSha256ByRepetition.map((value) =>
    digest(value, "final spend reservation"));
  const rootBindingSha256 = sha256({ authorizedLocatorSetSha256: sha256(authorizedLocatorIds),
    campaignRootSha256: input.campaignRootSha256, questionSetSha256: sha256(questions),
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_final_root_binding.v2",
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
    const evidence = decodeRepetitionEvidence(receipt.payload, { authorizedLocatorIds:
      new Set(authorizedLocatorIds), campaignRootSha256: input.campaignRootSha256, questions,
      releaseRootSha256: release.releaseRootSha256,
      repetition: (index + 1) as 1 | 2 | 3, rootBindingSha256,
      spendReservationSha256: spendReservations[index]! });
    expectedOutcomes.push(...evidence.outcomes);
    return receipt;
  });
  const inventory = await verifyExactRetentionInventory({ artifacts: input.artifacts,
    artifactKeyCustodySha256: release.release.artifactKeyCustodySha256,
    campaignByteCeiling: input.campaignByteCeiling, custody: input.artifactCustody,
    expectedOutcomes });
  assertIndependentCleanupAuthorities(input.cleanupAuthority, input.targetInventoryAuthority);
  const targetInventory = verifyCampaignCreatedTargetInventory({ authority:
    input.targetInventoryAuthority, campaignRootSha256: input.campaignRootSha256,
    receipt: input.targetInventoryReceipt, releaseRootSha256: release.releaseRootSha256,
    targetInventoryAuthorityKeySha256: release.release.targetInventoryAuthorityKeySha256 });
  const cleanupReceipt = verifyCleanupAbsenceReceipt({ authorityKeyId:
    input.cleanupAuthority.keyId, authorityPublicKeyPem: input.cleanupAuthority.publicKeyPem,
    cleanupManifest: targetInventory.manifest, receipt: input.cleanupReceipt });
  const finalBinding = { campaignRootSha256: input.campaignRootSha256,
    cleanupManifestSha256: sha256(targetInventory.manifest), cleanupReceiptSha256:
    sha256(cleanupReceipt), inventorySha256: inventory.inventorySha256,
    outcomeCount: expectedOutcomes.length, releaseRootSha256: release.releaseRootSha256,
    repetitionEvidenceSetSha256: sha256(evidenceReceipts), rootBindingSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_final_admission.v3",
    targetInventoryReceiptSha256: sha256(targetInventory.receipt) };
  return Object.freeze({ finalAdmissionSha256: sha256(finalBinding),
    inventorySha256: inventory.inventorySha256, qualified: true });
}

function validateExactQuestionSet(input: readonly CampaignQuestion[]): readonly CampaignQuestion[] {
  const questions = input.map((question) => validateCampaignQuestion(question));
  const automatic = questions.filter(({ source }) => source === "automatic").length;
  const independentReview = questions.filter(({ source }) => source ===
    "independent_review").length;
  if (questions.length !== MAIN_CARDINALITY.perRepetition ||
    automatic !== MAIN_CARDINALITY.automatic ||
    independentReview !== MAIN_CARDINALITY.independentReview ||
    new Set(questions.map(({ questionId }) => questionId)).size !== questions.length ||
    new Set(questions.map(({ questionDigestSha256 }) => questionDigestSha256)).size !==
      questions.length) {
    throw new Error("final admission question set is not exactly 200 automatic and 40 independent review");
  }
  return Object.freeze(questions);
}

function decodeAuthorizedLocatorIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("authoritative locator inventory is empty");
  }
  const ids = value.map((id) => safeId(id, "authoritative locator ID"));
  if (new Set(ids).size !== ids.length) {
    throw new Error("authoritative locator inventory contains duplicates");
  }
  return Object.freeze(ids);
}

function decodeRepetitionEvidence(value: unknown,
  expected: ExpectedRepetition): RepetitionQualificationEvidence {
  const record = exactRecord(value, ["campaignRootSha256", "metrics", "metricsSha256",
    "outcomes", "outcomesSha256", "releaseRootSha256", "repetition", "rootBindingSha256",
    "schemaVersion", "spendReservationSha256", "thresholdsPassed"],
  "repetition qualification evidence payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_repetition_evidence.v3" ||
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
  const requiredGroups = ["automatic", "independent_review", "overall"];
  if (canonicalJson(record.metrics) !== canonicalJson(metrics) ||
    record.metricsSha256 !== sha256(metrics) || metrics.some(({ thresholdPassed }) =>
      !thresholdPassed) || requiredGroups.some((group) =>
      !metrics.some((metric) => metric.group === group))) {
    throw new Error("repetition thresholds do not reconstruct from actual outcomes");
  }
  return Object.freeze({ campaignRootSha256: expected.campaignRootSha256, metrics,
    metricsSha256: record.metricsSha256, outcomes, outcomesSha256: record.outcomesSha256,
    releaseRootSha256: expected.releaseRootSha256, repetition: expected.repetition,
    rootBindingSha256: expected.rootBindingSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_repetition_evidence.v3",
    spendReservationSha256: expected.spendReservationSha256, thresholdsPassed: true });
}

function decodeQualificationOutcome(value: unknown, expected: ExpectedRepetition,
  questionById: ReadonlyMap<string, CampaignQuestion>): QualificationOutcome {
  const record = exactRecord(value, ["abstention", "artifactBindingSha256ByKind",
    "campaignRootSha256", "citationChecks", "claimChecks", "evidenceTurnIds",
    "finalAdjudicationSha256", "identity", "locale", "rankedLocatorIds",
    "relevantLocatorIds", "repetition", "resolverRequired", "rootBindingSha256", "source",
    "speakerTimeChecks", "structurePassed"], "qualification outcome");
  const identity = record.identity as AttemptIdentity;
  assertAttemptIdentity(identity, expected);
  const question = questionById.get(identity.questionId);
  assertOutcomeQuestionBinding(record, identity, expected, question);
  const rankedLocatorIds = decodeIdList(record.rankedLocatorIds, "ranked locator", 10, false);
  const relevantLocatorIds = decodeIdList(record.relevantLocatorIds, "relevant locator", 100, false);
  if ([...rankedLocatorIds, ...relevantLocatorIds].some((id) =>
    !expected.authorizedLocatorIds.has(id))) {
    throw new Error("qualification outcome contains a foreign locator ID");
  }
  const evidenceTurnIds = decodeIdList(record.evidenceTurnIds, "evidence turn", 256, false);
  const speakerTimeChecks = decodeSpeakerTimeChecks(record.speakerTimeChecks,
    new Set(evidenceTurnIds));
  const citationChecks = decodeCitationChecks(record.citationChecks, new Set(evidenceTurnIds));
  const claimChecks = decodeClaimChecks(record.claimChecks);
  const claimIds = new Set(claimChecks.map(({ claimId }) => claimId));
  if (citationChecks.some(({ claimId }) => !claimIds.has(claimId))) {
    throw new Error("citation check references a foreign claim ID");}
  const abstention = decodeAbstention(record.abstention);
  const factualClaimIds = claimChecks.filter(({ factual }) => factual)
    .map(({ claimId }) => claimId).toSorted();
  if (!abstention.expected && factualClaimIds.length === 0 || canonicalJson(factualClaimIds) !==
    canonicalJson(citationChecks.map(({ claimId }) => claimId).toSorted())) {
    throw new Error("factual claims and actual citation checks are not exact");}
  digest(record.finalAdjudicationSha256, "final adjudication");
  if (typeof record.resolverRequired !== "boolean" ||
    typeof record.artifactBindingSha256ByKind !== "object" ||
    record.artifactBindingSha256ByKind === null || Array.isArray(record.artifactBindingSha256ByKind)) {
    throw new Error("qualification artifact inventory is invalid");
  }
  return Object.freeze({ abstention, artifactBindingSha256ByKind:
    record.artifactBindingSha256ByKind, campaignRootSha256: expected.campaignRootSha256,
  citationChecks, claimChecks, evidenceTurnIds,
  finalAdjudicationSha256: String(record.finalAdjudicationSha256), identity,
  locale: question.locale, rankedLocatorIds, relevantLocatorIds,
  repetition: expected.repetition, resolverRequired: record.resolverRequired,
  rootBindingSha256: expected.rootBindingSha256, source: question.source,
  speakerTimeChecks, structurePassed: true });
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

function decodeIdList(value: unknown, label: string, maximum: number,
  allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || !allowEmpty && value.length === 0) {
    throw new Error(`${label} inventory is not bounded`);
  }
  const ids = value.map((id) => safeId(id, `${label} ID`));
  if (new Set(ids).size !== ids.length) {throw new Error(`${label} inventory contains duplicates`);}
  return Object.freeze(ids);
}

function decodeSpeakerTimeChecks(value: unknown, evidenceTurnIds: ReadonlySet<string>):
readonly SpeakerTimeCheck[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error("speaker/time checks are not bounded");
  }
  const checks = value.map((check) => {
    const record = exactRecord(check, ["canonicalTurnId", "expectedSpeakerId", "expectedStartMs",
      "observedSpeakerId", "observedStartMs", "toleranceMs"], "speaker/time check");
    const numbers = [record.expectedStartMs, record.observedStartMs, record.toleranceMs];
    if (!numbers.every((number) => Number.isSafeInteger(number) && Number(number) >= 0) ||
      Number(record.toleranceMs) > 1_000) {
      throw new Error("speaker/time check values are invalid");
    }
    const canonicalTurnId = safeId(record.canonicalTurnId, "speaker/time turn ID");
    if (!evidenceTurnIds.has(canonicalTurnId)) {
      throw new Error("speaker/time check references a foreign turn ID");
    }
    return Object.freeze({ canonicalTurnId,
      expectedSpeakerId: safeId(record.expectedSpeakerId, "expected speaker ID"),
      expectedStartMs: Number(record.expectedStartMs),
      observedSpeakerId: safeId(record.observedSpeakerId, "observed speaker ID"),
      observedStartMs: Number(record.observedStartMs), toleranceMs: Number(record.toleranceMs) });
  });
  if (new Set(checks.map(({ canonicalTurnId }) => canonicalTurnId)).size !== checks.length) {
    throw new Error("speaker/time check membership is duplicated");
  }
  return Object.freeze(checks);
}

function decodeCitationChecks(value: unknown, evidenceTurnIds: ReadonlySet<string>):
readonly CitationCheck[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error("citation checks are not bounded");
  }
  const checks = value.map((check) => {
    const record = exactRecord(check, ["citedTurnId", "claimId", "entailed"], "citation check");
    const citedTurnId = safeId(record.citedTurnId, "cited turn ID");
    if (!evidenceTurnIds.has(citedTurnId) || typeof record.entailed !== "boolean") {
      throw new Error("citation check is foreign or invalid");
    }
    return Object.freeze({ citedTurnId, claimId: safeId(record.claimId, "cited claim ID"),
      entailed: record.entailed });
  });
  if (new Set(checks.map(({ claimId }) => claimId)).size !== checks.length) {
    throw new Error("citation check membership is duplicated");
  }
  return Object.freeze(checks);
}

function decodeClaimChecks(value: unknown): readonly ClaimCheck[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error("claim checks are not bounded");
  }
  const checks = value.map((check) => {
    const record = exactRecord(check, ["claimId", "factual", "supported"], "claim check");
    if (typeof record.factual !== "boolean" || typeof record.supported !== "boolean" ||
      record.supported && !record.factual) {throw new Error("claim check is invalid");}
    return Object.freeze({ claimId: safeId(record.claimId, "claim check ID"),
      factual: record.factual, supported: record.supported });
  });
  if (new Set(checks.map(({ claimId }) => claimId)).size !== checks.length) {
    throw new Error("claim check membership is duplicated");
  }
  return Object.freeze(checks);
}

function decodeAbstention(value: unknown): QualificationOutcome["abstention"] {
  const record = exactRecord(value, ["expected", "observed"], "abstention check");
  if (typeof record.expected !== "boolean" || typeof record.observed !== "boolean") {
    throw new Error("abstention check is invalid");
  }
  return Object.freeze({ expected: record.expected, observed: record.observed });
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
    const counters = applicable.reduce((total, outcome) => accumulateOutcome(total, outcome),
      emptyMetricCounters());
    const thresholdPassed = counters.completeRecallAt5PassedCount * 10 >=
      applicable.length * 9 && counters.retrievedRelevantLocatorCountAt5 * 10 >=
      counters.relevantLocatorCount * 9 &&
      counters.firstRelevantReciprocalRankMillionthsTotal * 10 >= applicable.length * 9_000_000 &&
      counters.citationPassedCount === counters.citationCheckCount &&
      counters.supportedFactualClaimCount * 10 >= counters.factualClaimCount * 9 &&
      counters.speakerTimePassedCount === counters.speakerTimeCheckCount &&
      counters.abstentionPassedCount === counters.abstentionCheckCount;
    return [Object.freeze({ ...counters, applicableOutcomeCount: applicable.length, group,
      thresholdPassed })];
  }));
}

function emptyMetricCounters(): Omit<QualificationMetricGroup, "applicableOutcomeCount" | "group" |
  "thresholdPassed"> {
  return { abstentionCheckCount: 0, abstentionPassedCount: 0, citationCheckCount: 0,
    citationPassedCount: 0, completeRecallAt5PassedCount: 0, factualClaimCount: 0,
    firstRelevantReciprocalRankMillionthsTotal: 0, relevantLocatorCount: 0,
    retrievedRelevantLocatorCountAt5: 0, speakerTimeCheckCount: 0,
    speakerTimePassedCount: 0, supportedFactualClaimCount: 0 };
}

function accumulateOutcome(total: ReturnType<typeof emptyMetricCounters>,
  outcome: QualificationOutcome): ReturnType<typeof emptyMetricCounters> {
  const relevant = new Set(outcome.relevantLocatorIds);
  const topFive = outcome.rankedLocatorIds.slice(0, 5);
  const retrievedRelevant = topFive.filter((id) => relevant.has(id)).length;
  const firstRelevantIndex = outcome.rankedLocatorIds.findIndex((id) => relevant.has(id));
  const complete = outcome.relevantLocatorIds.every((id) => topFive.includes(id));
  const speakerPassed = outcome.speakerTimeChecks.filter((check) =>
    check.expectedSpeakerId === check.observedSpeakerId &&
    Math.abs(check.expectedStartMs - check.observedStartMs) <= check.toleranceMs).length;
  const factualClaims = outcome.claimChecks.filter(({ factual }) => factual);
  return {
    abstentionCheckCount: total.abstentionCheckCount + 1,
    abstentionPassedCount: total.abstentionPassedCount +
      (outcome.abstention.expected === outcome.abstention.observed ? 1 : 0),
    citationCheckCount: total.citationCheckCount + outcome.citationChecks.length,
    citationPassedCount: total.citationPassedCount +
      outcome.citationChecks.filter(({ entailed }) => entailed).length,
    completeRecallAt5PassedCount: total.completeRecallAt5PassedCount + (complete ? 1 : 0),
    factualClaimCount: total.factualClaimCount + factualClaims.length,
    firstRelevantReciprocalRankMillionthsTotal:
      total.firstRelevantReciprocalRankMillionthsTotal + (firstRelevantIndex < 0 ? 0 :
        Math.floor(1_000_000 / (firstRelevantIndex + 1))),
    relevantLocatorCount: total.relevantLocatorCount + relevant.size,
    retrievedRelevantLocatorCountAt5: total.retrievedRelevantLocatorCountAt5 + retrievedRelevant,
    speakerTimeCheckCount: total.speakerTimeCheckCount + outcome.speakerTimeChecks.length,
    speakerTimePassedCount: total.speakerTimePassedCount + speakerPassed,
    supportedFactualClaimCount: total.supportedFactualClaimCount +
      factualClaims.filter(({ supported }) => supported).length,
  };
}

function assertIndependentCleanupAuthorities(cleanup: AdmissionAuthority,
  inventory: AdmissionAuthority): void {
  if (cleanup.keyId === inventory.keyId || publicKeyFingerprintSha256(cleanup.publicKeyPem,
    "cleanup authority") === publicKeyFingerprintSha256(inventory.publicKeyPem,
    "target inventory authority")) {
    throw new Error("cleanup absence and target inventory authorities are not independent");
  }
}
