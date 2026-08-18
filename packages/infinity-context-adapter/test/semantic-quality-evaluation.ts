import { createHash } from "node:crypto";

import { INFINITY_CONTEXT_SDK_PROVENANCE } from "../src/index.js";
import {
  semanticQualityCorpusDigest,
  semanticQualityQuestionSetDigest,
  type FrozenQualityQuestion,
  type FrozenSemanticQualityCorpus,
  type QualityLocale,
} from "./semantic-quality-corpus.js";

export interface QualityRunBinding {
  readonly corpusSha256: string;
  readonly questionSetSha256: string;
  readonly embeddingProfileDigestSha256: `sha256:${string}`;
  readonly embeddingProfileId: string;
  readonly modelConfigurationSha256: string;
  readonly modelContextTokens: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly observedAt: string;
  readonly releaseRevision: string;
  readonly releaseTree: string;
  readonly repetition: number;
  readonly runId: string;
  readonly serviceApiVersion: string;
  readonly serviceName: string;
  readonly serviceRevision: string;
  readonly tokenizerId: string;
  readonly tokenizerDigestSha256: `sha256:${string}`;
}

export interface QualityResourceMeasurement {
  readonly estimatedCostUsd: number;
  readonly inputTokens: number;
  readonly latencyMs: number;
  readonly outputTokens: number;
  readonly peakMemoryBytes: number;
  readonly requestBytes: number;
  readonly requestSha256: string;
}

export interface QualityResourceSummary {
  readonly estimatedCostUsd: number;
  readonly inputTokens: number;
  readonly latencyMs: {
    readonly maximum: number;
    readonly p50: number;
    readonly p95: number;
  };
  readonly outputTokens: number;
  readonly peakMemoryBytes: number;
  readonly requestBytes: number;
}

export interface QualityRawOutcome {
  readonly adjudication: {
    readonly claims: readonly {
      readonly citationValid: boolean;
      readonly matchedGoldClaimId: string | null;
      readonly verdict: "pending" | "stale" | "supported" | "unsupported";
    }[];
    readonly status: "fixture" | "human_verified" | "pending";
  };
  readonly answer: {
    readonly claims: readonly { readonly citedTurnIds: readonly string[]; readonly text: string }[];
    readonly status: "answered" | "abstained";
  };
  readonly measurement: QualityResourceMeasurement;
  readonly queryId: string;
  readonly retrieval: {
    readonly localRehydrationVerified: boolean;
    readonly candidateBlockCountAt5: number;
    readonly providerPayloadWasReferenceOnly: boolean;
    readonly rehydratedTurnIds: readonly string[];
    readonly topFiveTurnIds: readonly string[];
    readonly wholeTranscriptIncluded: boolean;
  };
}

export interface ProportionMetric {
  readonly denominator: number;
  readonly estimate: number | null;
  readonly numerator: number;
  readonly wilson95: { readonly high: number; readonly low: number } | null;
}

export interface QualityScore {
  readonly abstentionRecall: ProportionMetric;
  readonly answerRecall: ProportionMetric;
  readonly citationValidity: ProportionMetric;
  readonly claimPrecision: ProportionMetric;
  readonly retrievalRecallAt5: ProportionMetric;
}

export interface SemanticQualityRunEvidence {
  readonly adjudicationReceipt: HumanAdjudicationReceipt | null;
  readonly binding: QualityRunBinding;
  readonly claims: {
    readonly productionQualityQualified: false;
    readonly status: "harness_validation_only" | "measurement_requires_human_adjudication" | "measured_human_adjudicated";
  };
  readonly labelStatus: "authored_fixture" | "independent_human_verified" | "pending";
  readonly outcomes: readonly QualityRawOutcome[];
  readonly overall: QualityScore;
  readonly perLocale: Readonly<Record<QualityLocale, QualityScore>>;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_run.v1";
  readonly sdk: {
    readonly commit: string;
    readonly packageIntegrity: string;
    readonly packageSha256: string;
    readonly tree: string;
  };
  readonly resources: QualityResourceSummary;
}

export interface HumanAdjudicationReceipt {
  readonly adjudicatorId: string;
  readonly answerRunSha256: string;
  readonly corpusSha256: string;
  readonly questionSetSha256: string;
  readonly reviewedAt: string;
  readonly schemaVersion: string;
}

export interface SemanticQualityDistribution {
  readonly metric: keyof QualityScore;
  readonly repetitions: number;
  readonly values: { readonly maximum: number; readonly median: number; readonly minimum: number };
}

/**
 * Scores retrieval separately from answer semantics. An outcome can only count
 * as a correct answer after external adjudication maps its claims to frozen gold
 * claims; model prose never grades itself.
 */
export function createSemanticQualityRunEvidence(input: {
  readonly adjudicationReceipt?: HumanAdjudicationReceipt;
  readonly binding: QualityRunBinding;
  readonly corpus: FrozenSemanticQualityCorpus;
  readonly labelStatus: SemanticQualityRunEvidence["labelStatus"];
  readonly outcomes: readonly QualityRawOutcome[];
}): SemanticQualityRunEvidence {
  validateBinding(input.binding);
  validateCorpus(input.corpus, input.binding);
  const questions = input.corpus.questions;
  const byId = new Map(questions.map((question) => [question.id, question]));
  if (byId.size !== questions.length || input.outcomes.length !== questions.length) {
    throw new Error("quality run requires exactly one outcome for every unique frozen question");
  }
  const outcomeIds = new Set<string>();
  for (const outcome of input.outcomes) {
    if (outcomeIds.has(outcome.queryId) || !byId.has(outcome.queryId)) {
      throw new Error("quality run contains an unknown or duplicate query outcome");
    }
    outcomeIds.add(outcome.queryId);
    validateOutcome(outcome);
  }
  const adjudicationStatuses = new Set(input.outcomes.map(({ adjudication }) => adjudication.status));
  if (input.labelStatus === "independent_human_verified" &&
    (adjudicationStatuses.size !== 1 || !adjudicationStatuses.has("human_verified"))) {
    throw new Error("human-verified evidence requires every outcome to be human adjudicated");
  }
  validateAdjudicationReceipt(input);
  const score = (slice: readonly FrozenQualityQuestion[]): QualityScore =>
    scoreSlice(slice, new Map(input.outcomes.map((outcome) => [outcome.queryId, outcome])));
  const perLocale = Object.freeze({
    en: score(questions.filter(({ locale }) => locale === "en")),
    mixed: score(questions.filter(({ locale }) => locale === "mixed")),
    ru: score(questions.filter(({ locale }) => locale === "ru")),
  });
  const status = adjudicationStatuses.size === 1 && adjudicationStatuses.has("fixture")
    ? "harness_validation_only"
    : input.labelStatus === "independent_human_verified"
      ? "measured_human_adjudicated"
      : "measurement_requires_human_adjudication";
  return Object.freeze({
    adjudicationReceipt: input.adjudicationReceipt === undefined
      ? null
      : Object.freeze({ ...input.adjudicationReceipt }),
    binding: Object.freeze({ ...input.binding }),
    claims: Object.freeze({ productionQualityQualified: false as const, status }),
    labelStatus: input.labelStatus,
    outcomes: Object.freeze([...input.outcomes]),
    overall: score(questions),
    perLocale,
    schemaVersion: "meeting_knowledge.semantic_quality_run.v1",
    resources: summarizeResources(input.outcomes),
    sdk: Object.freeze({
      commit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
      packageIntegrity: INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity,
      packageSha256: INFINITY_CONTEXT_SDK_PROVENANCE.packageTarballSha256,
      tree: INFINITY_CONTEXT_SDK_PROVENANCE.tree,
    }),
  });
}

export function semanticQualityAnswerRunDigest(outcomes: readonly QualityRawOutcome[]): string {
  const answerRun = outcomes.map(({ adjudication: _adjudication, ...outcome }) => outcome);
  return sha256(JSON.stringify(answerRun));
}

export function qualityDistribution(
  evidence: readonly SemanticQualityRunEvidence[],
  metric: keyof QualityScore,
): SemanticQualityDistribution {
  if (evidence.length < 3) {
    throw new Error("quality distribution requires at least three repetitions");
  }
  if (new Set(evidence.map(bindingKey)).size !== 1 ||
    new Set(evidence.map(({ binding }) => binding.repetition)).size !== evidence.length) {
    throw new Error("quality repetitions must share one exact runtime binding and unique repetition");
  }
  const values = evidence.map((run) => run.overall[metric].estimate);
  if (values.some((value) => value === null)) {
    throw new Error("quality distribution metric has no denominator");
  }
  const sorted = (values as number[]).toSorted((left, right) => left - right);
  return Object.freeze({
    metric,
    repetitions: sorted.length,
    values: Object.freeze({
      maximum: sorted.at(-1) ?? 0,
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      minimum: sorted[0] ?? 0,
    }),
  });
}

function bindingKey(run: SemanticQualityRunEvidence): string {
  return JSON.stringify({
    corpus: run.binding.corpusSha256,
    questions: run.binding.questionSetSha256,
    embedding: [run.binding.embeddingProfileId, run.binding.embeddingProfileDigestSha256],
    model: [run.binding.modelId, run.binding.modelRevision, run.binding.modelConfigurationSha256],
    tokenizer: [run.binding.tokenizerId, run.binding.tokenizerDigestSha256],
    release: run.binding.releaseRevision,
    releaseTree: run.binding.releaseTree,
    service: [run.binding.serviceName, run.binding.serviceApiVersion, run.binding.serviceRevision],
  });
}

function scoreSlice(
  questions: readonly FrozenQualityQuestion[],
  outcomes: ReadonlyMap<string, QualityRawOutcome>,
): QualityScore {
  let retrievalHits = 0;
  let answerHits = 0;
  let abstentionHits = 0;
  let validCitations = 0;
  let emittedClaims = 0;
  let matchedClaims = 0;
  const answerable = questions.filter(({ kind }) => kind === "answerable");
  const unsupported = questions.filter(({ kind }) => kind === "unsupported");
  for (const question of questions) {
    const outcome = outcomes.get(question.id);
    if (outcome === undefined) {
      throw new Error(`missing outcome for ${question.id}`);
    }
    const gold = new Set(question.goldTurnIds);
    if (question.kind === "answerable" && [...gold].every((id) =>
      outcome.retrieval.topFiveTurnIds.includes(id) &&
      outcome.retrieval.rehydratedTurnIds.includes(id))) {
      retrievalHits += 1;
    }
    const expectedClaims = new Set(question.expectedClaimIds);
    const supportedMappings = outcome.adjudication.claims.filter(({ verdict }) =>
      verdict === "supported");
    const matched = new Set(supportedMappings
      .map(({ matchedGoldClaimId }) => matchedGoldClaimId)
      .filter((claimId): claimId is string => claimId !== null && expectedClaims.has(claimId)));
    emittedClaims += outcome.answer.claims.length;
    matchedClaims += matched.size;
    if (question.kind === "answerable" && outcome.answer.status === "answered" &&
      expectedClaims.size > 0 && matched.size === expectedClaims.size &&
      supportedMappings.length === expectedClaims.size &&
      [...expectedClaims].every((claim) => matched.has(claim))) {
      answerHits += 1;
    }
    if (question.kind === "unsupported" && outcome.answer.status === "abstained" &&
      outcome.answer.claims.length === 0) {
      abstentionHits += 1;
    }
    validCitations += outcome.adjudication.claims.filter(({ citationValid }) => citationValid).length;
  }
  return Object.freeze({
    abstentionRecall: proportion(abstentionHits, unsupported.length),
    answerRecall: proportion(answerHits, answerable.length),
    citationValidity: proportion(validCitations, emittedClaims),
    claimPrecision: proportion(matchedClaims, emittedClaims),
    retrievalRecallAt5: proportion(retrievalHits, answerable.length),
  });
}

function proportion(numerator: number, denominator: number): ProportionMetric {
  if (denominator === 0) {
    return Object.freeze({ denominator, estimate: null, numerator, wilson95: null });
  }
  const estimate = numerator / denominator;
  const z = 1.959963984540054;
  const adjusted = 1 + z * z / denominator;
  const center = (estimate + z * z / (2 * denominator)) / adjusted;
  const margin = z * Math.sqrt(estimate * (1 - estimate) / denominator +
    z * z / (4 * denominator * denominator)) / adjusted;
  return Object.freeze({
    denominator,

    estimate,
    numerator,
    wilson95: Object.freeze({ high: Math.min(1, center + margin), low: Math.max(0, center - margin) }),
  });
}
function summarizeResources(outcomes: readonly QualityRawOutcome[]): QualityResourceSummary {
  const latencies = outcomes.map(({ measurement }) => measurement.latencyMs)
    .toSorted((left, right) => left - right);
  const sum = (field: keyof Omit<QualityResourceMeasurement, "requestSha256">): number =>
    outcomes.reduce((total, outcome) => total + outcome.measurement[field], 0);
  const percentile = (fraction: number): number =>
    latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)] ?? 0;
  return Object.freeze({
    estimatedCostUsd: sum("estimatedCostUsd"),
    inputTokens: sum("inputTokens"),
    latencyMs: Object.freeze({
      maximum: latencies.at(-1) ?? 0,
      p50: percentile(0.5),
      p95: percentile(0.95),
    }),
    outputTokens: sum("outputTokens"),
    peakMemoryBytes: Math.max(0, ...outcomes.map(({ measurement }) => measurement.peakMemoryBytes)),
    requestBytes: sum("requestBytes"),
  });
}


function validateBinding(binding: QualityRunBinding): void {
  if (!/^[a-f0-9]{40}$/u.test(binding.releaseRevision) ||
    !/^[a-f0-9]{40}$/u.test(binding.releaseTree) ||
    !/^[a-f0-9]{40}$/u.test(binding.serviceRevision) ||
    !/^sha256:[a-f0-9]{64}$/u.test(binding.embeddingProfileDigestSha256) ||
    !/^[a-f0-9]{64}$/u.test(binding.modelConfigurationSha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(binding.tokenizerDigestSha256)) {
    throw new Error("quality run requires exact release, service, and embedding-profile revisions");
  }
  if (binding.repetition < 1 || !Number.isSafeInteger(binding.repetition) ||
    binding.modelContextTokens < 1 || !Number.isSafeInteger(binding.modelContextTokens) ||
    Number.isNaN(Date.parse(binding.observedAt))) {
    throw new Error("quality run binding contains an invalid repetition, context, or timestamp");
  }
  for (const value of [binding.corpusSha256, binding.modelId, binding.modelRevision,
    binding.runId, binding.serviceApiVersion, binding.serviceName, binding.tokenizerId]) {
    if (value.trim() === "") {
      throw new Error("quality run binding contains empty identity");
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(binding.corpusSha256) ||
    !/^[a-f0-9]{64}$/u.test(binding.questionSetSha256)) {
    throw new Error("quality corpus and question-set digests must be SHA-256");
  }
}

function validateOutcome(outcome: QualityRawOutcome): void {
  if (outcome.retrieval.wholeTranscriptIncluded ||
    !outcome.retrieval.providerPayloadWasReferenceOnly ||
    !outcome.retrieval.localRehydrationVerified) {
    throw new Error("quality outcome violated reference-only retrieval or local rehydration");
  }
  if (!Number.isSafeInteger(outcome.retrieval.candidateBlockCountAt5) ||
    outcome.retrieval.candidateBlockCountAt5 < 0 || outcome.retrieval.candidateBlockCountAt5 > 5) {
    throw new Error("retrieval recall@5 received more than five candidate blocks");
  }
  if (outcome.adjudication.claims.length !== outcome.answer.claims.length) {
    throw new Error("quality adjudication requires exactly one gold mapping per emitted claim");
  }
  for (const claim of outcome.adjudication.claims) {
    if (claim.verdict !== "supported" && claim.matchedGoldClaimId !== null) {
      throw new Error("unsupported or stale claims cannot map to gold");
    }
    if (claim.verdict !== "supported" && claim.citationValid) {
      throw new Error("unsupported or stale claims cannot have a valid citation");
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(outcome.measurement.requestSha256) ||
    Object.values(outcome.measurement).some((value) => typeof value === "number" &&
      (!Number.isFinite(value) || value < 0))) {
    throw new Error("quality outcome contains invalid resource measurement");
  }
}

function validateCorpus(corpus: FrozenSemanticQualityCorpus, binding: QualityRunBinding): void {
  const answerable = corpus.questions.filter(({ kind }) => kind === "answerable");
  const unsupported = corpus.questions.filter(({ kind }) => kind === "unsupported");
  const ids = new Set(corpus.questions.map(({ id }) => id));
  const texts = new Set(corpus.questions.map(({ question }) => question.trim().toLocaleLowerCase()));
  const turnIds = new Set(corpus.meeting.humanTurns.map(({ turnId }) => turnId));
  const questionSetSha256 = semanticQualityQuestionSetDigest(corpus.questions);
  const corpusSha256 = semanticQualityCorpusDigest({
    questionSetSha256,
    turns: corpus.meeting.humanTurns,
  });
  if (answerable.length !== 100 || unsupported.length !== 100 ||
    ids.size !== 200 || texts.size !== 200) {
    throw new Error("quality corpus requires exactly 100/100 unique questions");
  }
  if (questionSetSha256 !== corpus.questionSetSha256 ||
    corpusSha256 !== corpus.corpusSha256 ||
    binding.questionSetSha256 !== questionSetSha256 ||
    binding.corpusSha256 !== corpusSha256) {
    throw new Error("quality corpus digest binding mismatch");
  }
  for (const question of answerable) {
    if (question.expectedClaimIds.length === 0 || question.goldTurnIds.length === 0 ||
      question.goldTurnIds.some((turnId) => !turnIds.has(turnId))) {
      throw new Error("answerable question has incomplete gold topology");
    }
  }
  for (const question of unsupported) {
    if (question.expectedClaimIds.length !== 0 || question.goldTurnIds.length !== 0 ||
      question.distractorTurnIds.length === 0 ||
      question.distractorTurnIds.some((turnId) => !turnIds.has(turnId))) {
      throw new Error("unsupported question requires actual distractor evidence");
    }
  }
}

function validateAdjudicationReceipt(input: {
  readonly adjudicationReceipt?: HumanAdjudicationReceipt;
  readonly corpus: FrozenSemanticQualityCorpus;
  readonly labelStatus: SemanticQualityRunEvidence["labelStatus"];
  readonly outcomes: readonly QualityRawOutcome[];
}): void {
  if (input.labelStatus !== "independent_human_verified") {
    if (input.adjudicationReceipt !== undefined) {
      throw new Error("human adjudication receipt requires independent labels");
    }
    return;
  }
  const receipt = input.adjudicationReceipt;
  if (receipt === undefined ||
    receipt.schemaVersion !== "meeting_knowledge.human_adjudication_receipt.v1" ||
    receipt.corpusSha256 !== input.corpus.corpusSha256 ||
    receipt.questionSetSha256 !== input.corpus.questionSetSha256 ||
    receipt.answerRunSha256 !== semanticQualityAnswerRunDigest(input.outcomes) ||
    receipt.adjudicatorId.trim() === "" || Number.isNaN(Date.parse(receipt.reviewedAt))) {
    throw new Error("independent human adjudication receipt is absent or misbound");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
