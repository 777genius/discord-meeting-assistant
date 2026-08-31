import { createHash } from "node:crypto";

import type { CampaignQuestion } from "./campaign-admission-policy.js";
import { attemptIdentity } from "./execution.js";
import type { VerifiedSpendReservation } from "./execution.js";
import { DurableAttemptJournal } from "./attempt-journal.js";
import type { QualificationExecutionPacket, QualificationQuestionExecutorFactoryPort,
  QualificationQuestionOutcome } from "./execute-admitted-qualification-question.js";
import type { CampaignClockPort } from "./production-ports.js";
import type { QualityCampaignAuthorityPolicy } from "./release.js";

const PER_QUESTION_DEADLINE_MS = 120_000;

export interface CanonicalScheduledCampaignResult {
  readonly completedOutcomes: number;
  readonly executionChainSha256: string;
  readonly maximumObservedConcurrency: number;
  readonly outcomeUnknown: boolean;
  readonly terminalAttemptIds: readonly string[];
}

/** Runs the sole installed main-question engine without a second retrieval or answer path. */
export async function executeCanonicalMainCampaignSchedule(input: {
  readonly campaignRootSha256: string;
  readonly clock: CampaignClockPort;
  readonly concurrency: number;
  readonly deadlineEpochMs: number;
  readonly executionPackets: readonly QualificationExecutionPacket[];
  readonly executorFactory: QualificationQuestionExecutorFactoryPort;
  readonly journalRoot: string;
  readonly policy: QualityCampaignAuthorityPolicy;
  readonly questions: readonly CampaignQuestion[];
  readonly release: { readonly answerProcessIdentitySha256: string;
    readonly infinityCapabilitySha256: string; readonly mapperSha256: string;
    readonly tokenizerSha256: string };
  readonly releaseRootSha256: string;
  readonly reservations: readonly VerifiedSpendReservation[];
  readonly spendReservationSha256ByRepetition: Readonly<Record<1 | 2 | 3, string>>;
}): Promise<CanonicalScheduledCampaignResult> {
  assertScheduleInput(input);
  const journal = new DurableAttemptJournal(input.journalRoot, input.policy);
  const claimedAttemptIds = new Set<string>();
  for (const reservation of input.reservations) {
    const claims = await journal.loadAdmittedClaims(reservation);
    for (const claim of claims) {
      if (typeof claim === "object" && claim !== null && "attemptId" in claim &&
        typeof claim.attemptId === "string") {claimedAttemptIds.add(claim.attemptId);}
    }
  }
  const packets = new Map(input.executionPackets.map((packet) => [packet.questionId, packet]));
  const jobs = ([1, 2, 3] as const).flatMap((repetition) => input.questions.map((question) =>
    ({ packet: packets.get(question.questionId)!, question, repetition })));
  let cursor = 0;
  let active = 0;
  let maximumObservedConcurrency = 0;
  let outcomeUnknown = false;
  const terminals: { readonly attemptId: string; readonly outcome: QualificationQuestionOutcome }[] = [];
  const unknownAttemptIds: string[] = [];
  const worker = async () => {
    while (!outcomeUnknown) {
      const job = jobs[cursor++];
      if (job === undefined) {return;}
      active += 1;
      maximumObservedConcurrency = Math.max(maximumObservedConcurrency, active);
      const identity = attemptIdentity({ callKind: "answer", callOrdinal: 0,
        campaignRootSha256: input.campaignRootSha256,
        questionDigestSha256: job.question.questionDigestSha256,
        questionId: job.question.questionId, releaseRootSha256: input.releaseRootSha256,
        repetition: job.repetition,
        spendReservationSha256:
          input.spendReservationSha256ByRepetition[job.repetition] });
      const controller = new AbortController();
      const remaining = input.deadlineEpochMs - input.clock.nowEpochMs();
      if (!Number.isSafeInteger(remaining) || remaining <= 0) {
        active -= 1;
        throw new Error("shared 72 hour campaign deadline exceeded");
      }
      const timeout = setTimeout(() => {controller.abort(new Error(
        "canonical qualification question deadline exceeded"));},
      Math.min(remaining, PER_QUESTION_DEADLINE_MS));
      try {
        const recovered = await input.executorFactory.recover({ attemptId: identity.attemptId,
          campaignRootSha256: input.campaignRootSha256, questionId: job.question.questionId,
          repetition: job.repetition });
        if (recovered === "outcome_unknown") {
          outcomeUnknown = true;
          unknownAttemptIds.push(identity.attemptId);
          return;
        }
        if (recovered !== null) {
          terminals.push(Object.freeze({ attemptId: identity.attemptId, outcome: recovered }));
          continue;
        }
        const effectIdentity = (effectKind: "answer" | "capability" | "retrieval") =>
          attemptIdentity({ callKind: effectKind, callOrdinal: 0,
            campaignRootSha256: input.campaignRootSha256,
            questionDigestSha256: job.question.questionDigestSha256,
            questionId: job.question.questionId, releaseRootSha256: input.releaseRootSha256,
            repetition: job.repetition, spendReservationSha256:
              input.spendReservationSha256ByRepetition[job.repetition] });
        if ((["capability", "retrieval", "answer"] as const).some((effectKind) =>
          claimedAttemptIds.has(effectIdentity(effectKind).attemptId))) {
          outcomeUnknown = true;
          unknownAttemptIds.push(identity.attemptId);
          return;
        }
        const spend = input.reservations.find(({ payload }) =>
          payload.repetition === job.repetition)!;
        const reservation = Object.freeze({ reserve: async (effect: {
          readonly effectKind: "answer" | "capability" | "retrieval";
          readonly payloadSha256: string; readonly requestedEncryptedBytes: number;
          readonly requestedTokens: number }) => {
          const effectAttempt = effectIdentity(effect.effectKind);
          const admitted = await journal.admit({ identity: effectAttempt,
            requestDigestSha256: effect.payloadSha256,
            requestedEncryptedBytes: effect.requestedEncryptedBytes,
            requestedTokens: effect.requestedTokens, spend });
          if (!admitted.admitted) {
            throw new Error("canonical provider external effect is unknown and terminal");
          }
          claimedAttemptIds.add(effectAttempt.attemptId);
        } });
        const executor = await input.executorFactory.create({ attemptId: identity.attemptId,
          answerProcessIdentitySha256: input.release.answerProcessIdentitySha256,
          campaignRootSha256: input.campaignRootSha256, questionId: job.question.questionId,
          infinityCapabilitySha256: input.release.infinityCapabilitySha256,
          mapperSha256: input.release.mapperSha256,
          releaseRootSha256: input.releaseRootSha256, repetition: job.repetition,
          reservation,
          spendReservationSha256:
            input.spendReservationSha256ByRepetition[job.repetition],
          tokenizerSha256: input.release.tokenizerSha256 });
        const outcome = await executor.execute(job.packet, { attemptId: identity.attemptId,
          signal: controller.signal });
        terminals.push(Object.freeze({ attemptId: identity.attemptId, outcome }));
      } catch (error) {
        if (isUnknownExternalEffect(error)) {
          outcomeUnknown = true;
          unknownAttemptIds.push(identity.attemptId);
          return;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        active -= 1;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: input.concurrency }, worker));
  const failure = settled.find((value): value is PromiseRejectedResult =>
    value.status === "rejected");
  if (failure !== undefined) {throw failure.reason;}
  const ordered = terminals.toSorted((left, right) => left.attemptId.localeCompare(right.attemptId));
  const terminalAttemptIds = [...ordered.map(({ attemptId }) => attemptId), ...unknownAttemptIds]
    .toSorted();
  return Object.freeze({ completedOutcomes: terminalAttemptIds.length,
    executionChainSha256: exactOutcomeChainSha256({ outcomes: ordered,
      unknownAttemptIds: unknownAttemptIds.toSorted() }),
    maximumObservedConcurrency, outcomeUnknown,
    terminalAttemptIds: Object.freeze(terminalAttemptIds) });
}

function exactOutcomeChainSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableFiniteValue(value)), "utf8").digest("hex");
}

function stableFiniteValue(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {throw new Error("canonical outcome contains a non-finite number");}
    return value;
  }
  if (Array.isArray(value)) {return value.map(stableFiniteValue);}
  if (value === null || typeof value !== "object") {return value;}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableFiniteValue(item)]));
}

function assertScheduleInput(input: Parameters<typeof executeCanonicalMainCampaignSchedule>[0]): void {
  if (input.questions.length !== 240 || input.executionPackets.length !== 240 ||
    input.reservations.length !== 3 ||
    !Number.isSafeInteger(input.concurrency) || input.concurrency < 2 || input.concurrency > 32) {
    throw new Error("canonical production schedule cardinality or concurrency is invalid");
  }
  const packets = new Map(input.executionPackets.map((packet) => [packet.questionId, packet]));
  if (packets.size !== input.executionPackets.length || input.questions.some((question) => {
    const packet = packets.get(question.questionId);
    return packet === undefined || packet.locale !== question.locale || packet.source !== question.source;
  })) {
    throw new Error("canonical execution corpus differs from admitted questions");
  }
}

function isUnknownExternalEffect(error: unknown): boolean {
  return error instanceof Error && (/external effect is unknown/iu.test(error.message) ||
    /external effect unknown/iu.test(error.message));
}
