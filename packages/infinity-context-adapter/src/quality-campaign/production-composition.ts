import { admitMainCampaign, type AdmissionAuthority, type CampaignQuestion } from "./admission.js";
import { adjudicateOutcome } from "./adjudication.js";
import { sha256 } from "./canonical.js";
import { DurableAttemptJournal } from "./attempt-journal.js";
import { attemptIdentity } from "./execution.js";
import { admitFinalCampaign } from "./final-admission.js";
import { createHoldoutReport } from "./holdout.js";
import { createOperatorSafeReceipt, type OperatorSafeReceipt } from "./operator-cli.js";
import { loadPinnedProductionRelease, loadVerifiedProductionSpend,
  withProductionCallContext } from "./production-bootstrap.js";
import { ProductionCheckpointStore } from "./production-checkpoints.js";
import { assertDistinctCleanupAuthorities, decodePersistedCleanup,
  executeDerivedCleanup } from "./production-cleanup.js";
import { reconstructExactHoldoutEvidence, reconstructExactMainEvidence,
  type ExactAdjudicationEvidence } from "./production-evidence.js";
import { loadHoldoutExecutionEvidence, loadMainExecutionEvidence } from
  "./production-execution-evidence.js";
import { executeIsolatedProductionHoldout } from "./production-holdout.js";
import { verifyPinnedReleaseDocument } from "./release.js";
import { loadCanonicalCustody, loadProductionAuthority, loadProductionAuthorityPolicy,
  loadProductionConfiguration, loadProductionHoldout, readProductionJson,
  type CanonicalCustodyEvidence,
  type ProductionOperatorConfiguration } from "./production-inputs.js";
import type { QualityCampaignProductionPorts } from "./production-ports.js";
import { executeProductionMain } from "./production-main-execution.js";
import { loadProductionExecutionCorpus } from "./production-execution-corpus-custody.js";

export type ProductionCampaignCommand = "adjudicate" | "cleanup-absence" | "execute" |
  "adjudicate-resume" | "final-admission" | "holdout-adjudicate" | "holdout-cleanup" | "holdout-execute" |
  "holdout-resume" | "holdout-status" | "preflight" | "resume" | "retention" | "status" |
  "verify-bind";

export interface ProductionCompositionResult {
  readonly blockerCode: "campaign_incomplete" | "none" | "outcome_unknown";
  readonly receipt: OperatorSafeReceipt;
  readonly status: "completed" | "outcome_unknown" | "paused";
}
interface ProductionCompositionInput {
  readonly command: ProductionCampaignCommand; readonly configurationPath: string;
  readonly ports: QualityCampaignProductionPorts;
}

// oxlint-disable-next-line max-lines-per-function -- one closed dispatcher preserves one admission path
export async function runQualityCampaignProductionComposition(input: ProductionCompositionInput):
Promise<ProductionCompositionResult> {
  const config = await loadProductionConfiguration(input.configurationPath); const policy =
    await loadProductionAuthorityPolicy(config.authorityPolicyPath); const {
      pinned: pinnedRelease, verified: verifiedRelease } = await loadPinnedProductionRelease(
      policy, config, input.ports);
  const custodyAuthority = await loadProductionAuthority(config.admissionAuthorityPath);
  const absenceAuthority = await loadProductionAuthority(config.absenceAuthorityPath); const deletionAuthority = await loadProductionAuthority(config.deletionAuthorityPath);
  assertDistinctCleanupAuthorities(absenceAuthority, deletionAuthority, input.ports);
  const reviewerAuthorities = await Promise.all(config.reviewerAuthorityPaths.map(
    loadProductionAuthority)) as unknown as [AdmissionAuthority, AdmissionAuthority];
  const admitted = await admitMainCampaign(policy, { authorityKeyId: custodyAuthority.keyId,
    manifestPath: config.mainManifestPath, nowEpochMs: input.ports.clock.nowEpochMs(),
    releaseRootSha256: verifiedRelease.releaseRootSha256,
    reviewerAuthorityKeyIds: [reviewerAuthorities[0].keyId, reviewerAuthorities[1].keyId] });
  const executionPackets = await loadProductionExecutionCorpus({ authority: custodyAuthority,
    campaignRootSha256: admitted.rootBindingSha256, expectedQuestionCount: admitted.questions.length,
    executionPacketPath: config.executionCorpusPath });
  const custody = await loadCanonicalCustody({ authority: custodyAuthority,
    mainInputRootSha256: admitted.rootBindingSha256,
    path: config.authoritativeEvidenceInventoryPath, questions: admitted.questions,
    releaseRootSha256: verifiedRelease.releaseRootSha256 });
  const checkpoints = new ProductionCheckpointStore(config.checkpointRoot);
  const deadline = await checkpoints.deadline({ campaignRootSha256: admitted.rootBindingSha256,
    nowEpochMs: input.ports.clock.nowEpochMs() }); const { documents: spendDocuments,
    reservations } = await loadVerifiedProductionSpend(policy, { campaignRootSha256:
      admitted.rootBindingSha256,
      config, nowEpochMs: input.ports.clock.nowEpochMs(), releaseRootSha256:
      verifiedRelease.releaseRootSha256 });
  const spendDigests = { 1: reservations[0]!.spendReservationSha256, 2:
    reservations[1]!.spendReservationSha256, 3: reservations[2]!.spendReservationSha256 } as const;
  if (input.command === "preflight" || input.command === "verify-bind") {
    return { blockerCode: "campaign_incomplete", receipt: createOperatorSafeReceipt(
      admitted.rootBindingSha256, { campaignDeadlineEpochMs: deadline.campaignDeadlineEpochMs,
        providerCalls: 0, questionCount: admitted.questions.length,
        releaseRootSha256: verifiedRelease.releaseRootSha256 }), status: "paused" };
  }
  if (input.command === "execute" || input.command === "resume") {
    const scheduled = await executeProductionMain({ campaignRootSha256:
      admitted.rootBindingSha256, clock: input.ports.clock, concurrency: config.concurrency,
      deadlineEpochMs: deadline.campaignDeadlineEpochMs, executionPackets,
      executorFactory: input.ports.mainExecutorFactory, journalRoot: config.journalRoot,
      policy, questions: admitted.questions,
      release: verifiedRelease.release, releaseRootSha256: verifiedRelease.releaseRootSha256,
      reservations });
    const receipt = createOperatorSafeReceipt(admitted.rootBindingSha256, {
      completedOutcomes: scheduled.completedOutcomes, deadlineEpochMs: deadline.campaignDeadlineEpochMs,
      maximumObservedConcurrency: scheduled.maximumObservedConcurrency,
      terminalAttemptSetSha256: sha256(scheduled.terminalAttemptIds) });
    if (scheduled.outcomeUnknown) {return { blockerCode: "outcome_unknown", receipt,
      status: "outcome_unknown" };}
    if (scheduled.completedOutcomes !== 720) {throw new Error("execution cardinality is incomplete");}
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "executed", receipt });
    return { blockerCode: "campaign_incomplete", receipt, status: "paused" };
  }
  if (input.command === "adjudicate" || input.command === "adjudicate-resume") {
    await checkpoints.requirePhase(admitted.rootBindingSha256, "executed");
    const adjudications = await adjudicateAttempts({ attempts: answerAttempts(admitted.questions,
      admitted.rootBindingSha256, verifiedRelease.releaseRootSha256, spendDigests), campaignRootSha256:
      admitted.rootBindingSha256, concurrency: config.concurrency, deadlineEpochMs:
      deadline.campaignDeadlineEpochMs, effectVerificationEpochMs: input.ports.clock.nowEpochMs(),
      policy, ports: input.ports, release: pinnedRelease, spendReservations: spendDocuments });
    const receipt = adjudicationReceipt(admitted.rootBindingSha256, adjudications);
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "adjudicated", receipt });
    return { blockerCode: "campaign_incomplete", receipt, status: "paused" };
  }
  if (input.command === "retention") {
    const adjudicatedReceiptSha256 = await checkpoints.requirePhase(admitted.rootBindingSha256, "adjudicated");
    const evidence = await loadMainExecutionEvidence({ ports: input.ports, campaignRootSha256:
      admitted.rootBindingSha256, questions: admitted.questions,
      journalRoot: config.journalRoot, policy,
      deadlineEpochMs: deadline.campaignDeadlineEpochMs,
      release: verifiedRelease.release,
      releaseRootSha256: verifiedRelease.releaseRootSha256,
      spendReservationSha256ByRepetition: spendDigests });
    assertAdjudicationCheckpoint(adjudicatedReceiptSha256, admitted.rootBindingSha256, evidence.adjudications);
    const reconstructed = await reconstructExactMainEvidence({ authorityPolicy: policy,
      artifactKeyCustodySha256:
      verifiedRelease.release.artifactKeyCustodySha256, campaignRootSha256:
      admitted.rootBindingSha256, custody: input.ports.artifactCustody,
    effectVerificationEpochMs: input.ports.clock.nowEpochMs(), evidence,
    providerResultAuthority: input.ports.mainResultAuthority,
    release: verifiedRelease.release,
    questions: admitted.questions, releaseRootSha256: verifiedRelease.releaseRootSha256,
    releaseDocumentSha256: sha256(pinnedRelease.document), spendReservations: reservations,
    spendReservationSha256ByRepetition: spendDigests });
    const receipt = retentionReceipt(admitted.rootBindingSha256, reconstructed);
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "retained", receipt });
    return { blockerCode: "campaign_incomplete", receipt, status: "paused" };
  }
  if (input.command === "cleanup-absence" || input.command === "final-admission") {
    const retainedReceiptSha256 = await checkpoints.requirePhase(admitted.rootBindingSha256, "retained");
    const evidence = await loadMainExecutionEvidence({ ports: input.ports, campaignRootSha256:
      admitted.rootBindingSha256, questions: admitted.questions,
      journalRoot: config.journalRoot, policy,
      deadlineEpochMs: deadline.campaignDeadlineEpochMs,
      release: verifiedRelease.release,
      releaseRootSha256: verifiedRelease.releaseRootSha256,
      spendReservationSha256ByRepetition: spendDigests });
    const reconstructed = await reconstructExactMainEvidence({ authorityPolicy: policy,
      artifactKeyCustodySha256:
      verifiedRelease.release.artifactKeyCustodySha256, campaignRootSha256:
      admitted.rootBindingSha256, custody: input.ports.artifactCustody,
    effectVerificationEpochMs: input.ports.clock.nowEpochMs(), evidence,
    providerResultAuthority: input.ports.mainResultAuthority,
    release: verifiedRelease.release,
    questions: admitted.questions, releaseRootSha256: verifiedRelease.releaseRootSha256,
    releaseDocumentSha256: sha256(pinnedRelease.document), spendReservations: reservations,
    spendReservationSha256ByRepetition: spendDigests });
    if (sha256(retentionReceipt(admitted.rootBindingSha256, reconstructed)) !==
      retainedReceiptSha256) {throw new Error("exact retained evidence changed before cleanup");}
    const cleanup = input.command === "cleanup-absence" ?
      await withProductionCallContext(deadline.campaignDeadlineEpochMs, async (context) =>
        await executeDerivedCleanup({ absenceAuthority,
          campaignRootSha256: admitted.rootBindingSha256, context, policy,
          deletion: input.ports.deletion, observation: input.ports.absence,
          protectedEvidence: custody.protectedEvidence,
          releaseRootSha256: verifiedRelease.releaseRootSha256,
          targetInventoryAuthority: deletionAuthority,
          targetInventoryAuthorityKeySha256:
            verifiedRelease.release.targetInventoryAuthorityKeySha256,
          targetInventoryReceipt: await readProductionJson(config.cleanupPlanPath,
            "campaign target inventory") })) : decodePersistedCleanup(
        await checkpoints.requireEvidencePhase(admitted.rootBindingSha256, "cleaned"));
    if (input.command === "cleanup-absence") {
      const receipt = createOperatorSafeReceipt(admitted.rootBindingSha256, {
        cleanupReceiptSha256: cleanup.absenceReceiptSha256,
        targetCount: cleanup.targetCount });
      await checkpoints.completeEvidencePhase({ campaignRootSha256: admitted.rootBindingSha256,
        evidence: cleanup, phase: "cleaned", receipt });
      return { blockerCode: "campaign_incomplete", receipt, status: "paused" };
    }
    const repetitionAuthority = await loadProductionAuthority(config.repetitionAuthorityPath);
    const spendReservationSha256ByRepetition = [spendDigests[1], spendDigests[2], spendDigests[3]] as const;
    const final = await admitFinalCampaign(policy, { artifactCustody: input.ports.artifactCustody,
      artifacts: evidence.artifacts,
      campaignByteCeiling: evidence.campaignByteCeiling,
      campaignRootSha256: admitted.rootBindingSha256,
      cleanupAuthorityKeyId: absenceAuthority.keyId,
      cleanupReceipt: cleanup.cleanupReceipt,
      effectVerificationEpochMs: input.ports.clock.nowEpochMs(),
      goldRelevanceAuthorityKeyId: policy.authority("gold_relevance").keyId,
      goldRelevanceReceipt: evidence.goldRelevanceReceipt,
      locatorAuthorityKeyId: policy.authority("locator").keyId,
      authorizedLocatorInventory: evidence.authorizedLocatorInventory,
      questionReviewReceipts: evidence.questionReviewReceipts,
      release: pinnedRelease, repetitionAuthorityKeyId: repetitionAuthority.keyId,
      repetitionEvidence: evidence.repetitionEvidence,
      rootBindingSha256: evidence.finalRootBindingSha256,
      spendLedger: new DurableAttemptJournal(config.journalRoot, policy),
      spendReservationsByRepetition: spendDocuments as [unknown, unknown, unknown],
      spendReservationSha256ByRepetition, targetInventoryAuthorityKeyId: deletionAuthority.keyId,
      targetInventoryReceipt: cleanup.targetInventoryReceipt });
    const receipt = createOperatorSafeReceipt(admitted.rootBindingSha256, {
      cleanupReceiptSha256: cleanup.absenceReceiptSha256,
      finalAdmissionSha256: final.finalAdmissionSha256, qualified: final.qualified });
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256, phase: "qualified", receipt });
    return { blockerCode: "none", receipt, status: "completed" };
  }
  const holdoutResult = await runHoldoutCommand({ absenceAuthority, admitted, checkpoints,
    artifactKeyCustodySha256: verifiedRelease.release.artifactKeyCustodySha256,
    command: input.command, config, custody, custodyAuthority,
    deadlineEpochMs: deadline.campaignDeadlineEpochMs, ports: input.ports,
    policy, release: pinnedRelease, targetInventoryAuthorityKeySha256:
      verifiedRelease.release.targetInventoryAuthorityKeySha256,
    verifiedRelease: verifiedRelease.release });
  if (holdoutResult !== null) {return holdoutResult;}
  if (input.command === "status") {
    const qualifiedCheckpointSha256 = await checkpoints.requirePhase(
      admitted.rootBindingSha256, "qualified");
    return { blockerCode: "none", receipt: createOperatorSafeReceipt(
      admitted.rootBindingSha256, { qualifiedCheckpointSha256 }), status: "completed" };
  }
  throw new Error("unsupported production command");
}

async function runHoldoutCommand(input: { readonly absenceAuthority: AdmissionAuthority;
  readonly admitted: Awaited<ReturnType<typeof admitMainCampaign>>;
  readonly artifactKeyCustodySha256: string;
  readonly checkpoints: ProductionCheckpointStore; readonly command: ProductionCampaignCommand;
  readonly config: ProductionOperatorConfiguration; readonly custody: CanonicalCustodyEvidence;
  readonly custodyAuthority: AdmissionAuthority; readonly deadlineEpochMs: number;
  readonly ports: QualityCampaignProductionPorts;
  readonly policy: import("./release.js").QualityCampaignAuthorityPolicy;
  readonly release: Parameters<typeof executeIsolatedProductionHoldout>[0]["release"];
  readonly targetInventoryAuthorityKeySha256: string;
  readonly verifiedRelease: import("./release.js").QualityCampaignRelease }):
Promise<ProductionCompositionResult | null> {
  if (!input.command.startsWith("holdout-")) {return null;}
  const holdoutAuthority = await loadProductionAuthority(input.config.holdoutAuthorityPath);
  if (holdoutAuthority.keyId === input.custodyAuthority.keyId ||
    holdoutAuthority.publicKeyPem === input.custodyAuthority.publicKeyPem) {
    throw new Error("holdout authorization authority must be distinct from main custody");
  }
  const holdout = await loadProductionHoldout({ admitted: input.admitted,
    authority: holdoutAuthority, custody: input.custody,
    nowEpochMs: input.ports.clock.nowEpochMs(), path: input.config.holdoutInputPath,
    policy: input.policy, ports: input.ports,
    release: input.verifiedRelease,
    releaseRootSha256: input.release.releaseRootSha256 });
  const holdoutRootSha256 = holdout.authorization.holdoutRootSha256;
  if (input.command === "holdout-execute" || input.command === "holdout-resume") {
    await input.checkpoints.requirePhase(input.admitted.rootBindingSha256, "qualified");
    const report = await executeIsolatedProductionHoldout({ ...holdout,
      clock: input.ports.clock, concurrency: input.config.concurrency,
      deadlineEpochMs: input.deadlineEpochMs, journalRoot: input.config.holdoutJournalRoot,
      policy: input.policy, ports: input.ports.holdoutProvider, release: input.release });
    if ("outcomeUnknown" in report) {return { blockerCode: "outcome_unknown",
      receipt: createOperatorSafeReceipt(holdoutRootSha256, {
        affectsMainQualification: false, outcomeUnknown: true }), status: "outcome_unknown" };}
    const receipt = createOperatorSafeReceipt(holdoutRootSha256, {
      affectsMainQualification: false, holdoutExecutionSha256: sha256(report), outcomeCount: 90 });
    await input.checkpoints.completePhase({ campaignRootSha256: input.admitted.rootBindingSha256,
      phase: "holdout-executed", receipt });
    return { blockerCode: "campaign_incomplete", receipt, status: "paused" };
  }
  if (input.command === "holdout-adjudicate") {
    await input.checkpoints.requirePhase(input.admitted.rootBindingSha256, "holdout-executed");
    const adjudications = await adjudicateAttempts({ attempts: answerAttempts(holdout.questions,
      holdoutRootSha256, input.release.releaseRootSha256,
      holdout.spendReservationSha256ByRepetition), campaignRootSha256: holdoutRootSha256,
    concurrency: input.config.concurrency, deadlineEpochMs: input.deadlineEpochMs,
    effectVerificationEpochMs: input.ports.clock.nowEpochMs(), policy: input.policy,
    ports: input.ports, release: input.release,
    spendReservations: holdout.spendReservations });
    const receipt = adjudicationReceipt(holdoutRootSha256, adjudications);
    await input.checkpoints.completePhase({ campaignRootSha256: input.admitted.rootBindingSha256,
      phase: "holdout-adjudicated", receipt });
    return { blockerCode: "campaign_incomplete", receipt, status: "paused" };
  }
  if (input.command === "holdout-cleanup") {
    const adjudicatedReceiptSha256 = await input.checkpoints.requirePhase(
      input.admitted.rootBindingSha256, "holdout-adjudicated");
    const evidence = await loadHoldoutExecutionEvidence({ ports: input.ports,
      campaignRootSha256: holdoutRootSha256, questions: holdout.questions,
      journalRoot: input.config.holdoutJournalRoot, policy: input.policy,
      deadlineEpochMs: input.deadlineEpochMs, releaseRootSha256:
      input.release.releaseRootSha256,
      release: input.verifiedRelease,
      spendReservationSha256ByRepetition: holdout.spendReservationSha256ByRepetition });
    assertAdjudicationCheckpoint(adjudicatedReceiptSha256, holdoutRootSha256,
      evidence.adjudications);
    const metrics = await reconstructExactHoldoutEvidence({ authorityBindings:
      holdout.authorityBindings, authorityPolicy: input.policy,
      artifactKeyCustodySha256:
        verifyPinnedReleaseDocument(input.policy, input.release).release.artifactKeyCustodySha256,
      campaignRootSha256: holdoutRootSha256, ...evidence,
      custody: input.ports.artifactCustody,
      effectVerificationEpochMs: input.ports.clock.nowEpochMs(),
      keyNamespace: holdout.authorization.keyNamespace,
      providerResultAuthority: input.ports.holdoutProvider.resultAuthority,
      questions: holdout.questions, release: input.verifiedRelease,
      releaseDocument: input.release,
      releaseDocumentSha256: sha256(input.release.document),
      releaseRootSha256: input.release.releaseRootSha256,
      spendLedger: new DurableAttemptJournal(input.config.holdoutJournalRoot, input.policy,
        "holdout_provider_result"),
      spendReservations: holdout.verifiedSpends,
      spendReservationSha256ByRepetition: holdout.spendReservationSha256ByRepetition });
    const targetInventoryAuthority = await loadProductionAuthority(
      input.config.deletionAuthorityPath);
    const targetInventoryReceipt = await readProductionJson(
      input.config.holdoutCleanupPlanPath, "holdout target inventory");
    if (sha256(targetInventoryReceipt) !==
      holdout.authorization.derivedArtifactInventorySha256) {
      throw new Error("holdout derived artifact inventory was substituted or replayed");
    }
    const cleanup = await withProductionCallContext(input.deadlineEpochMs, async (context) =>
      await executeDerivedCleanup({ absenceAuthority: input.absenceAuthority,
        campaignRootSha256: holdoutRootSha256, context, deletion: input.ports.deletion,
        policy: input.policy,
        observation: input.ports.absence, protectedEvidence: input.custody.protectedEvidence,
        releaseRootSha256: input.release.releaseRootSha256, targetInventoryAuthority,
        targetInventoryAuthorityKeySha256: input.targetInventoryAuthorityKeySha256,
        targetInventoryReceipt }));
    const report = createHoldoutReport({ cleanupReceiptSha256: cleanup.absenceReceiptSha256,
      holdoutRootSha256, outcomeCount: evidence.outcomes.length,
      reportMetricsSha256: sha256({ cumulativeSpendProofSha256:
        metrics.cumulativeSpendProofSha256, metricsSha256: metrics.metricsSha256 }) });
    const receipt = createOperatorSafeReceipt(holdoutRootSha256, {
      affectsMainQualification: false, cleanupReceiptSha256: cleanup.absenceReceiptSha256,
      separateReportSha256: report.separateReportSha256 });
    await input.checkpoints.completePhase({ campaignRootSha256: input.admitted.rootBindingSha256,
      phase: "holdout-completed", receipt });
    return { blockerCode: "none", receipt, status: "completed" };
  }
  const holdoutCheckpointSha256 = await input.checkpoints.requirePhase(
    input.admitted.rootBindingSha256, "holdout-completed");
  return { blockerCode: "none", receipt: createOperatorSafeReceipt(holdoutRootSha256, {
    affectsMainQualification: false, holdoutCheckpointSha256 }), status: "completed" };
}

function answerAttempts(questions: readonly CampaignQuestion[], campaignRootSha256: string,
  releaseRootSha256: string, spendReservationSha256ByRepetition:
  Readonly<Record<1 | 2 | 3, string>>,
  repetitions: readonly (1 | 2 | 3)[] = [1, 2, 3]) {
  return repetitions.flatMap((repetition) => questions.map((question) => attemptIdentity({
    callKind: "answer", callOrdinal: 0, campaignRootSha256,
    questionDigestSha256: question.questionDigestSha256,
    questionId: question.questionId, releaseRootSha256, repetition,
    spendReservationSha256: spendReservationSha256ByRepetition[repetition] })));
}

async function adjudicateAttempts(input: { readonly attempts: ReturnType<typeof answerAttempts>;
  readonly campaignRootSha256: string; readonly concurrency: number;
  readonly deadlineEpochMs: number;
  readonly effectVerificationEpochMs: number;
  readonly policy: import("./release.js").QualityCampaignAuthorityPolicy;
  readonly ports: QualityCampaignProductionPorts;
  readonly release: import("./release.js").PinnedReleaseDocument;
  readonly spendReservations: readonly unknown[] }):
Promise<readonly ExactAdjudicationEvidence[]> {
  return await boundedMap(input.attempts, input.concurrency, async (attempt) =>
    await withProductionCallContext(input.deadlineEpochMs, async (context) => {
      const receipts = await input.ports.review.receipts(attempt.attemptId, context);
      const result = await adjudicateOutcome(input.policy, { attempt,
        effectVerificationEpochMs: input.effectVerificationEpochMs,
        expectedAttempt: { campaignRootSha256: attempt.campaignRootSha256,
          questionDigestSha256: attempt.questionDigestSha256, questionId: attempt.questionId,
          releaseRootSha256: attempt.releaseRootSha256, repetition: attempt.repetition,
          spendReservationSha256: attempt.spendReservationSha256 },
        firstEffectEvidence: receipts.firstEffectEvidence, firstReceipt: receipts.firstReceipt,
        predecessorPlaintextSha256: receipts.predecessorPlaintextSha256,
        rawOutcomeEnvelopeSha256: receipts.rawOutcomeEnvelopeSha256,
        release: input.release, resolverEffectEvidence: receipts.resolverEffectEvidence,
        resolverReceipt: receipts.resolverReceipt,
        secondEffectEvidence: receipts.secondEffectEvidence, secondReceipt: receipts.secondReceipt,
        spendReservation: input.spendReservations[attempt.repetition - 1],
        vault: input.ports.review.vault });
      return Object.freeze({ ...result, attemptId: attempt.attemptId,
        campaignRootSha256: input.campaignRootSha256, questionId: attempt.questionId,
        repetition: attempt.repetition });
    }));
}

function adjudicationReceipt(campaignRootSha256: string,
  adjudications: readonly ExactAdjudicationEvidence[]) {
  return createOperatorSafeReceipt(campaignRootSha256, {
    adjudicationCount: adjudications.length,
    adjudicationSetSha256: sha256(adjudications.map(({ attemptId, decisionDigestSha256,
      outcomeDigestSha256, resolverReceipt }) => ({ attemptId, decisionDigestSha256,
      outcomeDigestSha256, resolverReceiptSha256: resolverReceipt === null ? null :
        sha256(resolverReceipt) })).toSorted((a, b) =>
        a.attemptId.localeCompare(b.attemptId))) });
}

function assertAdjudicationCheckpoint(receiptSha256: string, campaignRootSha256: string,
  adjudications: readonly ExactAdjudicationEvidence[]): void {
  if (sha256(adjudicationReceipt(campaignRootSha256, adjudications)) !== receiptSha256) {
    throw new Error("exact adjudication evidence changed or is not locally reconstructed");
  }
}

function retentionReceipt(campaignRootSha256: string, reconstructed: Awaited<ReturnType<
  typeof reconstructExactMainEvidence>>) {
  return createOperatorSafeReceipt(campaignRootSha256, { inventorySha256:
    reconstructed.inventorySha256, metricsSha256ByRepetition:
    reconstructed.metricsSha256ByRepetition, outcomeCount: 720 });
}

async function boundedMap<T, R>(values: readonly T[], concurrency: number,
  task: (value: T) => Promise<R>): Promise<readonly R[]> {
  const output = Array.from<R>({ length: values.length }); let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {const index = cursor++; const value = values[index]; if (value === undefined) {return;}
      output[index] = await task(value);}
  }));
  return output;
}
