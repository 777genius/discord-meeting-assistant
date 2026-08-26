import type { SemanticQualityV4RunnerOutcome } from "../src/semantic-quality-v4-runner.js";
import { evaluateV4Thresholds,
  type SemanticQualityV4MetricReports, type SemanticQualityV4ScoringAuthority } from
  "./semantic-quality-v4-evaluation.js";
import { evaluateSemanticQualityV4Reports } from "./semantic-quality-v4-reports.js";
import { canonicalIntegerJson, canonicalSha256, v4Thresholds } from
  "./semantic-quality-v4-manifest.js";
import { semanticQualityV4AttemptId, validateSemanticQualityV4ArtifactReceipt,
  type SemanticQualityV4ArtifactReceipt } from "./semantic-quality-v4-evidence-store.js";
import { validateV4OutcomeShape } from "./semantic-quality-v4-outcome-validation.js";
import { requireIndependentSemanticQualityV4Receipts,
  requireSemanticQualityV4AdjudicationReceipts,
  semanticQualityV4ReviewerKeyRegistrySha256,
  type SemanticQualityV4PinnedReviewerKey } from "./semantic-quality-v4-trusted-receipts.js";

export interface SemanticQualityV4ReleaseBinding {
  readonly answerModelConfigurationSha256: string;
  readonly answerPolicySha256: string;
  readonly automatedCorpusSha256: string;
  readonly automatedQuestionSetSha256: string;
  readonly capabilityBytesSha256: string;
  readonly capabilityFingerprintSha256: string;
  readonly discordRuntimeModuleSha256: string;
  readonly discordSourceCommit: string;
  readonly discordSourceTree: string;
  readonly executionObservationSha256: string;
  readonly indexProfileSha256: string;
  readonly infinityServiceImageSha256: string;
  readonly infinitySourceCommit: string;
  readonly infinitySourceTree: string;
  readonly locatorAuthoritySha256: string;
  readonly privateCorpusSha256: string;
  readonly privateInputSha256: string;
  readonly privateQuestionSetSha256: string;
  readonly promptMapperSha256: string;
  readonly questionReviewBindingSha256: string;
  readonly requestSnapshotSha256: string;
  readonly reviewerKeyRegistrySha256: string;
  readonly rubricSha256: string;
  readonly runtimeArtifactSha256: string;
  readonly sdkPackageSha256: string;
  readonly sdkPackageSriSha512: string;
  readonly tokenizerSha256: string;
  readonly thresholdProfileSha256: string;
  readonly trustAnchorSha256: string;
  readonly turnToBlockMappingSha256: string;
  readonly verifierModuleSetSha256: string;
}

export interface SemanticQualityV4SpendReservation {
  readonly logicalAnswerRequests: 240;
  readonly maximumExecutionsIncludingRepair: 480;
  readonly maximumInputBytesPerExecution: 16000;
  readonly maximumOutputTokensPerExecution: 2048;
  readonly repetition: 1 | 2 | 3;
  readonly reservationId: string;
  readonly rootBindingSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_spend_reservation.v1";
}

export interface SemanticQualityV4SealedRunManifest {
  readonly artifactReceipts: readonly SemanticQualityV4ArtifactReceipt[];
  readonly artifactSetSha256: string;
  readonly metricReportsSha256: string;
  readonly outcomes: readonly SemanticQualityV4RunnerOutcome[];
  readonly repetition: 1 | 2 | 3;
  readonly rootBinding: SemanticQualityV4ReleaseBinding;
  readonly rootBindingSha256: string;
  readonly runManifestSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_run_manifest.v1";
  readonly spendReservation: SemanticQualityV4SpendReservation;
}

export type SemanticQualityV4QualificationBlocker =
  | "cleanup_receipt" | "independent_adjudication" | "question_review_receipts"
  | "release_binding_drift" | "repetitions" | "retention_receipt" | "threshold_failure";

export function semanticQualityV4RootBindingSha256(binding: SemanticQualityV4ReleaseBinding): string {
  assertReleaseBinding(binding);
  return canonicalSha256({ binding,
    schemaVersion: "meeting_knowledge.semantic_quality_root_binding.v1" });
}

export function semanticQualityV4ThresholdProfileSha256(): string {
  return canonicalSha256({ applicability: {
    automated: { automatedRetrievalStrata: true, locales: ["en", "mixed", "ru"] },
    overall: { automatedRetrievalStrata: false, locales: ["en", "mixed", "ru"] },
    real: { automatedRetrievalStrata: false, locales: ["en", "ru"] } },
  schemaVersion: "meeting_knowledge.semantic_quality_threshold_profile.v2", v4Thresholds });
}

export function semanticQualityV4LocatorAuthoritySha256(authorities: Readonly<Record<
  "automated" | "overall" | "real", SemanticQualityV4ScoringAuthority>>): string {
  return canonicalSha256(Object.fromEntries(Object.entries(authorities).map(([name, authority]) =>
    [name, { canonicalTurns: authority.canonicalTurns,
      globallyForbiddenLocatorIds: [...authority.globallyForbiddenLocatorIds].toSorted(),
      knownLocatorIds: [...authority.knownLocatorIds].toSorted(),
      wholeTranscriptTurnIdsByQuestionId: authority.wholeTranscriptTurnIdsByQuestionId }] )));
}

export function semanticQualityV4TurnToBlockMappingSha256(authorities: Readonly<Record<
  "automated" | "overall" | "real", SemanticQualityV4ScoringAuthority>>): string {
  return canonicalSha256(Object.fromEntries(Object.entries(authorities).map(([name, authority]) =>
    [name, authority.questions.map(({ goldLocatorRelevance, id }) =>
      ({ goldLocatorRelevance, id }))] )));
}

export function sealSemanticQualityV4RunManifest(input: {
  readonly artifactReceipts: readonly unknown[];
  readonly artifactSetSha256: string;
  readonly metricReports: SemanticQualityV4MetricReports;
  readonly outcomes: readonly SemanticQualityV4RunnerOutcome[];
  readonly repetition: 1 | 2 | 3;
  readonly rootBinding: SemanticQualityV4ReleaseBinding;
  readonly spendReservation: SemanticQualityV4SpendReservation;
}): SemanticQualityV4SealedRunManifest {
  const rootBindingSha256 = semanticQualityV4RootBindingSha256(input.rootBinding);
  assertDigest(input.artifactSetSha256, "artifact set");
  assertSpendReservation(input.spendReservation, rootBindingSha256, input.repetition);
  const outcomes = input.outcomes.map((outcome) => validateV4OutcomeShape(outcome));
  if (outcomes.length !== 240) {throw new Error("semantic quality V4 run requires 240 outcomes");}
  assertAttemptBindings(outcomes, rootBindingSha256, input.repetition);
  assertObservedRootBindings(outcomes, input.rootBinding);
  const artifactReceipts = input.artifactReceipts.map(validateSemanticQualityV4ArtifactReceipt);
  assertSemanticQualityV4ArtifactReceiptCoverage(artifactReceipts, outcomes, rootBindingSha256);
  if (canonicalSha256(artifactReceipts) !== input.artifactSetSha256) {
    throw new Error("semantic quality V4 artifact set differs from authenticated receipts");
  }
  const unsigned = Object.freeze({ artifactReceipts: Object.freeze(artifactReceipts),
    artifactSetSha256: input.artifactSetSha256,
    metricReportsSha256: canonicalSha256(input.metricReports), outcomes: Object.freeze(outcomes),
    repetition: input.repetition, rootBinding: input.rootBinding, rootBindingSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_run_manifest.v1" as const,
    spendReservation: input.spendReservation });
  return Object.freeze({ ...unsigned, runManifestSha256: canonicalSha256(unsigned) });
}

/** Decodes only the versioned exact schema and recomputes every internal digest. */
export function decodeSemanticQualityV4RunManifest(value: unknown):
SemanticQualityV4SealedRunManifest {
  const record = exactRecord(value, ["artifactReceipts", "artifactSetSha256", "metricReportsSha256", "outcomes",
    "repetition", "rootBinding", "rootBindingSha256", "runManifestSha256", "schemaVersion",
    "spendReservation"]);
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_run_manifest.v1" ||
    !Array.isArray(record.outcomes) || !Array.isArray(record.artifactReceipts) ||
    (record.repetition !== 1 && record.repetition !== 2 && record.repetition !== 3)) {
    throw new Error("semantic quality V4 sealed run manifest schema is invalid");
  }
  const rootBinding = record.rootBinding as SemanticQualityV4ReleaseBinding;
  const rootBindingSha256 = semanticQualityV4RootBindingSha256(rootBinding);
  if (record.rootBindingSha256 !== rootBindingSha256) {
    throw new Error("semantic quality V4 sealed run root binding is invalid");
  }
  const spendReservation = decodeSpendReservation(record.spendReservation);
  assertSpendReservation(spendReservation, rootBindingSha256, record.repetition);
  const outcomes = record.outcomes.map(validateV4OutcomeShape);
  if (outcomes.length !== 240 || typeof record.artifactSetSha256 !== "string" ||
    typeof record.metricReportsSha256 !== "string" || typeof record.runManifestSha256 !== "string") {
    throw new Error("semantic quality V4 sealed run manifest is incomplete");
  }
  const repetition = record.repetition;
  assertDigest(record.artifactSetSha256, "artifact set");
  assertAttemptBindings(outcomes, rootBindingSha256, repetition);
  assertObservedRootBindings(outcomes, rootBinding);
  const artifactReceipts = record.artifactReceipts.map(validateSemanticQualityV4ArtifactReceipt);
  assertSemanticQualityV4ArtifactReceiptCoverage(artifactReceipts, outcomes, rootBindingSha256);
  if (canonicalSha256(artifactReceipts) !== record.artifactSetSha256) {
    throw new Error("semantic quality V4 artifact set differs from authenticated receipts");
  }
  assertDigest(record.metricReportsSha256, "metric reports");
  const unsigned = { artifactReceipts, artifactSetSha256: record.artifactSetSha256,
    metricReportsSha256: record.metricReportsSha256, outcomes, repetition: record.repetition,
    rootBinding, rootBindingSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_run_manifest.v1" as const,
    spendReservation };
  if (canonicalSha256(unsigned) !== record.runManifestSha256) {
    throw new Error("semantic quality V4 sealed run manifest digest is invalid");
  }
  return Object.freeze({ ...unsigned, repetition,
    runManifestSha256: record.runManifestSha256 });
}

/** Admission derives metrics, thresholds, bindings, and receipt schemas locally. */
export function evaluateSemanticQualityV4CampaignAdmission(input: {
  readonly adjudicationReceiptsByRepetition: Readonly<Record<1 | 2 | 3, {
    readonly conflictReceipt?: unknown; readonly receipts: readonly unknown[] }>>;
  readonly authorities: Readonly<Record<"automated" | "overall" | "real",
    SemanticQualityV4ScoringAuthority>>;
  readonly cleanupManifest: unknown;
  readonly cleanupReceipts: readonly unknown[];
  readonly pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[];
  readonly questionReviewBinding: Readonly<Record<string, string | number>>;
  readonly questionReviewReceipts: readonly unknown[];
  readonly retentionBinding: Readonly<Record<string, string | number>>;
  readonly retentionReceipts: readonly unknown[];
  readonly runs: readonly unknown[];
}): { readonly blockers: readonly SemanticQualityV4QualificationBlocker[];
  readonly reports: readonly SemanticQualityV4MetricReports[];
  readonly status: "admitted" | "blocked" } {
  const blockers = new Set<SemanticQualityV4QualificationBlocker>();
  const runs: SemanticQualityV4SealedRunManifest[] = [];
  try {runs.push(...input.runs.map(decodeSemanticQualityV4RunManifest));}
  catch {blockers.add("release_binding_drift");}
  const repetitions = new Set(runs.map(({ repetition }) => repetition));
  if (runs.length !== 3 || repetitions.size !== 3 ||
    ![1, 2, 3].every((value) => repetitions.has(value as 1 | 2 | 3))) {
    blockers.add("repetitions");
  }
  const roots = new Set(runs.map(({ rootBindingSha256 }) => rootBindingSha256));
  if (roots.size !== 1) {blockers.add("release_binding_drift");}
  if (!validSealedScoringAuthority(runs[0]?.rootBinding, input.authorities,
    input.pinnedKeys)) {blockers.add("release_binding_drift");}
  const reports: SemanticQualityV4MetricReports[] = [];
  for (const run of runs) {
    try {
      const report = evaluateSemanticQualityV4Reports({ authorities: input.authorities,
        outcomes: run.outcomes });
      if (canonicalSha256(report) !== run.metricReportsSha256) {throw new Error("report drift");}
      reports.push(report);
      const decisions = [evaluateV4Thresholds(report.overall,
        { automatedRetrievalStrata: false, locales: ["en", "ru", "mixed"] }),
      evaluateV4Thresholds(report.automated,
        { automatedRetrievalStrata: true, locales: ["en", "ru", "mixed"] }),
      evaluateV4Thresholds(report.real,
        { automatedRetrievalStrata: false, locales: ["en", "ru"] })];
      if (decisions.some(({ passed }) => !passed)) {blockers.add("threshold_failure");}
      const binding = semanticQualityV4AdjudicationBinding(run);
      const receiptSet = input.adjudicationReceiptsByRepetition[run.repetition];
      requireSemanticQualityV4AdjudicationReceipts({ binding,
        ...(receiptSet.conflictReceipt === undefined ? {} :
          { conflictReceipt: receiptSet.conflictReceipt }), pinnedKeys: input.pinnedKeys,
        receipts: receiptSet.receipts });
    } catch {blockers.add("independent_adjudication");}
  }
  if (!validQuestionReviewAuthority({ binding: input.questionReviewBinding,
    pinnedKeys: input.pinnedKeys, receipts: input.questionReviewReceipts,
    root: runs[0]?.rootBinding })) {blockers.add("question_review_receipts");}
  const runManifestSetSha256 = canonicalSha256(runs.map(({ repetition, runManifestSha256 }) =>
    ({ repetition, runManifestSha256 })).toSorted((a, b) => a.repetition - b.repetition));
  let retentionReceiptSha256: string | null = null;
  try {
    requireExactBindingKeys(input.retentionBinding, ["artifactSetSha256", "policySha256",
      "retainUntilEpochSeconds", "rootBindingSha256", "runManifestSetSha256"]);
    if (input.retentionBinding.rootBindingSha256 !== runs[0]?.rootBindingSha256 ||
      input.retentionBinding.runManifestSetSha256 !== runManifestSetSha256 ||
      input.retentionBinding.artifactSetSha256 !== canonicalSha256(runs.map(
        ({ artifactSetSha256, repetition }) => ({ artifactSetSha256, repetition })))) {
      throw new Error("retention binding");
    }
    const verified = requireIndependentSemanticQualityV4Receipts({
      binding: input.retentionBinding, minimum: 1,
      pinnedKeys: input.pinnedKeys, receipts: input.retentionReceipts,
      role: "artifact_retention" });
    retentionReceiptSha256 = canonicalSha256(verified.map(({ digestSha256 }) => digestSha256));
  } catch {blockers.add("retention_receipt");}
  try {
    const cleanup = exactRecord(input.cleanupManifest, ["canonicalAuthorityAbsenceProofSha256",
      "derivedInfinityDeletionReceiptSha256", "retentionReceiptSha256", "rootBindingSha256",
      "runManifestSetSha256", "schemaVersion"]);
    if (cleanup.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup.v1" ||
      cleanup.rootBindingSha256 !== runs[0]?.rootBindingSha256 ||
      cleanup.runManifestSetSha256 !== runManifestSetSha256) {throw new Error("cleanup");}
    if (cleanup.retentionReceiptSha256 !== retentionReceiptSha256) {
      throw new Error("cleanup retention binding");
    }
    if ([cleanup.canonicalAuthorityAbsenceProofSha256,
      cleanup.derivedInfinityDeletionReceiptSha256, cleanup.rootBindingSha256]
      .some((value) => typeof value !== "string")) {throw new Error("cleanup digest");}
    const binding: Readonly<Record<string, string | number>> = {
      canonicalAuthorityAbsenceProofSha256:
        cleanup.canonicalAuthorityAbsenceProofSha256 as string,
      derivedInfinityDeletionReceiptSha256:
        cleanup.derivedInfinityDeletionReceiptSha256 as string,
      rootBindingSha256: cleanup.rootBindingSha256 as string, runManifestSetSha256 };
    requireExactBindingKeys(binding, ["canonicalAuthorityAbsenceProofSha256",
      "derivedInfinityDeletionReceiptSha256", "rootBindingSha256", "runManifestSetSha256"]);
    requireIndependentSemanticQualityV4Receipts({ binding, minimum: 1,
      pinnedKeys: input.pinnedKeys, receipts: input.cleanupReceipts, role: "derived_cleanup" });
  } catch {blockers.add("cleanup_receipt");}
  const values = [...blockers].toSorted();
  return Object.freeze({ blockers: Object.freeze(values), reports: Object.freeze(reports),
    status: values.length === 0 ? "admitted" : "blocked" });
}

export function semanticQualityV4AdjudicationBinding(run: SemanticQualityV4SealedRunManifest) {
  return Object.freeze({ adjudicationSha256: canonicalSha256(run.outcomes.map((outcome) =>
    ({ adjudications: outcome.adjudications, citationEntailments: outcome.citationEntailments }))),
  answerSha256: canonicalSha256(run.outcomes.map(({ answer, answerMeasurement }) =>
    ({ answer, answerMeasurement }))), evidenceSha256: canonicalSha256(run.outcomes.map(
    ({ locallyRehydratedEvidence }) => locallyRehydratedEvidence)),
  questionSetSha256: canonicalSha256(run.outcomes.map(({ queryId, questionDigestSha256 }) =>
    ({ queryId, questionDigestSha256 }))), repetition: run.repetition,
  rootBindingSha256: run.rootBindingSha256, rubricSha256: run.rootBinding.rubricSha256,
  runManifestSha256: run.runManifestSha256 });
}

function assertReleaseBinding(value: SemanticQualityV4ReleaseBinding): void {
  const keys = ["answerModelConfigurationSha256", "answerPolicySha256", "automatedCorpusSha256",
    "automatedQuestionSetSha256", "capabilityBytesSha256", "capabilityFingerprintSha256",
    "discordRuntimeModuleSha256", "discordSourceCommit", "discordSourceTree",
    "executionObservationSha256", "indexProfileSha256",
    "infinityServiceImageSha256", "infinitySourceCommit", "infinitySourceTree",
    "locatorAuthoritySha256", "privateCorpusSha256", "privateInputSha256", "privateQuestionSetSha256",
    "promptMapperSha256", "questionReviewBindingSha256", "requestSnapshotSha256",
    "reviewerKeyRegistrySha256", "rubricSha256", "runtimeArtifactSha256", "sdkPackageSha256",
    "sdkPackageSriSha512", "tokenizerSha256", "thresholdProfileSha256", "trustAnchorSha256",
    "turnToBlockMappingSha256", "verifierModuleSetSha256"];
  requireExactBindingKeys(value as unknown as Readonly<Record<string, string | number>>, keys);
  for (const [key, item] of Object.entries(value as unknown as Record<string, string>)) {
    if (key === "sdkPackageSriSha512") {
      const payload = item.slice("sha512-".length).replaceAll("=", "");
      if (!/^sha512-[A-Za-z0-9+/]{80,}={0,2}$/u.test(item) ||
        new Set(payload).size < 4) {throw new Error("SRI");}
    } else if (key.endsWith("Commit") || key.endsWith("Tree")) {
      if (!/^[a-f0-9]{40}$/u.test(item) || /^([a-f0-9])\1{39}$/u.test(item)) {
        throw new Error("revision");
      }
    } else {assertDigest(item, key);}
  }
}

function decodeSpendReservation(value: unknown): SemanticQualityV4SpendReservation {
  const record = exactRecord(value, ["logicalAnswerRequests", "maximumExecutionsIncludingRepair",
    "maximumInputBytesPerExecution", "maximumOutputTokensPerExecution", "repetition",
    "reservationId", "rootBindingSha256", "schemaVersion"]);
  return record as unknown as SemanticQualityV4SpendReservation;
}

function assertSpendReservation(value: SemanticQualityV4SpendReservation,
  rootBindingSha256: string, repetition: number): void {
  const candidate = value as unknown as Record<string, unknown>;
  if (candidate.schemaVersion !== "meeting_knowledge.semantic_quality_spend_reservation.v1" ||
    candidate.logicalAnswerRequests !== 240 || candidate.maximumExecutionsIncludingRepair !== 480 ||
    candidate.maximumInputBytesPerExecution !== 16_000 ||
    candidate.maximumOutputTokensPerExecution !== 2_048 || candidate.repetition !== repetition ||
    candidate.rootBindingSha256 !== rootBindingSha256 ||
    typeof candidate.reservationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate.reservationId)) {
    throw new Error("semantic quality V4 spend reservation is invalid");
  }
}

function requireExactBindingKeys(value: Readonly<Record<string, string | number>>,
  keys: readonly string[]): void {
  const candidate: unknown = value;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    canonicalIntegerJson(Object.keys(value).toSorted()) !== canonicalIntegerJson([...keys].toSorted())) {
    throw new Error("semantic quality V4 binding schema is invalid");
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "repetition" || key === "retainUntilEpochSeconds") {
      if (!Number.isSafeInteger(item) || (item as number) < 1) {throw new Error("integer");}
    } else if (typeof item !== "string") {throw new Error("string");}
    else if (key.endsWith("Sha256")) {assertDigest(item, key);}
  }
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value) || /^([a-f0-9])\1{63}$/u.test(value)) {
    throw new Error(`semantic quality V4 ${label} digest is a placeholder or invalid`);
  }
}

function assertAttemptBindings(outcomes: readonly SemanticQualityV4RunnerOutcome[],
  rootBindingSha256: string, repetition: 1 | 2 | 3): void {
  if (outcomes.some((outcome) => outcome.answerMeasurement.attemptId !==
    semanticQualityV4AttemptId({ questionId: outcome.queryId, repetition,
      rootBindingSha256 }))) {
    throw new Error("semantic quality V4 run contains an unrelated runtime attempt");
  }
}

function assertObservedRootBindings(outcomes: readonly SemanticQualityV4RunnerOutcome[],
  root: SemanticQualityV4ReleaseBinding): void {
  if (outcomes.some((outcome) => outcome.adjudicationKind !== "external_independent" ||
      outcome.retrieval.capabilitySha256 !== root.capabilityBytesSha256) ||
    canonicalSha256(outcomes.map(({ queryId, retrieval }) =>
      ({ queryId, requestSnapshotSha256: retrieval.requestSnapshotSha256 }))) !==
      root.requestSnapshotSha256) {
    throw new Error("semantic quality V4 observed runtime artifacts differ from sealed root");
  }
}

export function assertSemanticQualityV4ArtifactReceiptCoverage(
  receipts: readonly SemanticQualityV4ArtifactReceipt[],
  outcomes: readonly SemanticQualityV4RunnerOutcome[], rootBindingSha256: string): void {
  const byAttempt = Map.groupBy(receipts, ({ attemptId }) => attemptId);
  if (receipts.some((receipt) => receipt.rootBindingSha256 !== rootBindingSha256) ||
    outcomes.some((outcome) => {
      const attemptReceipts = byAttempt.get(outcome.answerMeasurement.attemptId) ?? [];
      const kinds = new Set(attemptReceipts.map(({ artifactKind }) => artifactKind));
      const repairExpected = outcome.answerMeasurement.repairProviderRequestSha256 !== null;
      const originalRequestReceipt = attemptReceipts.find(({ artifactKind }) =>
        artifactKind === "original_provider_request");
      const originalResponseReceipt = attemptReceipts.find(({ artifactKind }) =>
        artifactKind === "original_provider_response");
      const expectedKinds: SemanticQualityV4ArtifactReceipt["artifactKind"][] =
        ["retrieval_request", "retrieval_response", "original_model_input",
        "repair_model_input", "original_provider_request", "original_provider_response",
        "response_runtime", "evidence", "answer", "adjudication",
        ...(repairExpected ? ["repair_provider_request" as const,
          "repair_provider_response" as const] : [])];
      return attemptReceipts.length !== expectedKinds.length || kinds.size !== expectedKinds.length ||
        !expectedKinds.every((kind) => kinds.has(kind)) ||
        !providerExchangeBindingsAreValid(attemptReceipts, repairExpected) ||
        attemptReceipts.find(({ artifactKind }) => artifactKind === "retrieval_request")
          ?.plaintextSha256 !== outcome.retrieval.requestSha256 ||
        attemptReceipts.find(({ artifactKind }) => artifactKind === "retrieval_response")
          ?.plaintextSha256 !== outcome.retrieval.responseSha256 ||
        attemptReceipts.find(({ artifactKind }) => artifactKind === "original_model_input")
          ?.plaintextSha256 !== outcome.answerMeasurement.originalModelInputSha256 ||
        attemptReceipts.find(({ artifactKind }) => artifactKind === "repair_model_input")
          ?.plaintextSha256 !== outcome.answerMeasurement.repairModelInputSha256 ||
        attemptReceipts.find(({ artifactKind }) => artifactKind === "response_runtime")
          ?.plaintextSha256 !== outcome.answerMeasurement.responseRuntimeArtifactSha256 ||
        originalRequestReceipt?.plaintextSha256 !==
          outcome.answerMeasurement.originalProviderRequestSha256 ||
        originalResponseReceipt?.plaintextSha256 !==
          outcome.answerMeasurement.originalProviderResponseSha256 ||
        (repairExpected && (attemptReceipts.find(({ artifactKind }) =>
          artifactKind === "repair_provider_request")?.plaintextSha256 !==
            outcome.answerMeasurement.repairProviderRequestSha256 ||
          attemptReceipts.find(({ artifactKind }) => artifactKind === "repair_provider_response")
            ?.plaintextSha256 !== outcome.answerMeasurement.repairProviderResponseSha256));
    }) || receipts.length !== outcomes.reduce((total, outcome) => total +
      (outcome.answerMeasurement.repairProviderRequestSha256 === null ? 10 : 12), 0)) {
    throw new Error("semantic quality V4 authenticated artifact coverage is incomplete");
  }
}

function providerExchangeBindingsAreValid(
  receipts: readonly SemanticQualityV4ArtifactReceipt[],
  repairExpected: boolean,
): boolean {
  const binding = (kind: SemanticQualityV4ArtifactReceipt["artifactKind"]) =>
    receipts.find(({ artifactKind }) => artifactKind === kind)?.exchangeBindingSha256;
  const original = binding("original_provider_request");
  const repair = binding("repair_provider_request");
  const retrieval = binding("retrieval_request");
  return retrieval !== undefined && retrieval === binding("retrieval_response") &&
    retrieval !== original && retrieval !== repair && original !== undefined &&
    original === binding("original_provider_response") &&
    (!repairExpected || (repair !== undefined && repair === binding("repair_provider_response") &&
      repair !== original));
}

function validSealedScoringAuthority(root: SemanticQualityV4ReleaseBinding | undefined,
  authorities: Readonly<Record<"automated" | "overall" | "real",
    SemanticQualityV4ScoringAuthority>>,
  pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[]): boolean {
  try {
    return root !== undefined && root.reviewerKeyRegistrySha256 ===
      semanticQualityV4ReviewerKeyRegistrySha256(pinnedKeys) &&
      root.thresholdProfileSha256 === semanticQualityV4ThresholdProfileSha256() &&
      root.locatorAuthoritySha256 === semanticQualityV4LocatorAuthoritySha256(authorities) &&
      root.turnToBlockMappingSha256 === semanticQualityV4TurnToBlockMappingSha256(authorities);
  } catch {return false;}
}

function validQuestionReviewAuthority(input: {
  readonly binding: Readonly<Record<string, string | number>>;
  readonly pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[];
  readonly receipts: readonly unknown[];
  readonly root: SemanticQualityV4ReleaseBinding | undefined;
}): boolean {
  try {
    requireExactBindingKeys(input.binding, ["corpusSha256", "declaredTranscriptSha256",
      "inputSha256", "questionFileSha256", "questionSetSha256", "rubricFileSha256",
      "rubricSha256", "transcriptFileSha256"]);
    const root = input.root;
    if (root === undefined || canonicalSha256(input.binding) !== root.questionReviewBindingSha256 ||
      root.privateCorpusSha256 !== input.binding.corpusSha256 ||
      root.privateInputSha256 !== input.binding.inputSha256 ||
      root.privateQuestionSetSha256 !== input.binding.questionSetSha256 ||
      root.rubricSha256 !== input.binding.rubricSha256) {return false;}
    requireIndependentSemanticQualityV4Receipts({ binding: input.binding, minimum: 2,
      pinnedKeys: input.pinnedKeys, receipts: input.receipts, role: "question_rubric_review" });
    return true;
  } catch {return false;}
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonicalIntegerJson(Object.keys(value).toSorted()) !== canonicalIntegerJson([...keys].toSorted())) {
    throw new Error("semantic quality V4 sealed object shape is invalid");
  }
  return value as Record<string, unknown>;
}
