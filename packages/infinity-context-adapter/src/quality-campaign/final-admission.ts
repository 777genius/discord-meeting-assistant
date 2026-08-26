/* oxlint-disable max-lines -- closed final-admission decoders stay co-located with the only API */
import { MAIN_CARDINALITY, type CampaignQuestion,
  validateCampaignQuestion } from "./admission.js";
import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { verifyCampaignCreatedTargetInventory, verifyCleanupAbsenceReceipt } from "./cleanup-evidence.js";
import { assertAttemptIdentity, type AttemptIdentity, verifyExternalSignedValue,
  verifySpendReservation } from "./execution.js";
import { type PinnedReleaseDocument, QualityCampaignAuthorityPolicy,
  verifyPinnedReleaseDocument } from "./release.js";
import { type CitationCheck, type ClaimCheck, type QualificationMetricGroup,
  type QualificationOutcome, reconstructMetrics, type SpeakerTimeCheck } from "./qualification-metrics.js";
import { type ArtifactCustodyPort, type ExpectedOutcomeInventory, type RetainedArtifact,
  verifyExactRetentionInventory } from "./retention.js";

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
  readonly relevanceByQuestionId: ReadonlyMap<string, GoldRelevanceEntry>;
  readonly releaseRootSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly rootBindingSha256: string;
  readonly spendReservationSha256: string;
}

export interface GoldRelevanceEntry extends CampaignQuestion {
  readonly campaignRootSha256: string;
  readonly expectedAbstention: boolean;
  readonly releaseRootSha256: string;
  readonly relevantLocatorIds: readonly string[];
}

interface AuthoritativeGoldRelevance {
  readonly campaignRootSha256: string;
  readonly entries: readonly GoldRelevanceEntry[];
  readonly releaseRootSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_gold_relevance.v1";
}

interface AuthoritativeLocatorInventory {
  readonly campaignRootSha256: string;
  readonly locatorIds: readonly string[];
  readonly releaseRootSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_locator_inventory.v1";
}

interface ReviewedMainQuestionSet {
  readonly campaignRootSha256: string;
  readonly goldRelevanceReceiptSha256: string;
  readonly questions: readonly CampaignQuestion[];
  readonly releaseRootSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_reviewed_main_questions.v2";
}

export async function admitFinalCampaign(policy: QualityCampaignAuthorityPolicy,
  input: { readonly artifactCustody:
  ArtifactCustodyPort; readonly artifacts: readonly RetainedArtifact[];
  readonly authorizedLocatorInventory: unknown; readonly campaignByteCeiling: number;
  readonly campaignRootSha256: string; readonly cleanupAuthorityKeyId: string;
  readonly cleanupReceipt: unknown;
  readonly goldRelevanceReceipt: unknown; readonly locatorAuthorityKeyId: string;
  readonly effectVerificationEpochMs: number;
  readonly questionReviewReceipts: readonly [unknown, unknown];
  readonly release: PinnedReleaseDocument; readonly repetitionAuthorityKeyId: string;
  readonly repetitionEvidence: readonly unknown[]; readonly rootBindingSha256: string;
  readonly spendReservationSha256ByRepetition: readonly [string, string, string];
  readonly spendReservationsByRepetition: readonly [unknown, unknown, unknown];
  readonly targetInventoryAuthorityKeyId: string;
  readonly targetInventoryReceipt: unknown }): Promise<{
    readonly finalAdmissionSha256: string; readonly inventorySha256: string;
    readonly qualified: true }> {
  digest(input.campaignRootSha256, "final campaign root");
  const release = verifyPinnedReleaseDocument(policy, input.release);
  const questions = verifyReviewedQuestionSet(policy, input.questionReviewReceipts,
    sha256(input.goldRelevanceReceipt), input.campaignRootSha256, release.releaseRootSha256);
  const authorizedLocatorIds = verifyAuthorizedLocatorInventory(policy,
    input.locatorAuthorityKeyId, input.authorizedLocatorInventory, input.campaignRootSha256,
    release.releaseRootSha256);
  const relevance = verifyGoldRelevance(policy, input.locatorAuthorityKeyId,
    input.goldRelevanceReceipt, questions, new Set(authorizedLocatorIds),
    input.campaignRootSha256, release.releaseRootSha256);
  const spendReservations = input.spendReservationSha256ByRepetition.map((value) =>
    digest(value, "final spend reservation"));
  const verifiedSpendReservations = input.spendReservationsByRepetition.map((reservation, index) => {
    const verified = verifySpendReservation(policy, { campaignRootSha256:
      input.campaignRootSha256, expectedRepetition: (index + 1) as 1 | 2 | 3,
    nowEpochMs: input.effectVerificationEpochMs, releaseRootSha256: release.releaseRootSha256,
    reservation });
    if (verified.spendReservationSha256 !== spendReservations[index]) {
      throw new Error("final spend reservation document differs from its bound digest");
    }
    return verified;
  });
  const rootBindingSha256 = sha256({ authorizedLocatorSetSha256: sha256(authorizedLocatorIds),
    campaignRootSha256: input.campaignRootSha256, questionSetSha256: sha256(questions),
    relevanceAuthoritySha256: sha256(relevance.entries),
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_final_root_binding.v3",
    spendReservationSetSha256: sha256(spendReservations) });
  if (input.rootBindingSha256 !== rootBindingSha256) {
    throw new Error("final admission root binding does not reconstruct");
  }
  if (input.repetitionEvidence.length !== MAIN_CARDINALITY.repetitions) {
    throw new Error("final admission requires three authenticated repetitions");
  }
  const expectedOutcomes: ExpectedOutcomeInventory[] = [];
  const evidenceReceipts = input.repetitionEvidence.map((unknownReceipt, index) => {
    const repetitionAuthority = policy.assertReference("repetition",
      input.repetitionAuthorityKeyId);
    const receipt = verifyExternalSignedValue<RepetitionQualificationEvidence>(unknownReceipt,
      repetitionAuthority.keyId, repetitionAuthority.publicKeyPem,
      "repetition qualification evidence");
    const evidence = decodeRepetitionEvidence(receipt.payload, { authorizedLocatorIds:
      new Set(authorizedLocatorIds), campaignRootSha256: input.campaignRootSha256, questions,
      relevanceByQuestionId: relevance.byQuestionId,
      releaseRootSha256: release.releaseRootSha256,
      repetition: (index + 1) as 1 | 2 | 3, rootBindingSha256,
      spendReservationSha256: spendReservations[index]! });
    expectedOutcomes.push(...evidence.outcomes);
    return receipt;
  });
  const inventory = await verifyExactRetentionInventory(policy, { artifacts: input.artifacts,
    artifactKeyCustodySha256: release.release.artifactKeyCustodySha256,
    campaignByteCeiling: input.campaignByteCeiling, custody: input.artifactCustody,
    effectVerificationEpochMs: input.effectVerificationEpochMs, expectedOutcomes,
    releaseDocumentSha256: sha256(input.release.document),
    spendReservations: verifiedSpendReservations });
  policy.assertReference("cleanup", input.cleanupAuthorityKeyId);
  const targetInventory = verifyCampaignCreatedTargetInventory(policy, { authorityKeyId:
    input.targetInventoryAuthorityKeyId, campaignRootSha256: input.campaignRootSha256,
    receipt: input.targetInventoryReceipt, releaseRootSha256: release.releaseRootSha256,
    targetInventoryAuthorityKeySha256: release.release.targetInventoryAuthorityKeySha256 });
  const cleanupReceipt = verifyCleanupAbsenceReceipt(policy, { authorityKeyId:
    input.cleanupAuthorityKeyId,
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

// All seven bindings are intentionally explicit authority inputs.
// oxlint-disable-next-line max-params
function verifyGoldRelevance(policy: QualityCampaignAuthorityPolicy, authorityKeyId: string,
  receiptValue: unknown, questions: readonly CampaignQuestion[],
  authorizedLocatorIds: ReadonlySet<string>, campaignRootSha256: string,
  releaseRootSha256: string): { readonly byQuestionId: ReadonlyMap<string, GoldRelevanceEntry>;
    readonly entries: readonly GoldRelevanceEntry[] } {
  const authority = policy.assertReference("locator", authorityKeyId);
  const receipt = verifyExternalSignedValue<AuthoritativeGoldRelevance>(receiptValue,
    authority.keyId, authority.publicKeyPem, "authoritative per-question gold relevance");
  const record = exactRecord(receipt.payload, ["campaignRootSha256", "entries",
    "releaseRootSha256", "schemaVersion"], "authoritative gold relevance payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_gold_relevance.v1" ||
    record.campaignRootSha256 !== campaignRootSha256 ||
    record.releaseRootSha256 !== releaseRootSha256 || !Array.isArray(record.entries) ||
    record.entries.length !== questions.length) {
    throw new Error("authoritative gold relevance is foreign or incomplete");
  }
  const entries = Object.freeze(record.entries.map((value, index) => {
    const entry = exactRecord(value, ["campaignRootSha256", "expectedAbstention", "locale",
      "questionDigestSha256", "questionId", "releaseRootSha256", "relevantLocatorIds",
      "rubricDigestSha256", "source"],
    "authoritative gold relevance entry");
    const question = questions[index]!;
    const relevantLocatorIds = decodeIdList(entry.relevantLocatorIds, "gold relevant locator",
      100, true);
    if (entry.campaignRootSha256 !== campaignRootSha256 ||
      entry.releaseRootSha256 !== releaseRootSha256 ||
      typeof entry.expectedAbstention !== "boolean" ||
      canonicalJson({ locale: entry.locale, questionDigestSha256: entry.questionDigestSha256,
        questionId: entry.questionId, rubricDigestSha256: entry.rubricDigestSha256,
        source: entry.source }) !== canonicalJson(question) ||
      relevantLocatorIds.some((id) => !authorizedLocatorIds.has(id)) ||
      (entry.expectedAbstention && relevantLocatorIds.length !== 0) ||
      (!entry.expectedAbstention && relevantLocatorIds.length === 0)) {
      throw new Error("authoritative gold relevance does not bind its exact question");
    }
    return Object.freeze({ ...question, campaignRootSha256,
      expectedAbstention: entry.expectedAbstention, releaseRootSha256, relevantLocatorIds });
  }));
  if (new Set(entries.map(({ questionId }) => questionId)).size !== questions.length ||
    new Set(entries.map(({ questionDigestSha256 }) => questionDigestSha256)).size !==
      questions.length) {
    throw new Error("authoritative gold relevance question membership is not exact");
  }
  return Object.freeze({ byQuestionId: new Map(entries.map((entry) =>
    [entry.questionId, entry] as const)), entries });
}

function verifyReviewedQuestionSet(policy: QualityCampaignAuthorityPolicy,
  receipts: readonly [unknown, unknown], goldRelevanceReceiptSha256: string,
  campaignRootSha256: string,
  releaseRootSha256: string): readonly CampaignQuestion[] {
  const roles = ["reviewer_1", "reviewer_2"] as const;
  const verified = receipts.map((receipt, index) => {
    const authority = policy.authority(roles[index]!);
    return verifyExternalSignedValue<ReviewedMainQuestionSet>(receipt, authority.keyId,
      authority.publicKeyPem, "reviewed main question set");
  });
  if (canonicalJson(verified[0]!.payload) !== canonicalJson(verified[1]!.payload)) {
    throw new Error("independent reviewers did not sign the same main question set");
  }
  const record = exactRecord(verified[0]!.payload, ["campaignRootSha256",
    "goldRelevanceReceiptSha256", "questions", "releaseRootSha256", "schemaVersion"],
  "reviewed main question set payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_reviewed_main_questions.v2" ||
    record.goldRelevanceReceiptSha256 !== goldRelevanceReceiptSha256 ||
    record.campaignRootSha256 !== campaignRootSha256 ||
    record.releaseRootSha256 !== releaseRootSha256 || !Array.isArray(record.questions)) {
    throw new Error("reviewed main question set is foreign");
  }
  return validateExactQuestionSet(record.questions as CampaignQuestion[]);
}

function verifyAuthorizedLocatorInventory(policy: QualityCampaignAuthorityPolicy,
  authorityKeyId: string, receiptValue: unknown, campaignRootSha256: string,
  releaseRootSha256: string): readonly string[] {
  const authority = policy.assertReference("locator", authorityKeyId);
  const receipt = verifyExternalSignedValue<AuthoritativeLocatorInventory>(receiptValue,
    authority.keyId, authority.publicKeyPem, "authoritative locator inventory");
  const record = exactRecord(receipt.payload, ["campaignRootSha256", "locatorIds",
    "releaseRootSha256", "schemaVersion"], "authoritative locator inventory payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_locator_inventory.v1" ||
    record.campaignRootSha256 !== campaignRootSha256 ||
    record.releaseRootSha256 !== releaseRootSha256) {
    throw new Error("authoritative locator inventory is foreign");
  }
  return decodeAuthorizedLocatorIds(record.locatorIds);
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
    "relevantLocatorIds", "repetition", "resolverRequired", "retrievalLatencyUs",
    "rootBindingSha256", "scopeViolationLocatorIds", "source", "speakerTimeChecks"],
  "qualification outcome");
  const identity = record.identity as AttemptIdentity;
  assertAttemptIdentity(identity, expected);
  const question = questionById.get(identity.questionId);
  assertOutcomeQuestionBinding(record, identity, expected, question);
  const relevance = expected.relevanceByQuestionId.get(identity.questionId);
  if (relevance === undefined) {throw new Error("question lacks authoritative gold relevance");}
  const rankedLocatorIds = decodeIdList(record.rankedLocatorIds, "ranked locator", 10, false);
  const relevantLocatorIds = decodeIdList(record.relevantLocatorIds, "relevant locator", 100, true);
  const scopeViolationLocatorIds = decodeIdList(record.scopeViolationLocatorIds,
    "scope violation locator", 100, true);
  if (!Number.isSafeInteger(record.retrievalLatencyUs) || Number(record.retrievalLatencyUs) < 0 ||
    Number(record.retrievalLatencyUs) > 60_000_000) {
    throw new Error("retrieval latency is invalid");
  }
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
  if (canonicalJson(relevantLocatorIds) !== canonicalJson(relevance.relevantLocatorIds) ||
    abstention.expected !== relevance.expectedAbstention) {
    throw new Error("qualification outcome relevance differs from signed per-question gold");
  }
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
  retrievalLatencyUs: Number(record.retrievalLatencyUs),
  repetition: expected.repetition, resolverRequired: record.resolverRequired,
  rootBindingSha256: expected.rootBindingSha256, scopeViolationLocatorIds,
  source: question.source, speakerTimeChecks });
}

function assertOutcomeQuestionBinding(record: Record<string, unknown>, identity: AttemptIdentity,
  expected: ExpectedRepetition, question: CampaignQuestion | undefined): asserts question is
CampaignQuestion {
  if (question === undefined || identity.callKind !== "answer" || identity.callOrdinal !== 0 ||
    identity.questionDigestSha256 !== question.questionDigestSha256 ||
    identity.repetition !== expected.repetition || record.repetition !== expected.repetition ||
    record.campaignRootSha256 !== expected.campaignRootSha256 ||
    record.rootBindingSha256 !== expected.rootBindingSha256 || record.locale !== question.locale ||
    record.source !== question.source) {
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
