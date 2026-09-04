/* oxlint-disable max-lines -- one closed evidence contract keeps main and holdout reconstruction identical */
import type { CampaignQuestion } from "./campaign-admission-policy.js";
import type { FinalAdjudicationEnvelope } from "./adjudication.js";
import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { admitCumulativeSpend, type CumulativeSpendLedgerPort } from "./cumulative-spend.js";
import { type AttemptIdentity, type VerifiedSpendReservation,
  verifyExternalSignedValue } from "./execution.js";
import type { PinnedReleaseDocument, QualityCampaignAuthorityPolicy,
  QualityCampaignRelease } from "./release.js";
import { assertTerminalChain } from "./production-evidence-terminals.js";
import { QUALIFICATION_PROVIDER_INPUT_CONTRACT, QUALIFICATION_THRESHOLDS } from
  "./qualification-contract.js";
import { calculateAbstentionStatistics } from "./qualification-metrics.js";
import { verifyExactRetentionInventory, type ArtifactCustodyPort,
  type RetainedArtifact, type RetainedArtifactKind } from "./retention.js";

export interface ExactOutcomeEvidence {
  readonly artifactBindingSha256ByKind:
    Readonly<Partial<Record<RetainedArtifactKind, string>>>;
  readonly answerAbstained: boolean;
  readonly attemptId: string;
  readonly campaignRootSha256: string;
  readonly citationLocatorDigests: readonly string[];
  readonly evidenceLocatorDigests: readonly string[];
  readonly evidenceTurnIds: readonly string[];
  readonly expectedAnswer: "answerable" | "abstain";
  readonly finalAdjudicationSha256: string;
  readonly forbiddenLocatorDigests: readonly string[];
  readonly identity: AttemptIdentity;
  readonly questionDigestSha256: string;
  readonly questionId: string;
  readonly rankedLocatorDigests: readonly string[];
  readonly relevantLocatorDigests: readonly string[];
  readonly repetition: 1 | 2 | 3;
  readonly retrievalLatencyUs: number;
  readonly scopeViolationLocatorIds: readonly string[];
  readonly speakerTimeChecks: readonly unknown[];
  readonly terminalChain: readonly ExactTerminalEvidence[];
}

export interface ExactTerminalEvidence {
  readonly attemptId: string;
  readonly callKind: "answer" | "capability" | "retrieval";
  readonly callOrdinal: number;
  readonly predecessorResultDigestSha256: string | null;
  readonly requestDigestSha256: string;
  readonly resultEnvelopeDigestSha256: string;
  readonly signedResult: unknown;
  readonly terminalDigestSha256: string;
}

/** Application-owned shape reconstructed by a scheduler adapter from retained exact bytes. */
export interface ScheduledExactOutcome {
  readonly answerAttemptId: string;
  readonly answerIdentity: AttemptIdentity;
  readonly terminalChain: readonly ExactTerminalEvidence[];
}

export interface ExactAdjudicationEvidence extends FinalAdjudicationEnvelope {
  readonly attemptId: string;
  readonly campaignRootSha256: string;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
}

export interface ExactCampaignEvidence {
  readonly adjudications: readonly ExactAdjudicationEvidence[];
  readonly artifacts: readonly RetainedArtifact[];
  readonly authorizedLocatorInventory: unknown;
  readonly authorizedLocatorIds: readonly string[];
  readonly campaignByteCeiling: number;
  readonly finalRootBindingSha256: string;
  readonly forbiddenLocatorReceipt: unknown;
  readonly goldRelevanceReceipt: unknown;
  readonly outcomes: readonly ExactOutcomeEvidence[];
  readonly questionReviewReceipts: readonly [unknown, unknown];
  readonly repetitionEvidence: readonly unknown[];
}

export interface LocallyComputedMetrics {
  readonly abstentionPrecision: Readonly<{ denominator: number; numerator: number }>;
  readonly abstentionRecall: Readonly<{ denominator: number; numerator: number }>;
  readonly citationEntailment: Readonly<{ denominator: number; numerator: number }>;
  readonly citationMembership: Readonly<{ denominator: number; numerator: number }>;
  readonly claimPrecision: Readonly<{ denominator: number; numerator: number }>;
  readonly completeQuestionRecallAt5: Readonly<{ denominator: number; numerator: number }>;
  readonly crossScopeLeakageCount: number;
  readonly outcomeCount: number;
  readonly repetition: 1 | 2 | 3;
  readonly retrievalLatencyP95Us: number;
  readonly unsupportedFactualClaims: number;
}

export function bindExactExecutionEvidence(evidence: ExactCampaignEvidence,
  executions: readonly ScheduledExactOutcome[]): ExactCampaignEvidence {
  const byAttempt = new Map(executions.map((value) => [value.answerAttemptId, value]));
  if (byAttempt.size !== executions.length || evidence.outcomes.length !== executions.length) {
    throw new Error("execution and final evidence membership differ");
  }
  const outcomes = evidence.outcomes.map((outcome) => {
    const execution = byAttempt.get(outcome.attemptId);
    if (execution === undefined || canonicalJson(outcome.terminalChain) !==
      canonicalJson(execution.terminalChain) || outcome.identity.attemptId !==
      execution.answerAttemptId || canonicalJson(outcome.identity) !==
      canonicalJson(execution.answerIdentity)) {
      throw new Error("final evidence is not the scheduler-produced exact terminal chain");
    }
    return Object.freeze({ ...outcome, identity: attemptIdentityFromChain(execution),
      terminalChain: execution.terminalChain });
  });
  return Object.freeze({ ...evidence, outcomes: Object.freeze(outcomes) });
}

function attemptIdentityFromChain(execution: ScheduledExactOutcome): AttemptIdentity {
  const answer = execution.terminalChain[2];
  if (answer === undefined || answer.callKind !== "answer" ||
    answer.attemptId !== execution.answerAttemptId) {
    throw new Error("scheduler terminal chain has no exact answer identity");
  }
  if (execution.answerIdentity.attemptId !== answer.attemptId) {
    throw new Error("scheduler answer identity differs from its terminal chain");
  }
  return execution.answerIdentity;
}

export interface ExactOutcomeAuthorityBindings {
  readonly forbiddenLocatorReceiptSha256: string;
  readonly goldRelevanceReceiptSha256: string;
  readonly locatorInventoryReceiptSha256: string;
}

export async function reconstructExactMainEvidence(input: {
  readonly authorityPolicy: QualityCampaignAuthorityPolicy;
  readonly artifactKeyCustodySha256: string; readonly custody: ArtifactCustodyPort;
  readonly campaignRootSha256: string;
  readonly evidence: ExactCampaignEvidence;
  readonly providerResultAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly questions: readonly CampaignQuestion[];
  readonly release: QualityCampaignRelease;
  readonly releaseRootSha256: string;
  readonly releaseDocumentSha256: string;
  readonly effectVerificationEpochMs: number;
  readonly spendReservations: readonly VerifiedSpendReservation[];
  readonly spendReservationSha256ByRepetition: Readonly<Record<1 | 2 | 3, string>>;
}): Promise<{ readonly inventorySha256: string; readonly metrics: readonly LocallyComputedMetrics[];
  readonly metricsSha256ByRepetition: Readonly<Record<1 | 2 | 3, string>> }> {
  const expected = ([1, 2, 3] as const).flatMap((repetition) => input.questions.map((question) => {
    const outcome = input.evidence.outcomes.find((candidate) =>
      candidate.questionId === question.questionId && candidate.repetition === repetition);
    if (outcome === undefined) {throw new Error("exact outcome identity is missing");}
    const attempt = outcome.identity;
    return { attempt, question };
  }));
  assertExactMembership(input.campaignRootSha256, expected, input.evidence.outcomes,
    input.evidence.adjudications);
  verifyExactOutcomeAuthorities(input.authorityPolicy, { campaignRootSha256:
    input.campaignRootSha256, evidence: input.evidence, questions: input.questions,
    releaseRootSha256: input.releaseRootSha256 });
  for (const outcome of input.evidence.outcomes) {
    const question = input.questions.find(({ questionId }) => questionId === outcome.questionId);
    if (question === undefined) {throw new Error("terminal chain question is foreign");}
    assertTerminalChain({ authority: input.providerResultAuthority, outcome, question,
      release: input.release,
      releaseRootSha256: input.releaseRootSha256, root: input.campaignRootSha256,
      spendReservationSha256: input.spendReservationSha256ByRepetition[outcome.repetition] });
  }
  const adjudicationByAttempt = new Map(input.evidence.adjudications.map((value) =>
    [value.attemptId, value]));
  const retained = await verifyExactRetentionInventory(input.authorityPolicy, {
    artifacts: input.evidence.artifacts,
    artifactKeyCustodySha256: input.artifactKeyCustodySha256,
    campaignByteCeiling: input.evidence.campaignByteCeiling,
    custody: input.custody, effectVerificationEpochMs: input.effectVerificationEpochMs,
    perRepetitionCardinality: 240,
    releaseDocumentSha256: input.releaseDocumentSha256,
    release: input.release,
    spendReservations: input.spendReservations, expectedOutcomes: expected.map(({ attempt }) => {
      const outcome = input.evidence.outcomes.find(({ identity }) =>
        identity.attemptId === attempt.attemptId)!;
      return { artifactBindingSha256ByKind: outcome.artifactBindingSha256ByKind,
        abstention: { expected: outcome.expectedAnswer === "abstain",
          observed: outcome.answerAbstained },
        citationChecks: adjudicationByAttempt.get(attempt.attemptId)!.decision.claims.map(
          ({ claimId, citationEntailed }) => ({ claimId, entailed: citationEntailed })),
        claimChecks: adjudicationByAttempt.get(attempt.attemptId)!.decision.claims.map(
          ({ claimFactual, claimId, claimSupported }) => ({ claimId, factual: claimFactual,
            supported: claimSupported })), evidenceTurnIds: outcome.evidenceTurnIds,
        finalAdjudicationSha256: outcome.finalAdjudicationSha256, identity: attempt,
        rankedLocatorIds: outcome.rankedLocatorDigests,
        relevantLocatorIds: outcome.relevantLocatorDigests,
      resolverRequired: adjudicationByAttempt.get(attempt.attemptId)?.resolverReceipt !==
        null, retrievalLatencyUs: outcome.retrievalLatencyUs,
        scopeViolationLocatorIds: outcome.scopeViolationLocatorIds,
        speakerTimeChecks: outcome.speakerTimeChecks, terminalChain: outcome.terminalChain }; }) });
  const metrics = ([1, 2, 3] as const).map((repetition) => computeMetrics({ adjudications:
    input.evidence.adjudications.filter((value) => value.repetition === repetition), outcomes:
    input.evidence.outcomes.filter((value) => value.repetition === repetition), repetition }));
  for (const value of metrics) {assertThresholds(value);}
  return Object.freeze({ inventorySha256: retained.inventorySha256, metrics,
    metricsSha256ByRepetition: Object.freeze({ 1: sha256(metrics[0]), 2: sha256(metrics[1]),
      3: sha256(metrics[2]) }) });
}

export async function reconstructExactHoldoutEvidence(input: {
  readonly authorityBindings: ExactOutcomeAuthorityBindings;
  readonly authorityPolicy: QualityCampaignAuthorityPolicy;
  readonly artifactKeyCustodySha256: string;
  readonly campaignRootSha256: string; readonly adjudications: readonly ExactAdjudicationEvidence[];
  readonly artifacts: readonly RetainedArtifact[];
  readonly campaignByteCeiling: number;
  readonly custody: ArtifactCustodyPort;
  readonly effectVerificationEpochMs: number;
  readonly forbiddenLocatorReceipt: unknown;
  readonly goldRelevanceReceipt: unknown;
  readonly authorizedLocatorIds: readonly string[];
  readonly authorizedLocatorInventory: unknown;
  readonly outcomes: readonly ExactOutcomeEvidence[];
  readonly providerResultAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly questions: readonly CampaignQuestion[]; readonly releaseRootSha256: string;
  readonly releaseDocument: PinnedReleaseDocument;
  readonly release: QualityCampaignRelease;
  readonly releaseDocumentSha256: string;
  readonly spendLedger: CumulativeSpendLedgerPort;
  readonly spendReservations: readonly VerifiedSpendReservation[];
  readonly spendReservationSha256ByRepetition: Readonly<Record<1 | 2 | 3, string>>;
  readonly keyNamespace: string;
}): Promise<{ readonly cumulativeSpendProofSha256: string; readonly inventorySha256: string;
  readonly metrics: readonly LocallyComputedMetrics[]; readonly metricsSha256: string }> {
  if (input.questions.length !== 30) {
    throw new Error("exact holdout evidence requires 3 x 30 questions");
  }
  if (sha256(input.releaseDocument.document) !== input.releaseDocumentSha256 ||
    input.releaseDocument.releaseRootSha256 !== input.releaseRootSha256) {
    throw new Error("holdout release document binding is foreign");
  }
  const expected = ([1, 2, 3] as const).flatMap((repetition) => input.questions.map((question) => {
    const outcome = input.outcomes.find((candidate) => candidate.questionId === question.questionId &&
      candidate.repetition === repetition);
    if (outcome === undefined) {throw new Error("exact holdout outcome identity is missing");}
    return { question, attempt: outcome.identity };
  }));
  assertExactMembership(input.campaignRootSha256, expected, input.outcomes,
    input.adjudications);
  const evidence = { adjudications: input.adjudications, artifacts: input.artifacts,
    authorizedLocatorIds: input.authorizedLocatorIds,
    authorizedLocatorInventory: input.authorizedLocatorInventory,
    campaignByteCeiling: input.campaignByteCeiling, finalRootBindingSha256: "",
    forbiddenLocatorReceipt: input.forbiddenLocatorReceipt,
    goldRelevanceReceipt: input.goldRelevanceReceipt, outcomes: input.outcomes,
    questionReviewReceipts: [] as unknown as readonly [unknown, unknown],
    repetitionEvidence: [] };
  assertAuthorityReceiptBindings(input.authorityBindings, evidence);
  verifyExactOutcomeAuthorities(input.authorityPolicy, { campaignRootSha256:
    input.campaignRootSha256, evidence, questions: input.questions,
    releaseRootSha256: input.releaseRootSha256 });
  for (const outcome of input.outcomes) {
    const question = input.questions.find(({ questionId }) => questionId === outcome.questionId)!;
    assertTerminalChain({ authority: input.providerResultAuthority, outcome, question,
      release: input.release,
      releaseRootSha256: input.releaseRootSha256, root: input.campaignRootSha256,
      spendReservationSha256: input.spendReservationSha256ByRepetition[outcome.repetition] });
  }
  const adjudicationByAttempt = new Map(input.adjudications.map((value) =>
    [value.attemptId, value] as const));
  const retained = await verifyExactRetentionInventory(input.authorityPolicy, {
    artifacts: input.artifacts, artifactKeyCustodySha256: input.artifactKeyCustodySha256,
    campaignByteCeiling: input.campaignByteCeiling, custody: input.custody,
    effectVerificationEpochMs: input.effectVerificationEpochMs,
    expectedOutcomes: expected.map(({ attempt }) => {
      const outcome = input.outcomes.find(({ identity }) => identity.attemptId ===
        attempt.attemptId)!;
      const adjudication = adjudicationByAttempt.get(attempt.attemptId)!;
      return { artifactBindingSha256ByKind: outcome.artifactBindingSha256ByKind,
        abstention: { expected: outcome.expectedAnswer === "abstain",
          observed: outcome.answerAbstained }, citationChecks: adjudication.decision.claims.map(
          ({ claimId, citationEntailed }) => ({ claimId, entailed: citationEntailed })),
        claimChecks: adjudication.decision.claims.map(({ claimFactual, claimId,
          claimSupported }) => ({ claimId, factual: claimFactual, supported: claimSupported })),
        evidenceTurnIds: outcome.evidenceTurnIds,
        finalAdjudicationSha256: outcome.finalAdjudicationSha256, identity: attempt,
        rankedLocatorIds: outcome.rankedLocatorDigests,
        relevantLocatorIds: outcome.relevantLocatorDigests,
        resolverRequired: adjudication.resolverReceipt !== null,
        retrievalLatencyUs: outcome.retrievalLatencyUs,
        scopeViolationLocatorIds: outcome.scopeViolationLocatorIds,
        speakerTimeChecks: outcome.speakerTimeChecks, terminalChain: outcome.terminalChain };
    }), perRepetitionCardinality: 30,
    keyNamespace: input.keyNamespace, providerResultAuthorityRole: "holdout_provider_result",
    release: input.release,
    releaseDocumentSha256: input.releaseDocumentSha256,
    spendReservations: input.spendReservations });
  const schedulerClaims = (await Promise.all(input.spendReservations.map(async (reservation) =>
    await input.spendLedger.loadAdmittedClaims(reservation)))).flat();
  const cumulativeSpend = admitCumulativeSpend({ claims:
    [...schedulerClaims, ...retained.reviewSpendClaims], expected: retained.expectedSpendClaims,
  reservations: input.spendReservations });
  const metrics = ([1, 2, 3] as const).map((repetition) => computeMetrics({ adjudications:
    input.adjudications.filter((value) => value.repetition === repetition), outcomes:
    input.outcomes.filter((value) => value.repetition === repetition), repetition }));
  for (const value of metrics) {assertThresholds(value);}
  return Object.freeze({ cumulativeSpendProofSha256: sha256(cumulativeSpend),
    inventorySha256: retained.inventorySha256, metrics, metricsSha256: sha256(metrics) });
}

function assertAuthorityReceiptBindings(bindings: ExactOutcomeAuthorityBindings,
  evidence: Pick<ExactCampaignEvidence, "authorizedLocatorInventory" |
    "forbiddenLocatorReceipt" | "goldRelevanceReceipt">): void {
  if (sha256(evidence.forbiddenLocatorReceipt) !==
      digest(bindings.forbiddenLocatorReceiptSha256, "authorized forbidden locator receipt") ||
    sha256(evidence.goldRelevanceReceipt) !==
      digest(bindings.goldRelevanceReceiptSha256, "authorized relevance receipt") ||
    sha256(evidence.authorizedLocatorInventory) !==
      digest(bindings.locatorInventoryReceiptSha256, "authorized locator inventory receipt")) {
    throw new Error("holdout outcome authority receipt was substituted or replayed");
  }
}

// oxlint-disable-next-line complexity -- exact role schemas are compared fail closed in one pass
export function verifyExactOutcomeAuthorities(policy: QualityCampaignAuthorityPolicy, input: {
  readonly campaignRootSha256: string; readonly evidence: ExactCampaignEvidence;
  readonly questions: readonly CampaignQuestion[]; readonly releaseRootSha256: string }): void {
  const locatorAuthority = policy.authority("locator");
  const locatorReceipt = verifyExternalSignedValue<Record<string, unknown>>(
    input.evidence.authorizedLocatorInventory, locatorAuthority.keyId,
    locatorAuthority.publicKeyPem, "authoritative locator inventory");
  const locatorPayload = exactRecord(locatorReceipt.payload, ["campaignRootSha256", "locatorIds",
    "releaseRootSha256", "schemaVersion"], "authoritative locator inventory payload");
  if (locatorPayload.schemaVersion !== "meeting_knowledge.semantic_quality_locator_inventory.v1" ||
    locatorPayload.campaignRootSha256 !== input.campaignRootSha256 ||
    locatorPayload.releaseRootSha256 !== input.releaseRootSha256 ||
    !Array.isArray(locatorPayload.locatorIds)) {
    throw new Error("authoritative locator inventory is foreign or incomplete");
  }
  const locatorIds = (locatorPayload.locatorIds as unknown[]).map((value) =>
    digest(value, "authoritative locator"));
  if (locatorIds.length === 0 || new Set(locatorIds).size !== locatorIds.length ||
    canonicalJson(locatorIds) !== canonicalJson(input.evidence.authorizedLocatorIds)) {
    throw new Error("outcome locator inventory differs from signed locator authority");
  }
  const relevanceAuthority = policy.authority("gold_relevance");
  const relevanceReceipt = verifyExternalSignedValue<Record<string, unknown>>(
    input.evidence.goldRelevanceReceipt, relevanceAuthority.keyId,
    relevanceAuthority.publicKeyPem, "authoritative per-question gold relevance");
  const relevancePayload = exactRecord(relevanceReceipt.payload, ["campaignRootSha256", "entries",
    "releaseRootSha256", "schemaVersion"], "authoritative gold relevance payload");
  const forbiddenReceipt = verifyExternalSignedValue<Record<string, unknown>>(
    input.evidence.forbiddenLocatorReceipt, locatorAuthority.keyId,
    locatorAuthority.publicKeyPem, "authoritative forbidden locator inventory");
  const forbiddenPayload = forbiddenReceipt.payload as Record<string, unknown>;
  if (relevancePayload.schemaVersion !== "meeting_knowledge.semantic_quality_gold_relevance.v1" ||
    forbiddenPayload.schemaVersion !== "meeting_knowledge.semantic_quality_forbidden_locators.v1" &&
      forbiddenPayload.schemaVersion !== "meeting_knowledge.semantic_quality_forbidden_locators.v2" ||
    relevancePayload.campaignRootSha256 !== input.campaignRootSha256 ||
    forbiddenPayload.campaignRootSha256 !== input.campaignRootSha256 ||
    relevancePayload.releaseRootSha256 !== input.releaseRootSha256 ||
    forbiddenPayload.releaseRootSha256 !== input.releaseRootSha256 ||
    !Array.isArray(relevancePayload.entries) ||
    relevancePayload.entries.length !== input.questions.length) {
    throw new Error("authoritative relevance or forbidden locator evidence is foreign or incomplete");
  }
  const globalForbiddenLocatorIds = decodeGlobalForbiddenLocators(forbiddenPayload,
    input.questions);
  const locatorSet = new Set(locatorIds);
  for (const [index, question] of input.questions.entries()) {
    const relevance = exactRecord(relevancePayload.entries[index], ["campaignRootSha256",
      "expectedAbstention", "locale", "questionDigestSha256", "questionId",
      "releaseRootSha256", "relevantLocatorIds", "rubricDigestSha256", "source"],
    "authoritative relevance entry");
    const relevantLocatorIds = locatorArray(relevance.relevantLocatorIds,
      "authoritative relevant locator");
    const forbiddenLocatorIds = globalForbiddenLocatorIds ?? decodeQuestionForbiddenLocators(
      forbiddenPayload, index, question, input.campaignRootSha256, input.releaseRootSha256);
    const questionBinding = { locale: relevance.locale,
      questionDigestSha256: relevance.questionDigestSha256, questionId: relevance.questionId,
      rubricDigestSha256: relevance.rubricDigestSha256, source: relevance.source };
    if (typeof relevance.expectedAbstention !== "boolean") {
      throw new Error("authoritative expected abstention is invalid");
    }
    const expectedAnswer = relevance.expectedAbstention ? "abstain" : "answerable";
    if (canonicalJson(questionBinding) !== canonicalJson(question) ||
      relevance.campaignRootSha256 !== input.campaignRootSha256 ||
      relevance.releaseRootSha256 !== input.releaseRootSha256 ||
      relevantLocatorIds.some((locator) => !locatorSet.has(locator)) ||
      forbiddenLocatorIds.some((locator) => locatorSet.has(locator))) {
      throw new Error("authoritative outcome inputs do not bind the exact sealed question");
    }
    const matching = input.evidence.outcomes.filter((outcome) =>
      outcome.questionId === question.questionId);
    if (matching.length !== 3 || matching.some((outcome) =>
      canonicalJson(outcome.relevantLocatorDigests) !== canonicalJson(relevantLocatorIds) ||
      canonicalJson(outcome.forbiddenLocatorDigests) !== canonicalJson(forbiddenLocatorIds) ||
      outcome.expectedAnswer !== expectedAnswer)) {
      throw new Error("outcome relevance or forbidden locators differ from signed authority");
    }
  }
}

function decodeGlobalForbiddenLocators(payload: Record<string, unknown>,
  questions: readonly CampaignQuestion[]): readonly string[] | undefined {
  if (payload.schemaVersion !== "meeting_knowledge.semantic_quality_forbidden_locators.v2") {
    if (!Array.isArray(payload.entries) || payload.entries.length !== questions.length) {
      throw new Error("authoritative forbidden locator evidence is incomplete");
    }
    return undefined;
  }
  const exact = exactRecord(payload, ["campaignRootSha256", "forbiddenLocatorIds",
    "questionSetSha256", "releaseRootSha256", "schemaVersion"],
  "authoritative global forbidden locator payload");
  if (exact.questionSetSha256 !== sha256(questions)) {
    throw new Error("authoritative forbidden locators bind another question set");
  }
  return locatorArray(exact.forbiddenLocatorIds, "authoritative forbidden locator");
}

function decodeQuestionForbiddenLocators(payload: Record<string, unknown>, index: number,
  question: CampaignQuestion, campaignRootSha256: string,
  releaseRootSha256: string): readonly string[] {
  const forbidden = exactRecord((payload.entries as unknown[])[index], ["campaignRootSha256",
    "forbiddenLocatorIds", "questionDigestSha256", "questionId", "releaseRootSha256"],
  "authoritative forbidden locator entry");
  if (forbidden.campaignRootSha256 !== campaignRootSha256 ||
    forbidden.releaseRootSha256 !== releaseRootSha256 || forbidden.questionId !==
      question.questionId || forbidden.questionDigestSha256 !== question.questionDigestSha256) {
    throw new Error("authoritative outcome inputs do not bind the exact sealed question");
  }
  return locatorArray(forbidden.forbiddenLocatorIds, "authoritative forbidden locator");
}

function locatorArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${label} inventory is not bounded`);
  }
  const locators = value.map((item) => digest(item, label));
  if (new Set(locators).size !== locators.length) {
    throw new Error(`${label} inventory contains duplicates`);
  }
  return Object.freeze(locators);
}

function assertExactMembership(campaignRootSha256: string, expected: readonly {
  readonly attempt: AttemptIdentity; readonly question: CampaignQuestion }[],
  rawOutcomes: readonly ExactOutcomeEvidence[], rawAdjudications:
  readonly ExactAdjudicationEvidence[]): void {
  const expectedIds = expected.map(({ attempt }) => attempt.attemptId).toSorted();
  if (canonicalJson(rawOutcomes.map(({ attemptId }) => attemptId).toSorted()) !==
      canonicalJson(expectedIds) || canonicalJson(rawAdjudications.map(({ attemptId }) =>
        attemptId).toSorted()) !== canonicalJson(expectedIds)) {
    throw new Error("exact evidence is missing, duplicated, or contains orphan attempts");
  }
  const expectedById = new Map(expected.map((value) => [value.attempt.attemptId, value]));
  for (const outcome of rawOutcomes) {
    decodeOutcome(outcome);
    const value = expectedById.get(outcome.attemptId);
    if (value === undefined || outcome.campaignRootSha256 !== campaignRootSha256 ||
      outcome.questionId !== value.question.questionId || outcome.questionDigestSha256 !==
      value.question.questionDigestSha256 || outcome.repetition !== value.attempt.repetition) {
      throw new Error("outcome evidence is not bound to the exact attempt inventory");
    }
  }
  for (const adjudication of rawAdjudications) {
    const value = expectedById.get(adjudication.attemptId);
    if (value === undefined || adjudication.campaignRootSha256 !== campaignRootSha256 ||
      adjudication.questionId !== value.question.questionId || adjudication.repetition !==
      value.attempt.repetition || adjudication.decision.questionId !== value.question.questionId ||
      adjudication.decision.outcomeDigestSha256 !== adjudication.outcomeDigestSha256 ||
      adjudication.decisionDigestSha256 !== sha256(adjudication.decision)) {
      throw new Error("adjudication evidence is not bound to the exact outcome inventory");
    }
    for (const receiptDigest of [sha256(adjudication.firstReceipt),
      sha256(adjudication.secondReceipt), adjudication.outcomeDigestSha256,
      ...(adjudication.resolverReceipt === null ? [] :
        [sha256(adjudication.resolverReceipt)])]) {digest(receiptDigest, "adjudication evidence");}
  }
}

function decodeOutcome(value: ExactOutcomeEvidence): void {
  exactRecord(value, ["answerAbstained", "attemptId", "campaignRootSha256",
    "artifactBindingSha256ByKind", "citationLocatorDigests", "evidenceLocatorDigests",
    "expectedAnswer", "finalAdjudicationSha256", "forbiddenLocatorDigests", "identity",
    "questionDigestSha256", "questionId", "rankedLocatorDigests", "relevantLocatorDigests",
    "repetition", "retrievalLatencyUs", "scopeViolationLocatorIds", "speakerTimeChecks",
    "terminalChain", "evidenceTurnIds"],
  "exact outcome evidence");
  safeId(value.attemptId, "outcome attempt"); safeId(value.questionId, "outcome question");
  digest(value.campaignRootSha256, "outcome root");
  digest(value.questionDigestSha256, "outcome question digest");
  if (typeof value.answerAbstained !== "boolean" ||
    !["answerable", "abstain"].includes(value.expectedAnswer) ||
    !Number.isSafeInteger(value.retrievalLatencyUs) || value.retrievalLatencyUs < 0) {
    throw new Error("outcome contains a missing or unknown metric field");
  }
  assertLocatorDigests(value.citationLocatorDigests);
  assertLocatorDigests(value.evidenceLocatorDigests);
  assertLocatorDigests(value.rankedLocatorDigests);
  assertLocatorDigests(value.relevantLocatorDigests);
  assertLocatorDigests(value.forbiddenLocatorDigests);
  if (value.rankedLocatorDigests.length >
    QUALIFICATION_PROVIDER_INPUT_CONTRACT.retrieval.resultLimit) {
    throw new Error("outcome contains a missing or unknown metric field");
  }
}

function assertLocatorDigests(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) {throw new Error("outcome contains a missing or unknown metric field");}
  for (const item of value as readonly unknown[]) {digest(item, "outcome locator");}
}

function computeMetrics(input: { readonly adjudications: readonly ExactAdjudicationEvidence[];
  readonly outcomes: readonly ExactOutcomeEvidence[]; readonly repetition: 1 | 2 | 3 }):
LocallyComputedMetrics {
  const decisions = input.adjudications.flatMap(({ decision }) => decision.claims);
  const factual = decisions.filter(({ claimFactual }) => claimFactual);
  const citations = factual;
  const abstention = calculateAbstentionStatistics(input.outcomes.map((outcome) => ({
    expected: outcome.expectedAnswer === "abstain", observed: outcome.answerAbstained,
  })));
  const answerable = input.outcomes.filter(({ expectedAnswer }) => expectedAnswer === "answerable");
  const latencies = input.outcomes.map(({ retrievalLatencyUs }) => retrievalLatencyUs)
    .toSorted((a, b) => a - b);
  return Object.freeze({
    abstentionPrecision: abstention.abstentionPrecision,
    abstentionRecall: abstention.abstentionRecall,
    citationEntailment: ratio(citations.filter(({ citationEntailed }) => citationEntailed).length,
      citations.length),
    citationMembership: ratio(input.outcomes.reduce((sum, value) => sum +
      value.citationLocatorDigests.filter((locator) =>
        value.evidenceLocatorDigests.includes(locator)).length, 0),
    input.outcomes.reduce((sum, value) => sum + value.citationLocatorDigests.length, 0)),
    claimPrecision: ratio(factual.filter(({ claimSupported }) => claimSupported).length,
      factual.length),
    completeQuestionRecallAt5: ratio(answerable.filter((outcome) =>
      outcome.relevantLocatorDigests.every((locator) =>
        outcome.rankedLocatorDigests.slice(0, 5).includes(locator))).length, answerable.length),
    crossScopeLeakageCount: input.outcomes.reduce((count, outcome) => count +
      outcome.rankedLocatorDigests.filter((locator) =>
        outcome.forbiddenLocatorDigests.includes(locator)).length, 0),
    outcomeCount: input.outcomes.length, repetition: input.repetition,
    retrievalLatencyP95Us: latencies[Math.ceil(latencies.length * 0.95) - 1] ?? -1,
    unsupportedFactualClaims: factual.filter(({ claimSupported }) => !claimSupported).length,
  });
}

function ratio(numerator: number, denominator: number) {
  return Object.freeze({ denominator, numerator });
}

function assertThresholds(metrics: LocallyComputedMetrics): void {
  if (metrics.outcomeCount < 1 || metrics.retrievalLatencyP95Us < 0) {
    throw new Error("metrics are missing or unknown");
  }
  const ratios = { abstentionPrecision: QUALIFICATION_THRESHOLDS.abstentionPrecision,
    abstentionRecall: QUALIFICATION_THRESHOLDS.abstentionRecall,
    citationEntailment: QUALIFICATION_THRESHOLDS.citationEntailment,
    citationMembership: QUALIFICATION_THRESHOLDS.citationMembership,
    claimPrecision: QUALIFICATION_THRESHOLDS.claimPrecision,
    completeQuestionRecallAt5: QUALIFICATION_THRESHOLDS.completeQuestionRecallAt5 } as const;
  for (const [key, minimum] of Object.entries(ratios) as [keyof typeof ratios,
    { readonly denominator: number; readonly numerator: number }][]) {
    const observed = metrics[key];
    if (observed.denominator < 1 || observed.numerator * minimum.denominator <
      observed.denominator * minimum.numerator) {throw new Error(`metric threshold failed: ${key}`);}
  }
  if (metrics.crossScopeLeakageCount > QUALIFICATION_THRESHOLDS.crossScopeLeakageMaximum ||
    metrics.unsupportedFactualClaims > QUALIFICATION_THRESHOLDS.unsupportedFactualClaimsMaximum ||
    metrics.retrievalLatencyP95Us > QUALIFICATION_THRESHOLDS.maximumRetrievalLatencyP95Us) {
    throw new Error("metric threshold failed: leakage, unsupported facts, or retrieval p95");
  }
}
