import { MAIN_CARDINALITY, type CampaignQuestion } from "./admission.js";
import { canonicalJson, digest, exactRecord, sha256 } from "./canonical.js";
import { DurableAttemptJournal } from "./attempt-journal.js";
import { attemptIdentity, executeReservedExchange } from "./execution.js";
import { type PinnedReleaseDocument, QualityCampaignAuthorityPolicy,
  verifyPinnedReleaseDocument } from "./release.js";
import type { CampaignClockPort, CampaignProviderPorts } from "./production-ports.js";
import type { ExactTerminalEvidence } from "./production-evidence.js";

const PER_CALL_DEADLINE_MS = 120_000;
const CALLS = Object.freeze(["capability", "retrieval", "answer"] as const);

export interface FrozenExecutionBinding {
  readonly campaignRootSha256: string;
  readonly provider: string;
  readonly release: PinnedReleaseDocument;
  readonly releaseRootSha256: string;
  readonly policy: QualityCampaignAuthorityPolicy;
  readonly spendReservation: unknown;
  readonly spendReservationSha256: string;
}

export interface ScheduledCampaignResult {
  readonly completedOutcomes: number;
  readonly executionChainSha256: string;
  readonly maximumObservedConcurrency: number;
  readonly outcomeUnknown: boolean;
  readonly terminalAttemptIds: readonly string[];
}

export interface ScheduledExactOutcome {
  readonly answerAttemptId: string;
  readonly answerIdentity: ReturnType<typeof attemptIdentity>;
  readonly terminalChain: readonly ExactTerminalEvidence[];
}

export async function executeMainCampaignSchedule(input: {
  readonly binding: Omit<FrozenExecutionBinding, "provider" | "spendReservation" |
    "spendReservationSha256">;
  readonly clock: CampaignClockPort; readonly concurrency: number;
  readonly deadlineEpochMs: number; readonly journalRoot: string;
  readonly ports: CampaignProviderPorts; readonly questions: readonly CampaignQuestion[];
  readonly spendByRepetition: Readonly<Record<1 | 2 | 3, {
    readonly provider: string; readonly reservation: unknown;
    readonly reservationSha256: string }>>;
}): Promise<ScheduledCampaignResult> {
  if (input.questions.length !== MAIN_CARDINALITY.perRepetition) {
    throw new Error("production schedule requires exactly 240 questions");
  }
  return await executeSchedule({ bindingFor: (repetition) => ({ ...input.binding,
    provider: input.spendByRepetition[repetition].provider,
    spendReservation: input.spendByRepetition[repetition].reservation,
    spendReservationSha256: input.spendByRepetition[repetition].reservationSha256 }),
  clock: input.clock, concurrency: input.concurrency, deadlineEpochMs: input.deadlineEpochMs,
    jobs: ([1, 2, 3] as const).flatMap((repetition) => input.questions.map((question,
      questionIndex) => ({ question, questionIndex, repetition }))),
  journalRoot: input.journalRoot, ports: input.ports });
}

export async function executeHoldoutSchedule(input: {
  readonly binding: Omit<FrozenExecutionBinding, "provider" | "spendReservation" |
    "spendReservationSha256">; readonly clock: CampaignClockPort;
  readonly concurrency: number; readonly deadlineEpochMs: number; readonly journalRoot: string;
  readonly ports: CampaignProviderPorts; readonly questions: readonly CampaignQuestion[];
  readonly spendByRepetition: Readonly<Record<1 | 2 | 3, { readonly provider: string;
    readonly reservation: unknown; readonly reservationSha256: string }>>;
}): Promise<ScheduledCampaignResult> {
  if (input.questions.length !== 30) {throw new Error("holdout schedule requires exactly 30 questions");}
  return await executeSchedule({ bindingFor: (repetition) => ({ ...input.binding,
    provider: input.spendByRepetition[repetition].provider,
    spendReservation: input.spendByRepetition[repetition].reservation,
    spendReservationSha256: input.spendByRepetition[repetition].reservationSha256 }),
    clock: input.clock,
    concurrency: input.concurrency, deadlineEpochMs: input.deadlineEpochMs,
    jobs: ([1, 2, 3] as const).flatMap((repetition) => input.questions.map(
      (question, questionIndex) => ({ question, questionIndex, repetition }))),
    journalRoot: input.journalRoot, ports: input.ports,
    resultAuthorityRole: "holdout_provider_result" });
}

async function executeSchedule(input: {
  readonly bindingFor: (repetition: 1 | 2 | 3) => FrozenExecutionBinding;
  readonly clock: CampaignClockPort;
  readonly concurrency: number; readonly deadlineEpochMs: number;
  readonly jobs: readonly { readonly question: CampaignQuestion; readonly questionIndex: number;
    readonly repetition: 1 | 2 | 3 }[]; readonly journalRoot: string;
  readonly ports: CampaignProviderPorts;
  readonly resultAuthorityRole?: "holdout_provider_result" | "provider_result";
}): Promise<ScheduledCampaignResult> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 2 || input.concurrency > 32) {
    throw new Error("production concurrency must be bounded between 2 and 32");
  }
  const journal = new DurableAttemptJournal(input.journalRoot, input.bindingFor(1).policy,
    input.resultAuthorityRole);
  let cursor = 0; let active = 0; let maximumObservedConcurrency = 0;
  let outcomeUnknown = false;
  const terminalAttemptIds: string[] = [];
  const exactOutcomes: ScheduledExactOutcome[] = [];
  const worker = async () => {
    while (!outcomeUnknown) {
      const index = cursor++;
      const job = input.jobs[index];
      if (job === undefined) {return;}
      active += 1; maximumObservedConcurrency = Math.max(maximumObservedConcurrency, active);
      try {
        const terminal = await executeQuestion({ binding: input.bindingFor(job.repetition),
          clock: input.clock, deadlineEpochMs: input.deadlineEpochMs, job, journal,
          ports: input.ports });
        if (terminal === null) {outcomeUnknown = true; return;}
        terminalAttemptIds.push(terminal.answerAttemptId);
        exactOutcomes.push(terminal);
      } finally {active -= 1;}
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: input.concurrency }, worker));
  const failure = settled.find((value): value is PromiseRejectedResult =>
    value.status === "rejected");
  if (failure !== undefined) {throw failure.reason;}
  return Object.freeze({ completedOutcomes: terminalAttemptIds.length,
    executionChainSha256: sha256(exactOutcomes.toSorted((a, b) =>
      a.answerAttemptId.localeCompare(b.answerAttemptId))),
    maximumObservedConcurrency, outcomeUnknown,
    terminalAttemptIds: Object.freeze(terminalAttemptIds.toSorted()) });
}

export async function loadScheduledExactOutcomes(input: {
  readonly campaignRootSha256: string; readonly journalRoot: string;
  readonly policy: QualityCampaignAuthorityPolicy; readonly questions: readonly CampaignQuestion[];
  readonly releaseRootSha256: string;
  readonly resultAuthorityRole?: "holdout_provider_result" | "provider_result";
  readonly spendReservationSha256ByRepetition: Readonly<Record<1 | 2 | 3, string>>;
}): Promise<readonly ScheduledExactOutcome[]> {
  const journal = new DurableAttemptJournal(input.journalRoot, input.policy,
    input.resultAuthorityRole);
  return Object.freeze(await Promise.all(([1, 2, 3] as const).flatMap((repetition) =>
    input.questions.map(async (question) => {
      let predecessor: { readonly bytes: Uint8Array; readonly digestSha256: string } | null = null;
      const terminalChain: ExactTerminalEvidence[] = [];
      for (const callKind of CALLS) {
        const identity = attemptIdentity({ callKind, callOrdinal: 0,
          campaignRootSha256: input.campaignRootSha256,
          questionDigestSha256: question.questionDigestSha256, questionId: question.questionId,
          releaseRootSha256: input.releaseRootSha256, repetition,
          spendReservationSha256: input.spendReservationSha256ByRepetition[repetition] });
        const completed = await journal.completedExchange(identity);
        assertExactRequest(completed.requestBytes, { callKind, identity, predecessor });
        terminalChain.push(Object.freeze({ attemptId: identity.attemptId, callKind,
          callOrdinal: 0, predecessorResultDigestSha256: predecessor?.digestSha256 ?? null,
          requestDigestSha256: completed.requestDigestSha256,
          resultEnvelopeDigestSha256: completed.resultEnvelopeDigestSha256,
          signedResult: completed.signedResult,
          terminalDigestSha256: completed.terminalDigestSha256 }));
        predecessor = { bytes: completed.resultEnvelopeBytes,
          digestSha256: completed.resultEnvelopeDigestSha256 };
      }
      const answerIdentity = attemptIdentity({ callKind: "answer", callOrdinal: 0,
        campaignRootSha256: input.campaignRootSha256,
        questionDigestSha256: question.questionDigestSha256, questionId: question.questionId,
        releaseRootSha256: input.releaseRootSha256, repetition,
        spendReservationSha256: input.spendReservationSha256ByRepetition[repetition] });
      return Object.freeze({ answerAttemptId: terminalChain[2]!.attemptId, answerIdentity,
        terminalChain: Object.freeze(terminalChain) });
    }))));
}

function assertExactRequest(bytes: Uint8Array, input: { readonly callKind: typeof CALLS[number];
  readonly identity: ReturnType<typeof attemptIdentity>;
  readonly predecessor: { readonly bytes: Uint8Array; readonly digestSha256: string } | null }): void {
  let parsed: unknown;
  try {parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));}
  catch {throw new Error("scheduled provider request bytes are not canonical JSON");}
  const request = exactRecord(parsed, ["attemptId", "callKind",
    "campaignDeadlineEpochMs", "campaignRootSha256", "predecessorResultEnvelopeBase64",
    "predecessorResultEnvelopeDigestSha256", "questionDigestSha256", "questionId", "release",
    "releaseRootSha256", "repetition", "schemaVersion", "spendReservationSha256"],
  "scheduled provider request");
  const predecessorBase64 = input.predecessor === null ? null :
    Buffer.from(input.predecessor.bytes).toString("base64");
  if (canonicalJson(parsed) !== Buffer.from(bytes).toString("utf8") ||
    request.schemaVersion !== "meeting_knowledge.semantic_quality_provider_request.v1" ||
    request.attemptId !== input.identity.attemptId || request.callKind !== input.callKind ||
    request.campaignRootSha256 !== input.identity.campaignRootSha256 ||
    request.questionDigestSha256 !== input.identity.questionDigestSha256 ||
    request.questionId !== input.identity.questionId ||
    request.releaseRootSha256 !== input.identity.releaseRootSha256 ||
    request.repetition !== input.identity.repetition ||
    request.spendReservationSha256 !== input.identity.spendReservationSha256 ||
    request.predecessorResultEnvelopeBase64 !== predecessorBase64 ||
    request.predecessorResultEnvelopeDigestSha256 !==
      (input.predecessor?.digestSha256 ?? null)) {
    throw new Error("scheduled request is missing, reordered, replayed, or substituted");
  }
  if (input.predecessor !== null) {
    digest(request.predecessorResultEnvelopeDigestSha256, "scheduled predecessor digest");
  }
}

async function executeQuestion(input: {
  readonly binding: FrozenExecutionBinding; readonly clock: CampaignClockPort;
  readonly deadlineEpochMs: number; readonly job: { readonly question: CampaignQuestion;
    readonly questionIndex: number; readonly repetition: 1 | 2 | 3 };
  readonly journal: DurableAttemptJournal;
  readonly ports: CampaignProviderPorts;
}): Promise<ScheduledExactOutcome | null> {
  const terminalChain: ExactTerminalEvidence[] = [];
  let predecessor: { readonly bytes: Uint8Array; readonly digestSha256: string } | null = null;
  for (const callKind of CALLS) {
    const nowEpochMs = input.clock.nowEpochMs();
    if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs >= input.deadlineEpochMs) {
      throw new Error("shared 72 hour campaign deadline exceeded");
    }
    const identity = attemptIdentity({ callKind, callOrdinal: 0,
      campaignRootSha256: input.binding.campaignRootSha256,
      questionDigestSha256: input.job.question.questionDigestSha256,
      questionId: input.job.question.questionId,
      releaseRootSha256: input.binding.releaseRootSha256, repetition: input.job.repetition,
      spendReservationSha256: input.binding.spendReservationSha256 });
    const callDeadlineEpochMs = Math.min(input.deadlineEpochMs, nowEpochMs + PER_CALL_DEADLINE_MS);
    const request = Buffer.from(canonicalJson({ attemptId: identity.attemptId,
      callKind, campaignDeadlineEpochMs: input.deadlineEpochMs,
      campaignRootSha256: input.binding.campaignRootSha256,
      predecessorResultEnvelopeBase64: predecessor === null ? null :
        Buffer.from(predecessor.bytes).toString("base64"),
      predecessorResultEnvelopeDigestSha256: predecessor?.digestSha256 ?? null,
      questionDigestSha256: input.job.question.questionDigestSha256,
      questionId: input.job.question.questionId,
      release: verifyPinnedReleaseDocument(input.binding.policy, input.binding.release).release,
      releaseRootSha256: input.binding.releaseRootSha256, repetition: input.job.repetition,
      schemaVersion: "meeting_knowledge.semantic_quality_provider_request.v1",
      spendReservationSha256: input.binding.spendReservationSha256 }));
    const controller = new AbortController();
    const timeout = setTimeout(() => {controller.abort(new Error("production call deadline exceeded"));},
      Math.max(0, callDeadlineEpochMs - nowEpochMs));
    let state;
    try {
      state = await executeReservedExchange({ campaignRootSha256:
        input.binding.campaignRootSha256, deadlineEpochMs: callDeadlineEpochMs,
      effectReservation: { requestedEncryptedBytes: request.byteLength, requestedTokens: 1 },
      identity, journal: input.journal, nowEpochMs, port: input.ports[callKind],
      provider: input.binding.provider, release: input.binding.release, request,
      signal: controller.signal, spendReservation: input.binding.spendReservation });
    } catch (error) {
      if (controller.signal.aborted || (error as Error).name === "AbortError") {return null;}
      throw error;
    } finally {clearTimeout(timeout);}
    if (state === "outcome_unknown") {return null;}
    if (state !== "terminal_success") {throw new Error(`${callKind} failed terminally`);}
    const completed = await input.journal.completedExchange(identity);
    const terminal = Object.freeze({ attemptId: identity.attemptId, callKind, callOrdinal: 0,
      predecessorResultDigestSha256: predecessor?.digestSha256 ?? null,
      requestDigestSha256: completed.requestDigestSha256,
      resultEnvelopeDigestSha256: completed.resultEnvelopeDigestSha256,
      signedResult: completed.signedResult,
      terminalDigestSha256: completed.terminalDigestSha256 });
    terminalChain.push(terminal);
    predecessor = { bytes: completed.resultEnvelopeBytes,
      digestSha256: completed.resultEnvelopeDigestSha256 };
  }
  const answerIdentity = attemptIdentity({ callKind: "answer", callOrdinal: 0,
    campaignRootSha256: input.binding.campaignRootSha256,
    questionDigestSha256: input.job.question.questionDigestSha256,
    questionId: input.job.question.questionId, releaseRootSha256: input.binding.releaseRootSha256,
    repetition: input.job.repetition,
    spendReservationSha256: input.binding.spendReservationSha256 });
  return Object.freeze({ answerAttemptId: terminalChain[2]!.attemptId, answerIdentity,
    terminalChain: Object.freeze(terminalChain) });
}

export function executionRequestBindingSha256(input: FrozenExecutionBinding): string {
  return sha256(input);
}
