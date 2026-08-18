import { INFINITY_CONTEXT_SDK_PROVENANCE } from "../src/index.js";
import type { FrozenQualityQuestion, QualityLocale } from "./semantic-quality-corpus.js";

export interface QualityRunBinding {
  readonly corpusSha256: string;
  readonly embeddingProfileDigestSha256: `sha256:${string}`;
  readonly embeddingProfileId: string;
  readonly modelConfigurationSha256: string;
  readonly modelContextTokens: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly observedAt: string;
  readonly releaseRevision: string;
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
    readonly citationValid: boolean;
    readonly matchedGoldClaimIds: readonly (string | null)[];
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
    readonly wholeTranscriptIncluded: false;
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
  readonly binding: QualityRunBinding;
  readonly labelStatus: SemanticQualityRunEvidence["labelStatus"];
  readonly outcomes: readonly QualityRawOutcome[];
  readonly questions: readonly FrozenQualityQuestion[];
}): SemanticQualityRunEvidence {
  validateBinding(input.binding);
  const byId = new Map(input.questions.map((question) => [question.id, question]));
  if (byId.size !== input.questions.length || input.outcomes.length !== input.questions.length) {
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
  const score = (questions: readonly FrozenQualityQuestion[]): QualityScore =>
    scoreSlice(questions, new Map(input.outcomes.map((outcome) => [outcome.queryId, outcome])));
  const perLocale = Object.freeze({
    en: score(input.questions.filter(({ locale }) => locale === "en")),
    mixed: score(input.questions.filter(({ locale }) => locale === "mixed")),
    ru: score(input.questions.filter(({ locale }) => locale === "ru")),
  });
  const status = adjudicationStatuses.size === 1 && adjudicationStatuses.has("fixture")
    ? "harness_validation_only"
    : input.labelStatus === "independent_human_verified"
      ? "measured_human_adjudicated"
      : "measurement_requires_human_adjudication";
  return Object.freeze({
    binding: Object.freeze({ ...input.binding }),
    claims: Object.freeze({ productionQualityQualified: false as const, status }),
    labelStatus: input.labelStatus,
    outcomes: Object.freeze([...input.outcomes]),
    overall: score(input.questions),
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
    embedding: [run.binding.embeddingProfileId, run.binding.embeddingProfileDigestSha256],
    model: [run.binding.modelId, run.binding.modelRevision, run.binding.modelConfigurationSha256],
    tokenizer: [run.binding.tokenizerId, run.binding.tokenizerDigestSha256],
    release: run.binding.releaseRevision,
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
    const matched = new Set(outcome.adjudication.matchedGoldClaimIds
      .filter((claimId): claimId is string => claimId !== null));
    emittedClaims += outcome.answer.claims.length;
    matchedClaims += outcome.adjudication.matchedGoldClaimIds
      .filter((claimId) => claimId !== null && expectedClaims.has(claimId)).length;
    if (question.kind === "answerable" && outcome.answer.status === "answered" &&
      expectedClaims.size > 0 && [...expectedClaims].every((claim) => matched.has(claim))) {
      answerHits += 1;
    }
    if (question.kind === "unsupported" && outcome.answer.status === "abstained" &&
      outcome.answer.claims.length === 0) {
      abstentionHits += 1;
    }
    if (outcome.adjudication.citationValid) {
      validCitations += outcome.answer.claims.length;
    }
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
  if (!/^[a-f0-9]{64}$/u.test(binding.corpusSha256)) {
    throw new Error("quality corpus digest must be SHA-256");
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
  if (outcome.adjudication.matchedGoldClaimIds.length !== outcome.answer.claims.length) {
    throw new Error("quality adjudication requires exactly one gold mapping per emitted claim");
  }
  if (!/^[a-f0-9]{64}$/u.test(outcome.measurement.requestSha256) ||
    Object.values(outcome.measurement).some((value) => typeof value === "number" &&
      (!Number.isFinite(value) || value < 0))) {
    throw new Error("quality outcome contains invalid resource measurement");
  }
}
