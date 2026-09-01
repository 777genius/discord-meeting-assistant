import type { SemanticQualityV4AdjudicationPort, SemanticQualityV4RunQuestion } from
  "../src/semantic-quality-v4-runner.js";
import { runSemanticQualityV4AnswerPhase, runSemanticQualityV4RetrievalPhase } from
  "../src/semantic-quality-v4-runner.js";
import { SemanticQualityV4EncryptedArtifactStore, semanticQualityV4AttemptId,
  type SemanticQualityV4ArtifactReceipt } from
  "./semantic-quality-v4-evidence-store.js";
import type { RationalMetric, SemanticQualityV4ScoringAuthority } from
  "./semantic-quality-v4-evaluation.js";
import { evaluateSemanticQualityV4Reports } from "./semantic-quality-v4-reports.js";
import { canonicalIntegerJson, canonicalSha256 } from "./semantic-quality-v4-manifest.js";
import { evaluateSemanticQualityV4CampaignAdmission, sealSemanticQualityV4RunManifest,
  semanticQualityV4RootBindingSha256, type SemanticQualityV4ReleaseBinding,
  type SemanticQualityV4SealedRunManifest, type SemanticQualityV4SpendReservation } from
  "./semantic-quality-v4-qualification.js";
import { requireIndependentSemanticQualityV4Receipts,
  type SemanticQualityV4PinnedReviewerKey } from "./semantic-quality-v4-trusted-receipts.js";

export interface SemanticQualityV4SealedCampaignRequest {
  readonly questionReviewBinding: Readonly<Record<string, string | number>>;
  readonly repetitionCount: 3;
  readonly rootBinding: SemanticQualityV4ReleaseBinding;
  readonly rootBindingSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_campaign_request.v1";
  readonly sealedRequestSha256: string;
}

/** Provider-free legacy structural harness; never qualifying and never used by the installed CLI. */
export interface SemanticQualityV4StructuralPortSet {
  readonly createAnswer: (input: {
    readonly artifactEncryption: { readonly key: Uint8Array; readonly keyId: string };
    readonly artifactStore: SemanticQualityV4EncryptedArtifactStore;
    readonly recordArtifactReceipt: (receipt: SemanticQualityV4ArtifactReceipt) => void;
  }) => Promise<Parameters<typeof runSemanticQualityV4AnswerPhase>[0]["answer"]>;
  readonly evidence: Parameters<typeof runSemanticQualityV4RetrievalPhase>[0]["evidence"];
  readonly retrieval: Parameters<typeof runSemanticQualityV4RetrievalPhase>[0]["retrieval"];
}

export function sealSemanticQualityV4CampaignRequest(input: {
  readonly questionReviewBinding: Readonly<Record<string, string | number>>;
  readonly rootBinding: SemanticQualityV4ReleaseBinding;
}): SemanticQualityV4SealedCampaignRequest {
  const rootBindingSha256 = semanticQualityV4RootBindingSha256(input.rootBinding);
  if (canonicalSha256(input.questionReviewBinding) !== input.rootBinding.questionReviewBindingSha256) {
    throw new Error("semantic quality V4 question review binding is outside the canonical root");
  }
  const unsigned = { questionReviewBinding: input.questionReviewBinding, repetitionCount: 3 as const,
    rootBinding: input.rootBinding, rootBindingSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_campaign_request.v1" as const };
  return Object.freeze({ ...unsigned, sealedRequestSha256: canonicalSha256(unsigned) });
}

/**
 * The only real campaign executor. It has explicit fail-closed transitions and
 * cannot obtain an answer port until the complete retrieval-only phase passes.
 * This function is not called by provider-free tests or the default CLI.
 */
export async function runSemanticQualityV4RealCampaign(input: {
  readonly adjudication: SemanticQualityV4AdjudicationPort;
  readonly adjudicationReceipts: (run: SemanticQualityV4SealedRunManifest) => Promise<{
    readonly conflictReceipt?: unknown; readonly receipts: readonly unknown[] }>;
  readonly artifactEncryption: { readonly key: Uint8Array; readonly keyId: string };
  readonly artifactStoreRoot: string;
  readonly authorities: Readonly<Record<"automated" | "overall" | "real",
    SemanticQualityV4ScoringAuthority>>;
  readonly cleanup: (input: { readonly rootBindingSha256: string;
    readonly runManifestSetSha256: string; readonly retentionReceiptSha256: string }) => Promise<{
      readonly manifest: unknown; readonly receipts: readonly unknown[] }>;
  readonly pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[];
  readonly productionPorts: (repetition: 1 | 2 | 3, evidence: {
    readonly artifactEncryption: { readonly key: Uint8Array; readonly keyId: string };
    readonly artifactStore: SemanticQualityV4EncryptedArtifactStore;
    readonly recordArtifactReceipt: (receipt: SemanticQualityV4ArtifactReceipt) => void;
  }) => SemanticQualityV4StructuralPortSet;
  readonly questionReviewReceipts: readonly unknown[];
  readonly questions: readonly SemanticQualityV4RunQuestion[];
  readonly request: unknown;
  readonly reserveSpend: (reservation: Omit<SemanticQualityV4SpendReservation,
    "reservationId">) => Promise<SemanticQualityV4SpendReservation>;
  readonly retention: (input: { readonly artifactSetSha256: string;
    readonly rootBindingSha256: string; readonly runManifestSetSha256: string }) => Promise<{
      readonly binding: Readonly<Record<string, string | number>>;
      readonly receipts: readonly unknown[] }>;
}): Promise<ReturnType<typeof evaluateSemanticQualityV4CampaignAdmission>> {
  const request = decodeCampaignRequest(input.request);
  assertCanonicalQuestions(input.questions, input.authorities.overall);
  requireIndependentSemanticQualityV4Receipts({ binding: request.questionReviewBinding,
    minimum: 2, pinnedKeys: input.pinnedKeys, receipts: input.questionReviewReceipts,
    role: "question_rubric_review" });
  let artifactStore: SemanticQualityV4EncryptedArtifactStore | null = null;
  const runs: SemanticQualityV4SealedRunManifest[] = [];
  const receiptsByRepetition = {} as Record<1 | 2 | 3, {
    readonly conflictReceipt?: unknown; readonly receipts: readonly unknown[] }>;
  for (const repetition of [1, 2, 3] as const) {
    artifactStore ??= new SemanticQualityV4EncryptedArtifactStore(input.artifactStoreRoot);
    const repetitionArtifactStore = artifactStore;
    const artifactReceipts: SemanticQualityV4ArtifactReceipt[] = [];
    const recordArtifactReceipt = (receipt: SemanticQualityV4ArtifactReceipt) => {
      artifactReceipts.push(receipt);
    };
    const ports = input.productionPorts(repetition, {
      artifactEncryption: input.artifactEncryption, artifactStore: repetitionArtifactStore,
      recordArtifactReceipt });
    const retrievalOutcomes = await runSemanticQualityV4RetrievalPhase({
      canonicalQuestions: input.questions, evidence: ports.evidence,
      questions: input.questions, retrieval: ports.retrieval });
    assertRetrievalOnlyAdmission(retrievalOutcomes, input.authorities, request.rootBinding);
    const requestedReservation = Object.freeze({ logicalAnswerRequests: 240 as const,
      maximumExecutionsIncludingRepair: 480 as const,
      maximumInputBytesPerExecution: 16_000 as const,
      maximumOutputTokensPerExecution: 2_048 as const, repetition,
      rootBindingSha256: request.rootBindingSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_spend_reservation.v1" as const });
    const spendReservation = await input.reserveSpend(requestedReservation);
    assertReservationMatches(spendReservation, requestedReservation);
    const answer = await ports.createAnswer({ artifactEncryption: input.artifactEncryption,
      artifactStore: repetitionArtifactStore, recordArtifactReceipt });
    const adjudication: SemanticQualityV4AdjudicationPort = Object.freeze({
      adjudicate: async (adjudicationInput: Parameters<
        SemanticQualityV4AdjudicationPort["adjudicate"]>[0]) => {
        const attemptId = semanticQualityV4AttemptId({ questionId: adjudicationInput.queryId,
          repetition, rootBindingSha256: request.rootBindingSha256 });
        for (const [artifactKind, value] of [["evidence", adjudicationInput.evidence],
        ["answer", adjudicationInput.answer]] as const) {
          const receipt = await repetitionArtifactStore.sealCreateOnly({ artifactKind, attemptId,
            key: input.artifactEncryption.key, keyId: input.artifactEncryption.keyId,
            plaintext: new TextEncoder().encode(canonicalIntegerJson(value)),
            rootBindingSha256: request.rootBindingSha256 });
          await repetitionArtifactStore.verifyReceipt({ key: input.artifactEncryption.key, receipt });
          recordArtifactReceipt(receipt);
        }
        const result = await input.adjudication.adjudicate(adjudicationInput);
        const adjudicationReceipt = await repetitionArtifactStore.sealCreateOnly({
          artifactKind: "adjudication", attemptId, key: input.artifactEncryption.key,
          keyId: input.artifactEncryption.keyId,
          plaintext: new TextEncoder().encode(canonicalIntegerJson(result)),
          rootBindingSha256: request.rootBindingSha256 });
        await repetitionArtifactStore.verifyReceipt({ key: input.artifactEncryption.key,
          receipt: adjudicationReceipt });
        recordArtifactReceipt(adjudicationReceipt);
        return result;
      },
    });
    const outcomes = await runSemanticQualityV4AnswerPhase({ adjudication, answer,
      retrievalOutcomes });
    const reports = evaluateSemanticQualityV4Reports({ authorities: input.authorities, outcomes });
    const run = sealSemanticQualityV4RunManifest({
      artifactReceipts, artifactSetSha256: canonicalSha256(artifactReceipts), metricReports: reports,
      outcomes, repetition, rootBinding: request.rootBinding, spendReservation });
    runs.push(run);
    receiptsByRepetition[repetition] = await input.adjudicationReceipts(run);
  }
  const runManifestSetSha256 = canonicalSha256(runs.map(({ repetition, runManifestSha256 }) =>
    ({ repetition, runManifestSha256 })));
  const campaignArtifactSetSha256 = canonicalSha256(runs.map(
      ({ artifactSetSha256: runArtifactSetSha256, repetition }) =>
      ({ artifactSetSha256: runArtifactSetSha256, repetition })));
  if (artifactStore === null) {throw new Error("semantic quality V4 artifact store is absent");}
  for (const run of runs) {for (const receipt of run.artifactReceipts) {
    await artifactStore.verifyReceipt({ key: input.artifactEncryption.key, receipt });
  }}
  const retention = await input.retention({ artifactSetSha256: campaignArtifactSetSha256,
    rootBindingSha256: request.rootBindingSha256, runManifestSetSha256 });
  const verifiedRetention = requireIndependentSemanticQualityV4Receipts({
    binding: retention.binding, minimum: 1, pinnedKeys: input.pinnedKeys,
    receipts: retention.receipts, role: "artifact_retention" });
  const retentionReceiptSha256 = canonicalSha256(verifiedRetention.map(
    ({ digestSha256 }) => digestSha256));
  const cleanup = await input.cleanup({ rootBindingSha256: request.rootBindingSha256,
    runManifestSetSha256, retentionReceiptSha256 });
  return evaluateSemanticQualityV4CampaignAdmission({
    adjudicationReceiptsByRepetition: receiptsByRepetition, authorities: input.authorities,
    cleanupManifest: cleanup.manifest, cleanupReceipts: cleanup.receipts,
    pinnedKeys: input.pinnedKeys, questionReviewBinding: request.questionReviewBinding,
    questionReviewReceipts: input.questionReviewReceipts, retentionBinding: retention.binding,
    retentionReceipts: retention.receipts, runs });
}

function decodeCampaignRequest(value: unknown): SemanticQualityV4SealedCampaignRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("semantic quality V4 campaign request is unsealed");
  }
  const request = value as unknown as SemanticQualityV4SealedCampaignRequest;
  const runtimeRequest = value as Record<string, unknown>;
  const keys = ["questionReviewBinding", "repetitionCount", "rootBinding",
    "rootBindingSha256", "schemaVersion", "sealedRequestSha256"];
  const { sealedRequestSha256, ...unsigned } = request;
  if (canonicalIntegerJson(Object.keys(value).toSorted()) !== canonicalIntegerJson(keys) ||
    runtimeRequest.schemaVersion !== "meeting_knowledge.semantic_quality_campaign_request.v1" ||
    runtimeRequest.repetitionCount !== 3 ||
    semanticQualityV4RootBindingSha256(request.rootBinding) !== request.rootBindingSha256 ||
    canonicalSha256(request.questionReviewBinding) !== request.rootBinding.questionReviewBindingSha256 ||
    canonicalSha256(unsigned) !== sealedRequestSha256) {
    throw new Error("semantic quality V4 campaign request is unsealed or drifted");
  }
  return Object.freeze(request);
}

function assertRetrievalOnlyAdmission(outcomes: Awaited<ReturnType<
  typeof runSemanticQualityV4RetrievalPhase>>, authorities: Readonly<Record<
    "automated" | "overall" | "real", SemanticQualityV4ScoringAuthority>>,
  rootBinding: SemanticQualityV4ReleaseBinding): void {
  if (outcomes.some(({ retrieval }) => retrieval.capabilitySha256 !==
      rootBinding.capabilityBytesSha256) || canonicalSha256(outcomes.map(({ queryId, retrieval }) =>
    ({ queryId, requestSnapshotSha256: retrieval.requestSnapshotSha256 }))) !==
      rootBinding.requestSnapshotSha256) {
    throw new Error("semantic quality V4 capability/request observations differ from sealed root");
  }
  for (const authority of Object.values(authorities)) {
    const questionIds = new Set(authority.questions.map(({ id }) => id));
    const subset = outcomes.filter(({ queryId }) => questionIds.has(queryId));
    const outcomeById = new Map(subset.map((outcome) => [outcome.queryId, outcome]));
    const canonicalTurns = new Map(authority.canonicalTurns.map((turn) => [turn.turnId, turn]));
    const forbidden = new Set(authority.globallyForbiddenLocatorIds);
    const known = new Set(authority.knownLocatorIds);
    const groups = new Map<string, { blockHits5: number; blockTotal: number;
      completeHits5: number; mrrScaledSum: number; questionTotal: number }>();
    const retrievalLatencies: number[] = [];
    for (const question of authority.questions) {
      const outcome = outcomeById.get(question.id);
      if (outcome === undefined || outcome.retrieval.status !== "completed" ||
        outcome.evidenceBytes > 16_000) {
        throw new Error("semantic quality V4 retrieval-only execution gate failed");
      }
      const retrieved = [...outcome.retrieval.rankedSeedLocators,
        ...outcome.retrieval.expandedNeighborLocators].map(({ locatorId }) => locatorId);
      retrievalLatencies.push(outcome.retrieval.capabilityAndRetrievalLatencyUs);
      if (retrieved.some((locatorId) => forbidden.has(locatorId) || !known.has(locatorId)) ||
        outcome.locallyRehydratedEvidence.some((turn) => {
          const canonical = canonicalTurns.get(turn.turnId);
          return canonical === undefined || canonical.speakerId !== turn.speakerId ||
            canonical.startMs !== turn.startMs || canonical.endMs !== turn.endMs ||
            canonical.text !== turn.text;
        })) {throw new Error("semantic quality V4 retrieval-only authority/leakage gate failed");}
      if (question.kind !== "answerable") {continue;}
      for (const groupId of ["overall", `locale:${question.locale}`]) {
        const counter = groups.get(groupId) ?? { blockHits5: 0, blockTotal: 0,
          completeHits5: 0, mrrScaledSum: 0, questionTotal: 0 };
        const gold = new Set(question.goldLocatorRelevance.map(({ locatorId }) => locatorId));
        const top5 = outcome.retrieval.rankedSeedLocators.slice(0, 5)
          .map(({ locatorId }) => locatorId);
        counter.blockHits5 += [...gold].filter((locator) => top5.includes(locator)).length;
        counter.blockTotal += gold.size;
        counter.completeHits5 += [...gold].every((locator) => top5.includes(locator)) ? 1 : 0;
        const firstRelevantRank = outcome.retrieval.rankedSeedLocators.findIndex(
          ({ locatorId }) => gold.has(locatorId));
        counter.mrrScaledSum += firstRelevantRank < 0 ? 0 :
          Math.floor(2520 / (firstRelevantRank + 1));
        counter.questionTotal += 1;
        groups.set(groupId, counter);
      }
    }
    for (const counter of groups.values()) {
      if (!atLeastNineTenths({ numerator: counter.blockHits5,
        denominator: counter.blockTotal }) || !atLeastNineTenths({
        numerator: counter.completeHits5, denominator: counter.questionTotal }) ||
        counter.mrrScaledSum * 10 < counter.questionTotal * 2520 * 8) {
        throw new Error("semantic quality V4 retrieval-only recall gate failed");
      }
    }
    const sortedLatencies = retrievalLatencies.toSorted((left, right) => left - right);
    const p95 = sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1];
    if (p95 === undefined || p95 > 3_000_000) {
      throw new Error("semantic quality V4 retrieval-only latency gate failed");
    }
  }
}

function atLeastNineTenths(value: RationalMetric): boolean {
  return value.denominator > 0 && value.numerator * 10 >= value.denominator * 9;
}

function assertCanonicalQuestions(questions: readonly SemanticQualityV4RunQuestion[],
  authority: SemanticQualityV4ScoringAuthority): void {
  const canonical = new Map(authority.questions.map((question) => [question.id,
    question.evaluationQuestionText ?? question.question]));
  if (questions.length !== 240 || canonical.size !== 240 || questions.some((question) =>
    canonical.get(question.id) !== question.question)) {
    throw new Error("semantic quality V4 campaign question set is not canonical");
  }
}

function assertReservationMatches(actual: SemanticQualityV4SpendReservation,
  expected: Omit<SemanticQualityV4SpendReservation, "reservationId">): void {
  const { reservationId, ...withoutId } = actual;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(reservationId) ||
    canonicalIntegerJson(withoutId) !== canonicalIntegerJson(expected)) {
    throw new Error("semantic quality V4 bounded spend reservation was not granted exactly");
  }
}
