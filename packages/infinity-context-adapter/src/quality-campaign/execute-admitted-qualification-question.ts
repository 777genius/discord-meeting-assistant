const EXECUTION_PACKET_KEYS = Object.freeze([
  "locale", "questionId", "questionText", "scopeTopologyReference", "source",
]);

export interface QualificationExecutionPacket {
  readonly locale: "en" | "mixed" | "ru";
  readonly questionId: string;
  readonly questionText: string;
  /** Opaque signed reference. Only the composition adapter may resolve its topology. */
  readonly scopeTopologyReference: string;
  readonly source: "automatic" | "independent_review";
}

export interface QualificationRetrievalContribution {
  readonly contributionScorePicos: number;
  readonly providerLaneId: string;
  readonly providerRank: number;
  readonly queryId: string;
  readonly rawScoreKind: string | null;
  readonly rawScoreValue: number | null;
}

export interface QualificationRetrievalCandidate {
  readonly contributions: readonly QualificationRetrievalContribution[];
  readonly fusedScore: number;
  readonly locatorId: string;
  readonly providerRank: number;
}

export interface QualificationCanonicalTurn {
  readonly endMs: number;
  readonly sourceLocatorId: string;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
  readonly turnHash: string;
  readonly turnId: string;
}

export interface QualificationQuestionRetrievalPort {
  retrieve(input: QualificationExecutionPacket, options: QualificationQuestionExecutionContext):
    Promise<{ readonly candidates: readonly QualificationRetrievalCandidate[];
      readonly rawResponseSha256: string; readonly status: "completed" } |
    { readonly reason: string; readonly status: "failed" }>;
}

export interface QualificationQuestionEvidencePort {
  rehydrate(input: { readonly locatorIds: readonly string[]; readonly questionId: string;
    readonly scopeTopologyReference: string }, options: QualificationQuestionExecutionContext):
    Promise<{ readonly authorityGeneration: string; readonly canonicalEvidenceHash: string;
      readonly transcriptVersion: number; readonly turns: readonly QualificationCanonicalTurn[] }>;
}

export interface QualificationQuestionAnswerPort {
  generate(input: { readonly authorityGeneration: string;
    readonly canonicalEvidenceHash: string; readonly evidence: readonly QualificationCanonicalTurn[];
    readonly locale: QualificationExecutionPacket["locale"]; readonly questionId: string;
    readonly questionText: string; readonly transcriptVersion: number },
  options: QualificationQuestionExecutionContext): Promise<{ readonly citations: readonly string[];
    readonly claims: readonly string[]; readonly status: "abstained" | "answered" } |
  { readonly reason: string; readonly status: "failed" }>;
}

export type QualificationQuestionOutcome = Readonly<{
  citations: readonly string[];
  claims: readonly string[];
  rawRetrievalResponseSha256: string | null;
  reason?: string;
  retrievalCandidates: readonly QualificationRetrievalCandidate[];
  selectedTurns: readonly QualificationCanonicalTurn[];
  status: "abstained" | "answered" | "failed";
}>;

export interface QualificationQuestionExecutionContext {
  readonly attemptId: string;
  readonly signal: AbortSignal;
}

export interface QualificationQuestionOutcomePort {
  record(attemptId: string, outcome: QualificationQuestionOutcome): Promise<void>;
}

/** Scheduler-facing application boundary. Concrete SDK/database/runtime selection stays in composition. */
export interface QualificationQuestionExecutorPort {
  execute(input: QualificationExecutionPacket, options: QualificationQuestionExecutionContext):
    Promise<QualificationQuestionOutcome>;
}

/** Creates one isolated provider-effect slice for one stable campaign attempt. */
export interface QualificationQuestionExecutorFactoryPort {
  create(input: { readonly attemptId: string; readonly campaignRootSha256: string;
    readonly answerProcessIdentitySha256: string; readonly infinityCapabilitySha256: string;
    readonly mapperSha256: string;
    readonly questionId: string; readonly repetition: 1 | 2 | 3;
    readonly releaseRootSha256: string;
    readonly reservation: QualificationExternalEffectReservationPort;
    readonly spendReservationSha256: string; readonly tokenizerSha256: string }):
    Promise<QualificationQuestionExecutorPort>;
  recover(input: { readonly attemptId: string; readonly campaignRootSha256: string;
    readonly questionId: string; readonly repetition: 1 | 2 | 3 }):
    Promise<QualificationQuestionOutcome | "outcome_unknown" | null>;
}

export interface QualificationExternalEffectReservationPort {
  reserve(input: { readonly effectKind: "answer" | "capability" | "retrieval";
    readonly payloadSha256: string; readonly requestedEncryptedBytes: number;
    readonly requestedTokens: number }): Promise<void>;
}

/**
 * Consumer-owned application use case for exactly one admitted question.
 * Gold packets are deliberately absent from this module and cannot enter execute.
 */
export class ExecuteAdmittedQualificationQuestion {
  private readonly ports: {
    readonly answer: QualificationQuestionAnswerPort;
    readonly evidence: QualificationQuestionEvidencePort;
    readonly outcome: QualificationQuestionOutcomePort;
    readonly retrieval: QualificationQuestionRetrievalPort;
  };
  public constructor(ports: {
    readonly answer: QualificationQuestionAnswerPort;
    readonly evidence: QualificationQuestionEvidencePort;
    readonly outcome: QualificationQuestionOutcomePort;
    readonly retrieval: QualificationQuestionRetrievalPort;
  }) {this.ports = ports;}

  public async execute(input: QualificationExecutionPacket,
    options: QualificationQuestionExecutionContext): Promise<QualificationQuestionOutcome> {
    assertExecutionPacket(input);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(options.attemptId)) {
      throw new Error("qualification attempt identity is invalid");
    }
    options.signal.throwIfAborted();
    const retrieval = await this.ports.retrieval.retrieve(input, options);
    if (retrieval.status === "failed") {
      return await this.complete(options.attemptId, { citations: [], claims: [],
        rawRetrievalResponseSha256: null, reason: retrieval.reason, retrievalCandidates: [],
        selectedTurns: [], status: "failed" });
    }
    assertOrderedCandidates(retrieval.candidates);
    const locatorIds = retrieval.candidates.map(({ locatorId }) => locatorId);
    const evidence = await this.ports.evidence.rehydrate({ locatorIds,
      questionId: input.questionId, scopeTopologyReference: input.scopeTopologyReference }, options);
    assertSelectedEvidence(locatorIds, evidence.turns);
    if (evidence.turns.length === 0) {
      return await this.complete(options.attemptId, { citations: [], claims: [],
        rawRetrievalResponseSha256: retrieval.rawResponseSha256,
        reason: "zero_admissible_evidence", retrievalCandidates: retrieval.candidates,
        selectedTurns: [], status: "abstained" });
    }
    assertEvidenceBytes(evidence.turns);
    const answer = await this.ports.answer.generate({ authorityGeneration:
      evidence.authorityGeneration, canonicalEvidenceHash: evidence.canonicalEvidenceHash,
      evidence: evidence.turns, locale: input.locale, questionId: input.questionId,
      questionText: input.questionText, transcriptVersion: evidence.transcriptVersion }, options);
    if (answer.status === "failed") {
      return await this.complete(options.attemptId, { citations: [], claims: [],
        rawRetrievalResponseSha256: retrieval.rawResponseSha256, reason: answer.reason,
        retrievalCandidates: retrieval.candidates, selectedTurns: evidence.turns, status: "failed" });
    }
    const selectedTurnIds = new Set(evidence.turns.map(({ turnId }) => turnId));
    if (answer.citations.some((turnId) => !selectedTurnIds.has(turnId))) {
      throw new Error("qualification answer cites outside selected prompt evidence");
    }
    if (answer.status === "answered" && answer.citations.length === 0) {
      throw new Error("qualification answered outcome must cite selected prompt evidence");
    }
    if (answer.status === "abstained" &&
      (answer.citations.length !== 0 || answer.claims.length !== 0)) {
      throw new Error("qualification abstention cannot carry claims or citations");
    }
    return await this.complete(options.attemptId, { citations: answer.citations,
      claims: answer.claims,
      rawRetrievalResponseSha256: retrieval.rawResponseSha256,
      retrievalCandidates: retrieval.candidates, selectedTurns: evidence.turns,
      status: answer.status });
  }

  private async complete(attemptId: string, input: QualificationQuestionOutcome):
  Promise<QualificationQuestionOutcome> {
    const outcome = freezeOutcome(input);
    await this.ports.outcome.record(attemptId, outcome);
    return outcome;
  }
}

function assertExecutionPacket(input: QualificationExecutionPacket): void {
  if (typeof input !== "object" || input === null ||
    JSON.stringify(Object.keys(input).toSorted()) !== JSON.stringify([...EXECUTION_PACKET_KEYS].toSorted()) ||
    !["en", "mixed", "ru"].includes(input.locale) ||
    !["automatic", "independent_review"].includes(input.source) ||
    [input.questionId, input.questionText, input.scopeTopologyReference]
      .some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("qualification execution packet is invalid or gold-bearing");
  }
}

function assertOrderedCandidates(candidates: readonly QualificationRetrievalCandidate[]): void {
  const locators = new Set<string>();
  for (const candidate of candidates) {
    if (locators.has(candidate.locatorId) || !Number.isSafeInteger(candidate.providerRank) ||
      candidate.providerRank < 0 || candidate.locatorId.length === 0 ||
      candidate.contributions.some((value) => !Number.isSafeInteger(value.providerRank) ||
        !Number.isSafeInteger(value.contributionScorePicos))) {
      throw new Error("qualification retrieval candidates are invalid or duplicated");
    }
    locators.add(candidate.locatorId);
  }
}

function assertSelectedEvidence(locatorIds: readonly string[],
  turns: readonly QualificationCanonicalTurn[]): void {
  const admitted = new Set(locatorIds);
  const turnIds = new Set<string>();
  for (const turn of turns) {
    if (!admitted.has(turn.sourceLocatorId) || turnIds.has(turn.turnId)) {
      throw new Error("qualification evidence is duplicated or outside selected locators");
    }
    turnIds.add(turn.turnId);
  }
}

function assertEvidenceBytes(turns: readonly QualificationCanonicalTurn[]): void {
  const bytes = new TextEncoder().encode(JSON.stringify(turns)).byteLength;
  if (bytes > 16_000) {throw new Error("qualification selected evidence exceeds 16000 UTF-8 bytes");}
}

function freezeOutcome(input: QualificationQuestionOutcome): QualificationQuestionOutcome {
  return Object.freeze({ ...input, citations: Object.freeze([...input.citations]),
    claims: Object.freeze([...input.claims]), retrievalCandidates:
      Object.freeze(input.retrievalCandidates.map((candidate) => Object.freeze({ ...candidate,
        contributions: Object.freeze(candidate.contributions.map((item) => Object.freeze({ ...item }))) }))),
    selectedTurns: Object.freeze(input.selectedTurns.map((turn) => Object.freeze({ ...turn }))) });
}

/** Authenticated persistence decoder used only when resuming a durable canonical attempt. */
export function decodeQualificationQuestionOutcome(value: unknown): QualificationQuestionOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted qualification outcome is invalid");
  }
  const record = value as Record<string, unknown>;
  const required = ["citations", "claims", "rawRetrievalResponseSha256",
    "retrievalCandidates", "selectedTurns", "status"];
  const allowed = new Set([...required, "reason"]);
  if (required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key)) ||
    !Array.isArray(record.citations) || !record.citations.every((item) => typeof item === "string") ||
    !Array.isArray(record.claims) || !record.claims.every((item) => typeof item === "string") ||
    !Array.isArray(record.retrievalCandidates) || !Array.isArray(record.selectedTurns) ||
    !["abstained", "answered", "failed"].includes(String(record.status)) ||
    !(record.rawRetrievalResponseSha256 === null || typeof record.rawRetrievalResponseSha256 ===
      "string" && /^[a-f0-9]{64}$/u.test(record.rawRetrievalResponseSha256)) ||
    !(record.reason === undefined || typeof record.reason === "string")) {
    throw new Error("persisted qualification outcome is invalid");
  }
  const outcome = record as unknown as QualificationQuestionOutcome;
  assertOrderedCandidates(outcome.retrievalCandidates);
  assertEvidenceBytes(outcome.selectedTurns);
  return freezeOutcome(outcome);
}
