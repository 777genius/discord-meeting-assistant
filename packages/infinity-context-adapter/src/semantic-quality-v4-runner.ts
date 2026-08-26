import { createHash } from "node:crypto";

export type SemanticQualityV4Locale = "en" | "mixed" | "ru";

export interface SemanticQualityV4RunQuestion {
  readonly id: string;
  readonly locale: SemanticQualityV4Locale;
  readonly question: string;
}

export interface SemanticQualityV4OpaqueLocator {
  readonly locatorId: string;
}

export interface SemanticQualityV4CitationReference {
  readonly endMs: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly turnId: string;
}

export interface SemanticQualityV4GeneratedClaim {
  readonly citationRefs: readonly SemanticQualityV4CitationReference[];
  readonly claimId: string;
  readonly claimPayloadSha256: string;
  readonly factual: boolean;
  readonly text: string;
}

export interface SemanticQualityV4LocalEvidenceTurn extends SemanticQualityV4CitationReference {
  /** Opaque production record-block locator that admitted this canonical turn. */
  readonly sourceLocatorId: string;
  readonly text: string;
}

export interface SemanticQualityV4RetrievalResult {
  readonly capabilityAndRetrievalLatencyUs: number;
  readonly capabilityBytes: number;
  readonly capabilitySha256: string;
  readonly expandedNeighborLocators: readonly SemanticQualityV4OpaqueLocator[];
  readonly latencyUs: number;
  /** The upstream order before any neighbor or block expansion. */
  readonly rankedSeedLocators: readonly SemanticQualityV4OpaqueLocator[];
  readonly requestBytes: number;
  readonly requestSha256: string;
  readonly requestSnapshotSha256: string;
  readonly responseBytes: number;
  readonly responseSha256: string;
  readonly routeLatencyUs: number;
  readonly status: "completed" | "failure" | "timeout";
}

export interface SemanticQualityV4RetrievalPort {
  retrieve(input: {
    readonly locale: SemanticQualityV4Locale;
    readonly queryId: string;
    readonly question: string;
  }): Promise<SemanticQualityV4RetrievalResult>;
}

export interface SemanticQualityV4EvidencePort {
  rehydrate(input: {
    readonly expandedNeighborLocators: readonly SemanticQualityV4OpaqueLocator[];
    readonly locale: SemanticQualityV4Locale;
    readonly questionDigestSha256: string;
    readonly queryId: string;
    readonly rankedSeedLocators: readonly SemanticQualityV4OpaqueLocator[];
  }): Promise<{
    readonly turns: readonly SemanticQualityV4LocalEvidenceTurn[];
  }>;
}

export interface SemanticQualityV4AnswerPort {
  answer(input: {
    readonly evidence: readonly SemanticQualityV4LocalEvidenceTurn[];
    readonly locale: SemanticQualityV4Locale;
    readonly queryId: string;
    readonly question: string;
  }): Promise<{
    readonly claims: readonly SemanticQualityV4GeneratedClaim[];
    /** Exact prompt submitted to the answer runtime; accounting is recomputed locally. */
    readonly prompt: string;
    readonly measurement: SemanticQualityV4AnswerMeasurement;
    readonly status: "abstained" | "answered" | "failure" | "timeout";
  }>;
}

export interface SemanticQualityV4AnswerMeasurement {
  readonly answerLatencyUs: number;
  readonly attemptId: string;
  readonly originalInput: SemanticQualityV4ModelInputMeasurement;
  readonly originalModelInputSha256: string;
  readonly originalProviderRequestSha256: string;
  readonly originalProviderResponseSha256: string;
  readonly repairInput: SemanticQualityV4ModelInputMeasurement;
  readonly repairModelInputSha256: string;
  readonly repairProviderRequestSha256: string | null;
  readonly repairProviderResponseSha256: string | null;
  readonly responseBytes: number;
  readonly runtimeReceiptSha256: string;
  readonly responseRuntimeArtifactSha256: string;
}

export interface SemanticQualityV4ModelInputMeasurement {
  readonly fullInputBytes: number;
  readonly outputSchemaBytes: number;
  readonly systemPromptBytes: number;
  readonly userPromptBytes: number;
}

export interface SemanticQualityV4AdjudicationPort {
  adjudicate(input: {
    readonly answer: {
      readonly claims: readonly SemanticQualityV4GeneratedClaim[];
      readonly status: "abstained" | "answered" | "failure" | "timeout";
    };
    readonly evidence: readonly SemanticQualityV4LocalEvidenceTurn[];
    readonly locale: SemanticQualityV4Locale;
    readonly questionDigestSha256: string;
    readonly queryId: string;
    readonly question: string;
  }): Promise<{
    readonly adjudications: readonly {
      readonly claimId: string;
      /** Independently assigned; generator-owned factual flags are not scoring authority. */
      readonly factuality: "factual" | "nonfactual";
      readonly matchedGoldClaimId: string | null;
      readonly status: "finalized";
      readonly verdict: "stale" | "supported" | "unsupported";
    }[];
    readonly citationEntailments: readonly {
      readonly claimId: string;
      readonly status: "finalized";
      readonly turnId: string;
      readonly verdict: "does_not_entail" | "entails";
    }[];
    readonly kind: "external_independent" | "synthetic_structural_fixture";
  }>;
}

type SemanticQualityV4AdjudicationResult = Awaited<ReturnType<
  SemanticQualityV4AdjudicationPort["adjudicate"]
>>;

export interface SemanticQualityV4RunnerOutcome {
  readonly adjudicationKind: "external_independent" | "synthetic_structural_fixture";
  readonly adjudications: SemanticQualityV4AdjudicationResult["adjudications"];
  readonly answer: {
    readonly claims: readonly SemanticQualityV4GeneratedClaim[];
    readonly status: "abstained" | "answered" | "failure" | "timeout";
  };
  readonly answerMeasurement: SemanticQualityV4AnswerMeasurement;
  readonly citationEntailments: SemanticQualityV4AdjudicationResult["citationEntailments"];
  readonly evidenceBytes: number;
  /** Model path only: retrieval, local rehydration, and answer execution. */
  readonly fullLatencyUs: number;
  /** Independent review is deliberately outside model-path latency. */
  readonly adjudicationLatencyUs: number;
  readonly locallyRehydratedEvidence: readonly SemanticQualityV4LocalEvidenceTurn[];
  readonly locale: SemanticQualityV4Locale;
  readonly prompt: string;
  readonly promptBytes: number;
  readonly questionDigestSha256: string;
  readonly queryId: string;
  readonly retrieval: SemanticQualityV4RetrievalResult;
}

export type SemanticQualityV4RawRunnerOutcome = Omit<SemanticQualityV4RunnerOutcome,
  "adjudicationKind" | "adjudications" | "adjudicationLatencyUs" | "citationEntailments">;

export interface SemanticQualityV4RetrievalPhaseOutcome {
  readonly evidenceBytes: number;
  readonly locallyRehydratedEvidence: readonly SemanticQualityV4LocalEvidenceTurn[];
  readonly locale: SemanticQualityV4Locale;
  readonly question: string;
  readonly questionDigestSha256: string;
  readonly queryId: string;
  readonly retrieval: SemanticQualityV4RetrievalResult;
  readonly retrievalPhaseLatencyUs: number;
}

/** Binds one execution to the exact canonical id, locale, and evaluation text. */
export function semanticQualityV4QuestionDigest(
  question: SemanticQualityV4RunQuestion,
): string {
  return createHash("sha256").update(JSON.stringify({
    id: question.id,
    locale: question.locale,
    v4EvaluationQuestionText: question.question,
  }), "utf8").digest("hex");
}

/**
 * Consumer-owned evaluation orchestration. Retrieval returns opaque seeds and
 * neighbors only; the consumer rehydrates authoritative text locally before it
 * can reach answering or adjudication.
 */
export async function runSemanticQualityV4(input: {
  readonly adjudication: SemanticQualityV4AdjudicationPort;
  readonly answer: SemanticQualityV4AnswerPort;
  readonly canonicalQuestions: readonly SemanticQualityV4RunQuestion[];
  readonly evidence: SemanticQualityV4EvidencePort;
  readonly questions: readonly SemanticQualityV4RunQuestion[];
  readonly retrieval: SemanticQualityV4RetrievalPort;
}): Promise<readonly SemanticQualityV4RunnerOutcome[]> {
  const retrievalOutcomes = await runSemanticQualityV4RetrievalPhase(input);
  if (retrievalOutcomes.some(({ retrieval }) => retrieval.status !== "completed")) {
    throw new Error("semantic quality V4 retrieval phase failed before answer execution");
  }
  return await runSemanticQualityV4AnswerPhase({ adjudication: input.adjudication,
    answer: input.answer, retrievalOutcomes });
}

/** Completes all retrieval and local-authority work without possessing an answer port. */
export async function runSemanticQualityV4RetrievalPhase(input: {
  readonly canonicalQuestions: readonly SemanticQualityV4RunQuestion[];
  readonly evidence: SemanticQualityV4EvidencePort;
  readonly questions: readonly SemanticQualityV4RunQuestion[];
  readonly retrieval: SemanticQualityV4RetrievalPort;
}): Promise<readonly SemanticQualityV4RetrievalPhaseOutcome[]> {
  assertCanonicalQuestionSet(input.questions, input.canonicalQuestions);
  const outcomes: SemanticQualityV4RetrievalPhaseOutcome[] = [];
  for (const question of input.questions) {
    const started = process.hrtime.bigint();
    const questionDigestSha256 = semanticQualityV4QuestionDigest(question);
    const retrieval = await input.retrieval.retrieve({ locale: question.locale,
      queryId: question.id, question: question.question });
    assertRetrievalResult(retrieval, question.id);
    const local = await input.evidence.rehydrate({
      expandedNeighborLocators: retrieval.expandedNeighborLocators,
      locale: question.locale,
      questionDigestSha256,
      queryId: question.id,
      rankedSeedLocators: retrieval.rankedSeedLocators,
    });
    assertLocalEvidence(local, retrieval, question.id);
    const evidenceBytes = new TextEncoder().encode(JSON.stringify(local.turns)).byteLength;
    if (evidenceBytes > 16_000) {
      throw new Error(`semantic quality V4 local evidence ${question.id} exceeds 16000 bytes`);
    }
    outcomes.push(Object.freeze({ evidenceBytes,
      locallyRehydratedEvidence: Object.freeze([...local.turns]), locale: question.locale,
      question: question.question, questionDigestSha256, queryId: question.id, retrieval,
      retrievalPhaseLatencyUs: Number((process.hrtime.bigint() - started) / 1_000n) }));
  }
  return Object.freeze(outcomes);
}

/** Runs answering only after the caller has admitted the complete retrieval phase. */
export async function runSemanticQualityV4AnswerPhase(input: {
  readonly adjudication: SemanticQualityV4AdjudicationPort;
  readonly answer: SemanticQualityV4AnswerPort;
  readonly retrievalOutcomes: readonly SemanticQualityV4RetrievalPhaseOutcome[];
}): Promise<readonly SemanticQualityV4RunnerOutcome[]> {
  const rawOutcomes = await runSemanticQualityV4RawAnswerPhase({
    answer: input.answer,
    retrievalOutcomes: input.retrievalOutcomes,
  });
  const outcomes: SemanticQualityV4RunnerOutcome[] = [];
  for (const rawOutcome of rawOutcomes) {
    const { answer, locallyRehydratedEvidence: localEvidence, locale,
      questionDigestSha256, queryId } = rawOutcome;
    const retrievalOutcome = input.retrievalOutcomes.find((item) => item.queryId === queryId);
    if (retrievalOutcome === undefined) {
      throw new Error(`semantic quality V4 raw answer ${queryId} lacks retrieval input`);
    }
    const adjudicationStarted = process.hrtime.bigint();
    const adjudication = await input.adjudication.adjudicate({ answer,
      evidence: localEvidence, locale, questionDigestSha256, queryId,
      question: retrievalOutcome.question });
    const adjudicationLatencyUs = Number((process.hrtime.bigint() - adjudicationStarted) / 1_000n);
    outcomes.push(Object.freeze({
      ...rawOutcome,
      adjudicationLatencyUs,
      adjudicationKind: adjudication.kind,
      adjudications: Object.freeze([...adjudication.adjudications]),
      citationEntailments: Object.freeze([...adjudication.citationEntailments]),
    }));
  }
  return Object.freeze(outcomes);
}

/** Runs provider work without requiring answer-bound human evidence to exist yet. */
export async function runSemanticQualityV4RawAnswerPhase(input: {
  readonly answer: SemanticQualityV4AnswerPort;
  readonly retrievalOutcomes: readonly SemanticQualityV4RetrievalPhaseOutcome[];
}): Promise<readonly SemanticQualityV4RawRunnerOutcome[]> {
  const outcomes: SemanticQualityV4RawRunnerOutcome[] = [];
  for (const retrievalOutcome of input.retrievalOutcomes) {
    const { evidenceBytes, locallyRehydratedEvidence: localEvidence, locale,
      question, questionDigestSha256, queryId, retrieval, retrievalPhaseLatencyUs } =
      retrievalOutcome;
    if (retrieval.status !== "completed") {
      throw new Error(`semantic quality V4 retrieval ${queryId} was not admitted for answering`);
    }
    const answerResult = await input.answer.answer({ evidence: localEvidence,
      locale, queryId, question });
    if (typeof answerResult.prompt !== "string") {
      throw new Error(`semantic quality V4 answer ${queryId} omitted its exact prompt`);
    }
    assertAnswerMeasurement(answerResult.measurement, queryId);
    const promptBytes = Math.max(answerResult.measurement.originalInput.fullInputBytes,
      answerResult.measurement.repairInput.fullInputBytes);
    outcomes.push(Object.freeze({
      answer: Object.freeze({ claims: answerResult.claims, status: answerResult.status }),
      answerMeasurement: answerResult.measurement,
      evidenceBytes,
      fullLatencyUs: retrievalPhaseLatencyUs + answerResult.measurement.answerLatencyUs,
      locallyRehydratedEvidence: localEvidence,
      locale,
      prompt: answerResult.prompt,
      promptBytes,
      questionDigestSha256,
      queryId,
      retrieval,
    }));
  }
  return Object.freeze(outcomes);
}

/** Production composition must replace this boundary explicitly. */
export class FailClosedSemanticQualityV4Retrieval implements SemanticQualityV4RetrievalPort {
  public async retrieve(_input: Parameters<SemanticQualityV4RetrievalPort["retrieve"]>[0]):
  Promise<SemanticQualityV4RetrievalResult> {
    throw new Error("semantic quality V4 production retrieval is not composed");
  }
}

/** Production composition must provide canonical local storage explicitly. */
export class FailClosedSemanticQualityV4Evidence implements SemanticQualityV4EvidencePort {
  public async rehydrate(_input: Parameters<SemanticQualityV4EvidencePort["rehydrate"]>[0]):
  Promise<Awaited<ReturnType<SemanticQualityV4EvidencePort["rehydrate"]>>> {
    throw new Error("semantic quality V4 production evidence is not composed");
  }
}

/** Production composition must provide an answer runtime explicitly. */
export class FailClosedSemanticQualityV4Answer implements SemanticQualityV4AnswerPort {
  public async answer(_input: Parameters<SemanticQualityV4AnswerPort["answer"]>[0]):
  Promise<Awaited<ReturnType<SemanticQualityV4AnswerPort["answer"]>>> {
    throw new Error("semantic quality V4 production answer is not composed");
  }
}

/** Production composition must provide independent adjudication explicitly. */
export class FailClosedSemanticQualityV4Adjudication implements SemanticQualityV4AdjudicationPort {
  public async adjudicate(_input: Parameters<SemanticQualityV4AdjudicationPort["adjudicate"]>[0]):
  Promise<Awaited<ReturnType<SemanticQualityV4AdjudicationPort["adjudicate"]>>> {
    throw new Error("semantic quality V4 production adjudication is not composed");
  }
}

function assertRetrievalResult(value: SemanticQualityV4RetrievalResult, queryId: string): void {
  const seedIds = value.rankedSeedLocators.map(({ locatorId }) => locatorId);
  const neighborIds = value.expandedNeighborLocators.map(({ locatorId }) => locatorId);
  if (seedIds.length > 10 || new Set(seedIds).size !== seedIds.length ||
    new Set(neighborIds).size !== neighborIds.length ||
    [...seedIds, ...neighborIds].some((locatorId) => locatorId.trim() === "") ||
    [value.capabilityAndRetrievalLatencyUs, value.capabilityBytes, value.latencyUs,
      value.requestBytes, value.responseBytes, value.routeLatencyUs]
      .some((item) => !Number.isSafeInteger(item) || item < 0) ||
    [value.capabilitySha256, value.requestSha256, value.requestSnapshotSha256,
      value.responseSha256]
      .some((item) => !/^[a-f0-9]{64}$/u.test(item)) ||
    (value.status !== "completed" && (seedIds.length > 0 || neighborIds.length > 0))) {
    throw new Error(`semantic quality V4 retrieval ${queryId} is invalid`);
  }
}

function assertAnswerMeasurement(
  value: SemanticQualityV4AnswerMeasurement,
  queryId: string,
): void {
  const surfaces = [value.originalInput, value.repairInput];
  if ([value.answerLatencyUs, value.responseBytes]
      .some((item) => !Number.isSafeInteger(item) || item < 0) ||
    [value.runtimeReceiptSha256, value.originalModelInputSha256,
      value.originalProviderRequestSha256, value.originalProviderResponseSha256,
      value.repairModelInputSha256, value.responseRuntimeArtifactSha256]
      .some((digest) => !/^[a-f0-9]{64}$/u.test(digest)) ||
    ((value.repairProviderRequestSha256 === null) !==
      (value.repairProviderResponseSha256 === null)) ||
    [value.repairProviderRequestSha256, value.repairProviderResponseSha256]
      .some((digest) => digest !== null && !/^[a-f0-9]{64}$/u.test(digest)) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.attemptId) ||
    surfaces.some((surface) => [surface.fullInputBytes, surface.outputSchemaBytes,
      surface.systemPromptBytes, surface.userPromptBytes]
      .some((item) => !Number.isSafeInteger(item) || item < 0) ||
      surface.fullInputBytes !== surface.outputSchemaBytes + surface.systemPromptBytes +
        surface.userPromptBytes + 2 || surface.fullInputBytes > 16_000)) {
    throw new Error(`semantic quality V4 answer measurement ${queryId} is invalid`);
  }
}

function assertLocalEvidence(value: {
  readonly turns: readonly SemanticQualityV4LocalEvidenceTurn[] },
retrieval: SemanticQualityV4RetrievalResult, queryId: string): void {
  const turnIds = value.turns.map(({ turnId }) => turnId);
  const retrievedLocatorIds = new Set([
    ...retrieval.rankedSeedLocators, ...retrieval.expandedNeighborLocators,
  ].map(({ locatorId }) => locatorId));
  if (new Set(turnIds).size !== turnIds.length || value.turns.some((turn) =>
      turn.turnId.trim() === "" || turn.sourceLocatorId.trim() === "" ||
      turn.speakerId.trim() === "" || turn.text.trim() === "" ||
      !Number.isSafeInteger(turn.startMs) || !Number.isSafeInteger(turn.endMs) ||
      turn.startMs < 0 || turn.endMs <= turn.startMs ||
      !retrievedLocatorIds.has(turn.sourceLocatorId))) {
    throw new Error(`semantic quality V4 local evidence ${queryId} is invalid`);
  }
}

function assertCanonicalQuestionSet(
  questions: readonly SemanticQualityV4RunQuestion[],
  canonicalQuestions: readonly SemanticQualityV4RunQuestion[],
): void {
  const canonicalById = new Map(canonicalQuestions.map((question) => [question.id, question]));
  if (questions.length !== 240 || canonicalQuestions.length !== 240 ||
    new Set(questions.map(({ id }) => id)).size !== 240 || canonicalById.size !== 240 ||
    questions.some((question) => {
      const canonical = canonicalById.get(question.id);
      return canonical === undefined || canonical.locale !== question.locale ||
        canonical.question !== question.question;
    })) {
    throw new Error("semantic quality V4 requires the exact 240 canonical id, locale, and text triples");
  }
}
