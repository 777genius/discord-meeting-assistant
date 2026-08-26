import { MAIN_CARDINALITY, type CampaignQuestion } from "./admission.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { attemptIdentity, DurableAttemptJournal, executeReservedExchange } from "./execution.js";
import type { QualityCampaignRelease } from "./release.js";
import type { CampaignClockPort, CampaignProviderPorts } from "./production-ports.js";

const PER_CALL_DEADLINE_MS = 120_000;
const CALLS = Object.freeze(["capability", "retrieval", "answer"] as const);

export interface FrozenExecutionBinding {
  readonly campaignRootSha256: string;
  readonly release: QualityCampaignRelease;
  readonly releaseRootSha256: string;
  readonly spendReservationSha256: string;
}

export interface ScheduledCampaignResult {
  readonly completedOutcomes: number;
  readonly maximumObservedConcurrency: number;
  readonly outcomeUnknown: boolean;
  readonly terminalAttemptIds: readonly string[];
}

export async function executeMainCampaignSchedule(input: {
  readonly binding: Omit<FrozenExecutionBinding, "spendReservationSha256">;
  readonly clock: CampaignClockPort; readonly concurrency: number;
  readonly deadlineEpochMs: number; readonly journalRoot: string;
  readonly ports: CampaignProviderPorts; readonly questions: readonly CampaignQuestion[];
  readonly spendReservationSha256ByRepetition: Readonly<Record<1 | 2 | 3, string>>;
}): Promise<ScheduledCampaignResult> {
  if (input.questions.length !== MAIN_CARDINALITY.perRepetition) {
    throw new Error("production schedule requires exactly 240 questions");
  }
  return await executeSchedule({ bindingFor: (repetition) => ({ ...input.binding,
    spendReservationSha256: input.spendReservationSha256ByRepetition[repetition] }),
  clock: input.clock, concurrency: input.concurrency, deadlineEpochMs: input.deadlineEpochMs,
  jobs: ([1, 2, 3] as const).flatMap((repetition) => input.questions.map((question) =>
    ({ question, repetition }))), journalRoot: input.journalRoot, ports: input.ports });
}

export async function executeHoldoutSchedule(input: {
  readonly binding: FrozenExecutionBinding; readonly clock: CampaignClockPort;
  readonly concurrency: number; readonly deadlineEpochMs: number; readonly journalRoot: string;
  readonly ports: CampaignProviderPorts; readonly questions: readonly CampaignQuestion[];
}): Promise<ScheduledCampaignResult> {
  if (input.questions.length !== 30) {throw new Error("holdout schedule requires exactly 30 questions");}
  return await executeSchedule({ bindingFor: () => input.binding, clock: input.clock,
    concurrency: input.concurrency, deadlineEpochMs: input.deadlineEpochMs,
    jobs: input.questions.map((question) => ({ question, repetition: 1 as const })),
    journalRoot: input.journalRoot, ports: input.ports });
}

async function executeSchedule(input: {
  readonly bindingFor: (repetition: 1 | 2 | 3) => FrozenExecutionBinding;
  readonly clock: CampaignClockPort;
  readonly concurrency: number; readonly deadlineEpochMs: number;
  readonly jobs: readonly { readonly question: CampaignQuestion;
    readonly repetition: 1 | 2 | 3 }[]; readonly journalRoot: string;
  readonly ports: CampaignProviderPorts;
}): Promise<ScheduledCampaignResult> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 2 || input.concurrency > 32) {
    throw new Error("production concurrency must be bounded between 2 and 32");
  }
  const journal = new DurableAttemptJournal(input.journalRoot, input.ports.resultAuthority);
  let cursor = 0; let active = 0; let maximumObservedConcurrency = 0;
  let outcomeUnknown = false;
  const terminalAttemptIds: string[] = [];
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
        terminalAttemptIds.push(terminal);
      } finally {active -= 1;}
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: input.concurrency }, worker));
  const failure = settled.find((value): value is PromiseRejectedResult =>
    value.status === "rejected");
  if (failure !== undefined) {throw failure.reason;}
  return Object.freeze({ completedOutcomes: terminalAttemptIds.length,
    maximumObservedConcurrency, outcomeUnknown,
    terminalAttemptIds: Object.freeze(terminalAttemptIds.toSorted()) });
}

async function executeQuestion(input: {
  readonly binding: FrozenExecutionBinding; readonly clock: CampaignClockPort;
  readonly deadlineEpochMs: number; readonly job: { readonly question: CampaignQuestion;
    readonly repetition: 1 | 2 | 3 }; readonly journal: DurableAttemptJournal;
  readonly ports: CampaignProviderPorts;
}): Promise<string | null> {
  let answerAttemptId = "";
  for (const [callOrdinal, callKind] of CALLS.entries()) {
    const nowEpochMs = input.clock.nowEpochMs();
    if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs >= input.deadlineEpochMs) {
      throw new Error("shared 72 hour campaign deadline exceeded");
    }
    const identity = attemptIdentity({ callKind, callOrdinal,
      campaignRootSha256: input.binding.campaignRootSha256,
      questionDigestSha256: input.job.question.questionDigestSha256,
      questionId: input.job.question.questionId, repetition: input.job.repetition });
    const request = Buffer.from(canonicalJson({ attemptId: identity.attemptId,
      callDeadlineEpochMs: Math.min(input.deadlineEpochMs, nowEpochMs + PER_CALL_DEADLINE_MS),
      callKind, campaignDeadlineEpochMs: input.deadlineEpochMs,
      campaignRootSha256: input.binding.campaignRootSha256,
      questionDigestSha256: input.job.question.questionDigestSha256,
      questionId: input.job.question.questionId, release: input.binding.release,
      releaseRootSha256: input.binding.releaseRootSha256, repetition: input.job.repetition,
      schemaVersion: "meeting_knowledge.semantic_quality_provider_request.v1",
      spendReservationSha256: input.binding.spendReservationSha256 }));
    const state = await executeReservedExchange({ campaignRootSha256:
      input.binding.campaignRootSha256, identity, journal: input.journal,
      port: input.ports[callKind], request });
    if (state === "outcome_unknown") {return null;}
    if (state !== "terminal_success") {throw new Error(`${callKind} failed terminally`);}
    if (callKind === "answer") {answerAttemptId = identity.attemptId;}
  }
  return answerAttemptId;
}

export function executionRequestBindingSha256(input: FrozenExecutionBinding): string {
  return sha256(input);
}
