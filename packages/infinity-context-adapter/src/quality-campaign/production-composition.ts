import { admitMainCampaign, type AdmissionAuthority, type CampaignQuestion } from "./admission.js";
import { adjudicateOutcome } from "./adjudication.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { attemptIdentity, verifySpendReservations } from "./execution.js";
import { createHoldoutReport } from "./holdout.js";
import { assertObservedRelease, verifyReleaseRoot } from "./release.js";
import { admitFinalCampaign } from "./retention.js";
import { ProductionCheckpointStore } from "./production-checkpoints.js";
import { executeDerivedCleanup } from "./production-cleanup.js";
import { reconstructExactHoldoutEvidence, reconstructExactMainEvidence,
  type ExactAdjudicationEvidence } from "./production-evidence.js";
import { executeIsolatedProductionHoldout } from "./production-holdout.js";
import { loadCanonicalCustody, loadCleanupTargets, loadProductionAuthority,
  loadProductionConfiguration, loadProductionHoldout, readProductionArray,
  readProductionJson, readProductionText, type CanonicalCustodyEvidence,
  type ProductionOperatorConfiguration } from "./production-inputs.js";
import type { CampaignCallContext, QualityCampaignProductionPorts } from "./production-ports.js";
import { executeMainCampaignSchedule } from "./production-scheduler.js";

const AUTHORITY_CALL_DEADLINE_MS = 120_000;

export type ProductionCampaignCommand = "adjudicate" | "cleanup-absence" | "execute" |
  "final-admission" | "holdout-adjudicate" | "holdout-cleanup" | "holdout-execute" |
  "holdout-resume" | "holdout-status" | "preflight" | "resume" | "retention" | "status" |
  "verify-bind";

export interface ProductionCompositionResult {
  readonly blockerCode: "none" | "outcome_unknown";
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly status: "completed" | "outcome_unknown" | "paused";
}

export async function runQualityCampaignProductionComposition(input: {
  readonly command: ProductionCampaignCommand; readonly configurationPath: string;
  readonly ports: QualityCampaignProductionPorts;
}): Promise<ProductionCompositionResult> {
  const config = await loadProductionConfiguration(input.configurationPath);
  const releaseAuthorityPem = await readProductionText(config.releaseAuthorityPublicKeyPath,
    "release authority public key");
  const verifiedRelease = verifyReleaseRoot({ authorityPublicKeyPem: releaseAuthorityPem,
    document: await readProductionJson(config.releaseRootPath, "release root") });
  const bootstrapNow = input.ports.clock.nowEpochMs();
  assertObservedRelease(verifiedRelease.release, await withCallContext(
    bootstrapNow + AUTHORITY_CALL_DEADLINE_MS, async (context) =>
      await input.ports.release.observe(context)));
  const custodyAuthority = await loadProductionAuthority(config.admissionAuthorityPath);
  const absenceAuthority = await loadProductionAuthority(config.absenceAuthorityPath);
  const deletionAuthority = await loadProductionAuthority(config.deletionAuthorityPath);
  assertDistinctCleanupAuthorities(absenceAuthority, deletionAuthority, input.ports);
  const reviewerAuthorities = await Promise.all(config.reviewerAuthorityPaths.map(
    loadProductionAuthority)) as
    unknown as [AdmissionAuthority, AdmissionAuthority];
  const admitted = await admitMainCampaign({ authority: custodyAuthority,
    manifestPath: config.mainManifestPath, releaseRootSha256: verifiedRelease.releaseRootSha256,
    reviewerAuthorities });
  const custody = await loadCanonicalCustody({ authority: custodyAuthority,
    mainInputRootSha256: admitted.rootBindingSha256,
    path: config.authoritativeEvidenceInventoryPath, questions: admitted.questions,
    releaseRootSha256: verifiedRelease.releaseRootSha256 });
  const checkpoints = new ProductionCheckpointStore(config.checkpointRoot);
  const deadline = await checkpoints.deadline({ campaignRootSha256: admitted.rootBindingSha256,
    nowEpochMs: input.ports.clock.nowEpochMs() });

  if (input.command === "preflight" || input.command === "verify-bind") {
    return { blockerCode: "none", receipt: safeReceipt("preflight",
      admitted.rootBindingSha256, { campaignDeadlineEpochMs: deadline.campaignDeadlineEpochMs,
        providerCalls: 0, questionCount: admitted.questions.length,
        releaseRootSha256: verifiedRelease.releaseRootSha256 }), status: "paused" };
  }

  if (input.command === "execute" || input.command === "resume") {
    const spendAuthority = await loadProductionAuthority(config.spendAuthorityPath);
    const reservations = verifySpendReservations({ authorityKeyId: spendAuthority.keyId,
      authorityPublicKeyPem: spendAuthority.publicKeyPem,
      campaignRootSha256: admitted.rootBindingSha256,
      nowEpochMs: input.ports.clock.nowEpochMs(), releaseRootSha256:
      verifiedRelease.releaseRootSha256, reservations: await readProductionArray(
        config.spendReservationsPath, "spend reservations") });
    const scheduled = await executeMainCampaignSchedule({ binding: { campaignRootSha256:
      admitted.rootBindingSha256, release: verifiedRelease.release,
      releaseRootSha256: verifiedRelease.releaseRootSha256 }, clock: input.ports.clock,
    concurrency: config.concurrency, deadlineEpochMs: deadline.campaignDeadlineEpochMs,
    journalRoot: config.journalRoot, ports: input.ports.mainProvider,
    questions: admitted.questions, spendReservationSha256ByRepetition: {
      1: sha256(reservations[0]), 2: sha256(reservations[1]), 3: sha256(reservations[2]) } });
    const receipt = safeReceipt("execution", admitted.rootBindingSha256, {
      completedOutcomes: scheduled.completedOutcomes,
      deadlineEpochMs: deadline.campaignDeadlineEpochMs,
      maximumObservedConcurrency: scheduled.maximumObservedConcurrency,
      terminalAttemptSetSha256: sha256(scheduled.terminalAttemptIds) });
    if (scheduled.outcomeUnknown) {return { blockerCode: "outcome_unknown", receipt,
      status: "outcome_unknown" };}
    if (scheduled.completedOutcomes !== 720) {throw new Error("execution cardinality is incomplete");}
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "executed", receipt });
    return { blockerCode: "none", receipt, status: "paused" };
  }

  if (input.command === "adjudicate") {
    await checkpoints.requirePhase(admitted.rootBindingSha256, "executed");
    await assertPinnedReviewPorts(config, input.ports);
    const adjudications = await adjudicateAttempts({ attempts: answerAttempts(admitted.questions,
      admitted.rootBindingSha256), campaignRootSha256: admitted.rootBindingSha256,
    concurrency: config.concurrency, deadlineEpochMs: deadline.campaignDeadlineEpochMs,
    ports: input.ports });
    const receipt = adjudicationReceipt(admitted.rootBindingSha256, adjudications);
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "adjudicated", receipt });
    return { blockerCode: "none", receipt, status: "paused" };
  }

  if (input.command === "retention") {
    const adjudicatedReceiptSha256 = await checkpoints.requirePhase(
      admitted.rootBindingSha256, "adjudicated");
    const evidence = await loadMainEvidence(input.ports, admitted.rootBindingSha256,
      admitted.questions, deadline.campaignDeadlineEpochMs);
    assertAdjudicationCheckpoint(adjudicatedReceiptSha256, admitted.rootBindingSha256,
      evidence.adjudications);
    const reconstructed = reconstructExactMainEvidence({ campaignRootSha256:
      admitted.rootBindingSha256, evidence, questions: admitted.questions });
    const receipt = retentionReceipt(admitted.rootBindingSha256, reconstructed);
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "retained", receipt });
    return { blockerCode: "none", receipt, status: "paused" };
  }

  if (input.command === "cleanup-absence") {
    const retainedReceiptSha256 = await checkpoints.requirePhase(
      admitted.rootBindingSha256, "retained");
    const evidence = await loadMainEvidence(input.ports, admitted.rootBindingSha256,
      admitted.questions, deadline.campaignDeadlineEpochMs);
    const reconstructed = reconstructExactMainEvidence({ campaignRootSha256:
      admitted.rootBindingSha256, evidence, questions: admitted.questions });
    if (sha256(retentionReceipt(admitted.rootBindingSha256, reconstructed)) !==
      retainedReceiptSha256) {throw new Error("exact retained evidence changed before cleanup");}
    const cleanup = await withCallContext(deadline.campaignDeadlineEpochMs, async (context) =>
      await executeDerivedCleanup({ absenceAuthority,
        campaignRootSha256: admitted.rootBindingSha256, context,
        deletion: input.ports.deletion, observation: input.ports.absence,
        protectedEvidence: custody.protectedEvidence,
        targets: await loadCleanupTargets(config.cleanupPlanPath) }));
    const passes = reconstructed.metrics.map((metrics) => ({ metricsSha256:
      reconstructed.metricsSha256ByRepetition[metrics.repetition], repetition:
      metrics.repetition, thresholdsPassed: true as const }));
    const final = admitFinalCampaign({ cleanupReceiptSha256: cleanup.absenceReceiptSha256,
      independentRepetitionPasses: passes, inventorySha256: reconstructed.inventorySha256,
      outcomeCount: evidence.outcomes.length, rootBindingSha256: admitted.rootBindingSha256 });
    const receipt = safeReceipt("final-admission", admitted.rootBindingSha256, {
      cleanupReceiptSha256: cleanup.absenceReceiptSha256,
      finalAdmissionSha256: final.finalAdmissionSha256, qualified: final.qualified });
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "qualified", receipt });
    return { blockerCode: "none", receipt, status: "completed" };
  }

  const holdoutResult = await runHoldoutCommand({ absenceAuthority, admitted, checkpoints,
    command: input.command, config, custody, custodyAuthority,
    deadlineEpochMs: deadline.campaignDeadlineEpochMs, ports: input.ports,
    release: verifiedRelease.release });
  if (holdoutResult !== null) {return holdoutResult;}

  if (input.command === "status" || input.command === "final-admission") {
    const qualifiedCheckpointSha256 = await checkpoints.requirePhase(
      admitted.rootBindingSha256, "qualified");
    return { blockerCode: "none", receipt: safeReceipt("status",
      admitted.rootBindingSha256, { qualifiedCheckpointSha256 }), status: "completed" };
  }
  throw new Error("unsupported production command");
}

async function runHoldoutCommand(input: { readonly absenceAuthority: AdmissionAuthority;
  readonly admitted: Awaited<ReturnType<typeof admitMainCampaign>>;
  readonly checkpoints: ProductionCheckpointStore; readonly command: ProductionCampaignCommand;
  readonly config: ProductionOperatorConfiguration; readonly custody: CanonicalCustodyEvidence;
  readonly custodyAuthority: AdmissionAuthority; readonly deadlineEpochMs: number;
  readonly ports: QualityCampaignProductionPorts;
  readonly release: Parameters<typeof executeIsolatedProductionHoldout>[0]["release"] }):
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
    ports: input.ports });
  const holdoutRootSha256 = holdout.authorization.holdoutRootSha256;
  if (input.command === "holdout-execute" || input.command === "holdout-resume") {
    await input.checkpoints.requirePhase(input.admitted.rootBindingSha256, "qualified");
    const report = await executeIsolatedProductionHoldout({ ...holdout,
      clock: input.ports.clock, concurrency: input.config.concurrency,
      deadlineEpochMs: input.deadlineEpochMs, journalRoot: input.config.holdoutJournalRoot,
      ports: input.ports.holdoutProvider, release: input.release });
    if ("outcomeUnknown" in report) {return { blockerCode: "outcome_unknown",
      receipt: safeReceipt("holdout-execution", holdoutRootSha256, {
        affectsMainQualification: false, outcomeUnknown: true }), status: "outcome_unknown" };}
    const receipt = safeReceipt("holdout-execution", holdoutRootSha256, {
      affectsMainQualification: false, holdoutExecutionSha256: sha256(report), outcomeCount: 30 });
    await input.checkpoints.completePhase({ campaignRootSha256: input.admitted.rootBindingSha256,
      phase: "holdout-executed", receipt });
    return { blockerCode: "none", receipt, status: "paused" };
  }
  if (input.command === "holdout-adjudicate") {
    await input.checkpoints.requirePhase(input.admitted.rootBindingSha256, "holdout-executed");
    await assertPinnedReviewPorts(input.config, input.ports);
    const adjudications = await adjudicateAttempts({ attempts: answerAttempts(holdout.questions,
      holdoutRootSha256, [1]), campaignRootSha256: holdoutRootSha256,
    concurrency: input.config.concurrency, deadlineEpochMs: input.deadlineEpochMs,
    ports: input.ports });
    const receipt = adjudicationReceipt(holdoutRootSha256, adjudications);
    await input.checkpoints.completePhase({ campaignRootSha256: input.admitted.rootBindingSha256,
      phase: "holdout-adjudicated", receipt });
    return { blockerCode: "none", receipt, status: "paused" };
  }
  if (input.command === "holdout-cleanup") {
    const adjudicatedReceiptSha256 = await input.checkpoints.requirePhase(
      input.admitted.rootBindingSha256, "holdout-adjudicated");
    const evidence = await loadHoldoutEvidence(input.ports, holdoutRootSha256,
      holdout.questions, input.deadlineEpochMs);
    assertAdjudicationCheckpoint(adjudicatedReceiptSha256, holdoutRootSha256,
      evidence.adjudications);
    const metrics = reconstructExactHoldoutEvidence({ campaignRootSha256: holdoutRootSha256,
      ...evidence, questions: holdout.questions });
    const cleanup = await withCallContext(input.deadlineEpochMs, async (context) =>
      await executeDerivedCleanup({ absenceAuthority: input.absenceAuthority,
        campaignRootSha256: holdoutRootSha256, context, deletion: input.ports.deletion,
        observation: input.ports.absence, protectedEvidence: input.custody.protectedEvidence,
        targets: await loadCleanupTargets(input.config.holdoutCleanupPlanPath) }));
    const report = createHoldoutReport({ cleanupReceiptSha256: cleanup.absenceReceiptSha256,
      holdoutRootSha256, outcomeCount: evidence.outcomes.length,
      reportMetricsSha256: metrics.metricsSha256 });
    const receipt = safeReceipt("holdout-report", holdoutRootSha256, {
      affectsMainQualification: false, cleanupReceiptSha256: cleanup.absenceReceiptSha256,
      separateReportSha256: report.separateReportSha256 });
    await input.checkpoints.completePhase({ campaignRootSha256: input.admitted.rootBindingSha256,
      phase: "holdout-completed", receipt });
    return { blockerCode: "none", receipt, status: "completed" };
  }
  const holdoutCheckpointSha256 = await input.checkpoints.requirePhase(
    input.admitted.rootBindingSha256, "holdout-completed");
  return { blockerCode: "none", receipt: safeReceipt("holdout-status", holdoutRootSha256, {
    affectsMainQualification: false, holdoutCheckpointSha256 }), status: "completed" };
}

async function assertPinnedReviewPorts(config: ProductionOperatorConfiguration,
  ports: QualityCampaignProductionPorts): Promise<void> {
  const pinned = await Promise.all(config.adjudicationAuthorityPaths.map(loadProductionAuthority));
  const actual = [ports.review.first, ports.review.second, ports.review.resolver];
  if (canonicalJson(pinned.map(({ keyId, publicKeyPem }) => ({ keyId, publicKeyPem }))) !==
    canonicalJson(actual.map(({ authorityId: keyId, publicKeyPem }) => ({ keyId,
      publicKeyPem })))) {throw new Error("review ports are not the independently pinned authorities");}
}

function answerAttempts(questions: readonly CampaignQuestion[], campaignRootSha256: string,
  repetitions: readonly (1 | 2 | 3)[] = [1, 2, 3]) {
  return repetitions.flatMap((repetition) => questions.map((question) => attemptIdentity({
    callKind: "answer", callOrdinal: 2, campaignRootSha256,
    questionDigestSha256: question.questionDigestSha256,
    questionId: question.questionId, repetition })));
}

async function adjudicateAttempts(input: { readonly attempts: ReturnType<typeof answerAttempts>;
  readonly campaignRootSha256: string; readonly concurrency: number;
  readonly deadlineEpochMs: number; readonly ports: QualityCampaignProductionPorts }):
Promise<readonly ExactAdjudicationEvidence[]> {
  return await boundedMap(input.attempts, input.concurrency, async (attempt) =>
    await withCallContext(input.deadlineEpochMs, async (context) => {
      const rawOutcomeEnvelopeSha256 = await input.ports.review
        .rawOutcomeEnvelopeSha256(attempt.attemptId, context);
      const result = await adjudicateOutcome({ attempt, deadlineEpochMs: context.deadlineEpochMs,
        first: input.ports.review.first, rawOutcomeEnvelopeSha256,
        resolver: input.ports.review.resolver, second: input.ports.review.second,
        signal: context.signal, vault: input.ports.review.vault });
      return Object.freeze({ ...result, attemptId: attempt.attemptId,
        campaignRootSha256: input.campaignRootSha256, questionId: attempt.questionId,
        repetition: attempt.repetition });
    }));
}

function adjudicationReceipt(campaignRootSha256: string,
  adjudications: readonly ExactAdjudicationEvidence[]) {
  return safeReceipt("adjudication", campaignRootSha256, {
    adjudicationCount: adjudications.length,
    adjudicationSetSha256: sha256(adjudications.map(({ attemptId, decisionDigestSha256,
      outcomeDigestSha256, resolverReceiptSha256 }) => ({ attemptId, decisionDigestSha256,
      outcomeDigestSha256, resolverReceiptSha256 })).toSorted((a, b) =>
        a.attemptId.localeCompare(b.attemptId))) });
}

function assertAdjudicationCheckpoint(receiptSha256: string, campaignRootSha256: string,
  adjudications: readonly ExactAdjudicationEvidence[]): void {
  if (sha256(adjudicationReceipt(campaignRootSha256, adjudications)) !== receiptSha256) {
    throw new Error("exact adjudication evidence changed or is not locally reconstructed");
  }
}

async function loadMainEvidence(ports: QualityCampaignProductionPorts, campaignRootSha256: string,
  questions: readonly CampaignQuestion[], deadlineEpochMs: number) {
  const attemptIds = answerAttempts(questions, campaignRootSha256).map(({ attemptId }) => attemptId);
  return await withCallContext(deadlineEpochMs, async (context) => await ports.evidence.main({
    attemptIds, campaignRootSha256, context }));
}

async function loadHoldoutEvidence(ports: QualityCampaignProductionPorts,
  campaignRootSha256: string, questions: readonly CampaignQuestion[], deadlineEpochMs: number) {
  const attemptIds = answerAttempts(questions, campaignRootSha256, [1])
    .map(({ attemptId }) => attemptId);
  return await withCallContext(deadlineEpochMs, async (context) => await ports.evidence.holdout({
    attemptIds, campaignRootSha256, context }));
}

function retentionReceipt(campaignRootSha256: string, reconstructed: ReturnType<
  typeof reconstructExactMainEvidence>) {
  return safeReceipt("retention", campaignRootSha256, { inventorySha256:
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

async function withCallContext<T>(sharedDeadlineEpochMs: number,
  task: (context: CampaignCallContext) => Promise<T>): Promise<T> {
  const deadlineEpochMs = Math.min(sharedDeadlineEpochMs, Date.now() + AUTHORITY_CALL_DEADLINE_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => {controller.abort(new Error("production authority deadline exceeded"));},
    Math.max(0, deadlineEpochMs - Date.now()));
  try {return await task({ deadlineEpochMs, signal: controller.signal });}
  finally {clearTimeout(timeout);}
}

function assertDistinctCleanupAuthorities(absence: AdmissionAuthority,
  deletion: AdmissionAuthority, ports: QualityCampaignProductionPorts): void {
  if (absence.keyId === deletion.keyId || absence.publicKeyPem === deletion.publicKeyPem ||
    ports.absence.authorityId !== absence.keyId || ports.deletion.authorityId !== deletion.keyId) {
    throw new Error("deletion and absence authorities and keys must be independent");
  }
}

function safeReceipt(phase: string, campaignRootSha256: string,
  values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({ campaignRootSha256, phase, ...values,
    schemaVersion: "meeting_knowledge.semantic_quality_production_safe_receipt.v2" });
}
