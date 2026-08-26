import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { admitMainCampaign, type AdmissionAuthority, type CampaignQuestion } from "./admission.js";
import { adjudicateOutcome } from "./adjudication.js";
import { canonicalJson, digest, exactRecord, sha256 } from "./canonical.js";
import { attemptIdentity, verifyExternalSignedValue, verifySpendReservations } from "./execution.js";
import { type FrozenMainInputProof, type HoldoutAuthorization } from "./holdout.js";
import { assertObservedRelease, verifyReleaseRoot } from "./release.js";
import { admitFinalCampaign } from "./retention.js";
import { ProductionCheckpointStore } from "./production-checkpoints.js";
import { executeDerivedCleanup, type ProtectedCampaignEvidence } from "./production-cleanup.js";
import { executeIsolatedProductionHoldout } from "./production-holdout.js";
import type { DerivedCampaignArtifact, QualityCampaignProductionPorts } from
  "./production-ports.js";
import { executeMainCampaignSchedule } from "./production-scheduler.js";

export type ProductionCampaignCommand = "adjudicate" | "cleanup-absence" | "execute" |
  "final-admission" | "holdout-execute" | "preflight" | "retention" | "status" |
  "verify-bind";

interface ProductionOperatorConfiguration {
  readonly absenceAuthorityPath: string;
  readonly admissionAuthorityPath: string;
  readonly adjudicationAuthorityPaths: readonly [string, string, string];
  readonly checkpointRoot: string;
  readonly cleanupPlanPath: string;
  readonly concurrency: number;
  readonly holdoutAuthorityPath: string;
  readonly holdoutInputPath: string;
  readonly holdoutJournalRoot: string;
  readonly journalRoot: string;
  readonly mainManifestPath: string;
  readonly releaseAuthorityPublicKeyPath: string;
  readonly releaseRootPath: string;
  readonly reviewerAuthorityPaths: readonly [string, string];
  readonly schemaVersion: "meeting_knowledge.semantic_quality_production_operator.v1";
  readonly spendAuthorityPath: string;
  readonly spendReservationsPath: string;
}

export interface ProductionCompositionResult {
  readonly blockerCode: "none" | "outcome_unknown";
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly status: "completed" | "outcome_unknown" | "paused";
}

export async function runQualityCampaignProductionComposition(input: {
  readonly command: ProductionCampaignCommand; readonly configurationPath: string;
  readonly ports: QualityCampaignProductionPorts;
}): Promise<ProductionCompositionResult> {
  const config = await loadConfiguration(input.configurationPath);
  const releaseAuthorityPem = await readText(config.releaseAuthorityPublicKeyPath,
    "release authority public key");
  const verifiedRelease = verifyReleaseRoot({ authorityPublicKeyPem: releaseAuthorityPem,
    document: await readJson(config.releaseRootPath, "release root") });
  assertObservedRelease(verifiedRelease.release, await input.ports.release.observe());
  const custody = await loadAuthority(config.admissionAuthorityPath);
  const absenceAuthority = await loadAuthority(config.absenceAuthorityPath);
  const reviewerAuthorities = await Promise.all(config.reviewerAuthorityPaths.map(loadAuthority)) as
    unknown as [AdmissionAuthority, AdmissionAuthority];
  const admitted = await admitMainCampaign({ authority: custody,
    manifestPath: config.mainManifestPath, releaseRootSha256: verifiedRelease.releaseRootSha256,
    reviewerAuthorities });
  const checkpoints = new ProductionCheckpointStore(config.checkpointRoot);
  const deadline = await checkpoints.deadline({ campaignRootSha256: admitted.rootBindingSha256,
    nowEpochMs: input.ports.clock.nowEpochMs() });

  if (input.command === "preflight" || input.command === "verify-bind") {
    return { blockerCode: "none", receipt: safeReceipt("preflight",
      admitted.rootBindingSha256, { campaignDeadlineEpochMs: deadline.campaignDeadlineEpochMs,
        providerCalls: 0, questionCount: admitted.questions.length,
        releaseRootSha256: verifiedRelease.releaseRootSha256 }), status: "paused" };
  }

  if (input.command === "execute") {
    const spendAuthority = await loadAuthority(config.spendAuthorityPath);
    const reservations = verifySpendReservations({ authorityKeyId: spendAuthority.keyId,
      authorityPublicKeyPem: spendAuthority.publicKeyPem,
      campaignRootSha256: admitted.rootBindingSha256,
      nowEpochMs: input.ports.clock.nowEpochMs(), releaseRootSha256:
      verifiedRelease.releaseRootSha256, reservations: await readArray(
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
    const adjudications = await boundedMap(answerAttempts(admitted.questions,
      admitted.rootBindingSha256), config.concurrency, async (attempt) => {
        const rawOutcomeEnvelopeSha256 = await input.ports.review
          .rawOutcomeEnvelopeSha256(attempt.attemptId);
        return await adjudicateOutcome({ attempt, first: input.ports.review.first,
          rawOutcomeEnvelopeSha256, resolver: input.ports.review.resolver,
          second: input.ports.review.second, vault: input.ports.review.vault });
      });
    const receipt = safeReceipt("adjudication", admitted.rootBindingSha256, {
      adjudicationCount: adjudications.length,
      adjudicationSetSha256: sha256(adjudications.map(({ decisionDigestSha256,
        outcomeDigestSha256, resolverReceiptSha256 }) => ({ decisionDigestSha256,
        outcomeDigestSha256, resolverReceiptSha256 }))) });
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "adjudicated", receipt });
    return { blockerCode: "none", receipt, status: "paused" };
  }

  if (input.command === "retention") {
    await checkpoints.requirePhase(admitted.rootBindingSha256, "adjudicated");
    const retained = await input.ports.qualification.retention({ campaignRootSha256:
      admitted.rootBindingSha256 });
    if (retained.outcomeCount !== 720) {throw new Error("retention is not exact for 720 outcomes");}
    digest(retained.inventorySha256, "retention inventory");
    const receipt = safeReceipt("retention", admitted.rootBindingSha256, retained);
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "retained", receipt });
    return { blockerCode: "none", receipt, status: "paused" };
  }

  if (input.command === "cleanup-absence") {
    const retentionCheckpointSha256 = await checkpoints.requirePhase(
      admitted.rootBindingSha256, "retained");
    const retained = await input.ports.qualification.retention({ campaignRootSha256:
      admitted.rootBindingSha256 });
    if (retained.outcomeCount !== 720 || sha256(safeReceipt("retention",
      admitted.rootBindingSha256, retained)) !== retentionCheckpointSha256) {
      throw new Error("retention evidence changed before cleanup");
    }
    const cleanupPlan = await loadCleanupPlan(config.cleanupPlanPath);
    const cleanup = await executeDerivedCleanup({ absenceAuthority,
      campaignRootSha256: admitted.rootBindingSha256, deletion: input.ports.deletion,
      observation: input.ports.absence, protectedEvidence: cleanupPlan.protectedEvidence,
      targets: cleanupPlan.targets });
    const passes = await Promise.all(([1, 2, 3] as const).map(async (repetition) => {
      const metrics = await input.ports.qualification.metrics({ campaignRootSha256:
        admitted.rootBindingSha256, repetition });
      if (metrics.outcomeCount !== 240 || metrics.thresholdsPassed !== true) {
        throw new Error("an independent repetition failed exact metrics or thresholds");
      }
      return { metricsSha256: digest(metrics.metricsSha256, "metrics"), repetition,
        thresholdsPassed: true as const };
    }));
    const final = admitFinalCampaign({ cleanupReceiptSha256: cleanup.absenceReceiptSha256,
      independentRepetitionPasses: passes, inventorySha256: retained.inventorySha256,
      outcomeCount: 720, rootBindingSha256: admitted.rootBindingSha256 });
    const receipt = safeReceipt("final-admission", admitted.rootBindingSha256, {
      cleanupReceiptSha256: cleanup.absenceReceiptSha256,
      finalAdmissionSha256: final.finalAdmissionSha256, qualified: final.qualified });
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "qualified", receipt });
    return { blockerCode: "none", receipt, status: "completed" };
  }

  if (input.command === "holdout-execute") {
    await checkpoints.requirePhase(admitted.rootBindingSha256, "qualified");
    const holdout = await loadHoldout(config.holdoutInputPath,
      await loadAuthority(config.holdoutAuthorityPath));
    const report = await executeIsolatedProductionHoldout({ ...holdout,
      clock: input.ports.clock, concurrency: config.concurrency,
      deadlineEpochMs: deadline.campaignDeadlineEpochMs, journalRoot:
      config.holdoutJournalRoot, ports: input.ports.holdoutProvider,
      release: verifiedRelease.release });
    const receipt = safeReceipt("holdout", admitted.rootBindingSha256, {
      affectsMainQualification: false, holdoutReportSha256: sha256(report), outcomeCount: 30 });
    await checkpoints.completePhase({ campaignRootSha256: admitted.rootBindingSha256,
      phase: "holdout", receipt });
    return { blockerCode: "none", receipt, status: "completed" };
  }

  if (input.command === "status" || input.command === "final-admission") {
    const qualifiedCheckpointSha256 = await checkpoints.requirePhase(
      admitted.rootBindingSha256, "qualified");
    return { blockerCode: "none", receipt: safeReceipt("status",
      admitted.rootBindingSha256, { qualifiedCheckpointSha256 }), status: "completed" };
  }
  throw new Error("unsupported production command");
}

async function loadConfiguration(path: string): Promise<ProductionOperatorConfiguration> {
  const keys = ["absenceAuthorityPath", "adjudicationAuthorityPaths", "admissionAuthorityPath", "checkpointRoot",
    "cleanupPlanPath", "concurrency", "holdoutAuthorityPath", "holdoutInputPath",
    "holdoutJournalRoot", "journalRoot", "mainManifestPath", "releaseAuthorityPublicKeyPath",
    "releaseRootPath", "reviewerAuthorityPaths", "schemaVersion", "spendAuthorityPath",
    "spendReservationsPath"];
  const record = exactRecord(await readJson(path, "production operator configuration"), keys,
    "production operator configuration");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_production_operator.v1" ||
    !Array.isArray(record.reviewerAuthorityPaths) || record.reviewerAuthorityPaths.length !== 2 ||
    !Array.isArray(record.adjudicationAuthorityPaths) ||
    record.adjudicationAuthorityPaths.length !== 3 || typeof record.concurrency !== "number") {
    throw new Error("production operator configuration is invalid");
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith("Path") || key.endsWith("Root")) {absolute(String(value), key);}
    if (key.endsWith("Paths")) {for (const item of value as unknown[]) {absolute(String(item), key);}}
  }
  return record as unknown as ProductionOperatorConfiguration;
}

async function loadAuthority(path: string): Promise<AdmissionAuthority> {
  const record = exactRecord(await readJson(path, "authority"), ["keyId", "publicKeyPath"],
    "authority");
  return Object.freeze({ keyId: String(record.keyId),
    publicKeyPem: await readText(absolute(String(record.publicKeyPath), "public key"), "public key") });
}

async function assertPinnedReviewPorts(config: ProductionOperatorConfiguration,
  ports: QualityCampaignProductionPorts): Promise<void> {
  const pinned = await Promise.all(config.adjudicationAuthorityPaths.map(loadAuthority));
  const actual = [ports.review.first, ports.review.second, ports.review.resolver];
  if (canonicalJson(pinned.map(({ keyId, publicKeyPem }) => ({ keyId, publicKeyPem }))) !==
    canonicalJson(actual.map(({ authorityId: keyId, publicKeyPem }) => ({ keyId,
      publicKeyPem })))) {throw new Error("review ports are not the independently pinned authorities");}
}

function answerAttempts(questions: readonly CampaignQuestion[], campaignRootSha256: string) {
  return ([1, 2, 3] as const).flatMap((repetition) => questions.map((question) =>
    attemptIdentity({ callKind: "answer", callOrdinal: 2, campaignRootSha256,
      questionDigestSha256: question.questionDigestSha256,
      questionId: question.questionId, repetition })));
}

async function loadCleanupPlan(path: string): Promise<{ readonly protectedEvidence:
  readonly ProtectedCampaignEvidence[]; readonly targets: readonly DerivedCampaignArtifact[] }> {
  const record = exactRecord(await readJson(path, "cleanup plan"), ["protectedEvidence",
    "schemaVersion", "targets"], "cleanup plan");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup_plan.v1" ||
    !Array.isArray(record.protectedEvidence) || !Array.isArray(record.targets)) {
    throw new Error("cleanup plan is invalid");
  }
  return { protectedEvidence: record.protectedEvidence as ProtectedCampaignEvidence[],
    targets: record.targets as DerivedCampaignArtifact[] };
}

async function loadHoldout(path: string, authority: AdmissionAuthority) {
  const record = exactRecord(await readJson(path, "holdout input"), ["authorizationReceiptPath",
    "locatorDigestsPath", "mainProofPath", "questionsPath", "schemaVersion"], "holdout input");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_holdout_input.v1") {
    throw new Error("holdout input is invalid");
  }
  const receipt = verifyExternalSignedValue<HoldoutAuthorization>(await readJson(absolute(
    String(record.authorizationReceiptPath), "holdout authorization"), "holdout authorization"),
  authority.keyId, authority.publicKeyPem, "holdout authorization");
  return { authorization: receipt.payload,
    holdoutLocatorDigests: await readArray(absolute(String(record.locatorDigestsPath),
      "holdout locators"), "holdout locators") as string[],
    main: await readJson(absolute(String(record.mainProofPath), "main proof"), "main proof") as
      FrozenMainInputProof,
    questions: await readArray(absolute(String(record.questionsPath), "holdout questions"),
      "holdout questions") as CampaignQuestion[] };
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

function safeReceipt(phase: string, campaignRootSha256: string,
  values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({ campaignRootSha256, phase, ...values,
    schemaVersion: "meeting_knowledge.semantic_quality_production_safe_receipt.v1" });
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {return JSON.parse(await readText(absolute(path, label), label)) as unknown;}
  catch {throw new Error(`${label} is invalid`);}
}
async function readArray(path: string, label: string): Promise<readonly unknown[]> {
  const value = await readJson(path, label); if (!Array.isArray(value)) {throw new Error(`${label} is invalid`);}
  return value;
}
async function readText(path: string, label: string): Promise<string> {
  try {return await readFile(absolute(path, label), "utf8");}
  catch {throw new Error(`${label} is unavailable`);}
}
function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error(`${label} must be an absolute path`);}
  return resolve(path);
}
