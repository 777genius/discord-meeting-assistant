import { normalizeTranscriptSemantics } from "./e2e-evidence-text-metrics.js";
import type {
  RetainedE2eEvidenceV8,
  RetainedE2eEvidenceV9,
  RetainedVoiceE2eEvidenceV10,
} from "./e2e-evidence-schema.js";
import type {
  VerificationFailureReporter,
} from "./e2e-evidence-verification-types.js";

interface BotikFarewellExpectation {
  readonly duplicateTerms: readonly string[];
  readonly endMs: number;
  readonly exactPhrases: readonly string[];
  readonly locale: "en" | "ru";
  readonly requiredTerms: readonly string[];
  readonly startMs: number;
}

const maximumSplitTurnGapMs = 500;

export function verifyBotikFarewellTranscript(
  evidence: RetainedE2eEvidenceV8 | RetainedE2eEvidenceV9 | RetainedVoiceE2eEvidenceV10,
  expectation: BotikFarewellExpectation,
  fail: VerificationFailureReporter,
): void {
  const botikTurns = evidence.transcript.turns.filter(
    ({ speakerId }) => speakerId === evidence.conversation.botSpeakerId,
  );
  const overlappingTurns = botikTurns.filter((turn) =>
    turn.startMs < expectation.endMs && expectation.startMs < turn.endMs
  );
  const capturedFarewell = overlappingTurns[0];
  const fullyContained = capturedFarewell !== undefined &&
    capturedFarewell.startMs >= expectation.startMs &&
    capturedFarewell.endMs <= expectation.endMs;
  const hasCapturedSemanticFarewell = capturedFarewell !== undefined &&
    fullyContained && matchesExactPhrase(capturedFarewell.text, expectation.exactPhrases);
  if (
    expectation.requiredTerms.length === 0 || expectation.exactPhrases.length === 0 ||
    overlappingTurns.length !== 1 ||
    !hasCapturedSemanticFarewell
  ) {
    fail(
      "SUPPLEMENTAL_FAREWELL_SEMANTICS_MISSING",
      `audible ${expectation.locale} farewell must overlap exactly one semantic Botik transcript turn`,
    );
  }
  if (
    hasCapturedSemanticFarewell &&
    containsFarewellOutsideCapture(botikTurns, capturedFarewell, expectation)
  ) {
    fail(
      "SUPPLEMENTAL_FAREWELL_DUPLICATE",
      "a second farewell-shaped Botik turn exists outside the settled farewell capture",
    );
  }
}

export function verifyPreparedFarewellPlayback(
  evidence: RetainedVoiceE2eEvidenceV10,
  maximumFirstPacketMilliseconds: number,
  fail: VerificationFailureReporter,
): void {
  const farewellEvents = evidence.conversation.lifecycle.events.filter(
    (event): event is Extract<typeof event, { readonly type: "farewell" }> =>
      event.type === "farewell",
  );
  const farewellCaptures = evidence.conversation.voice.filter(
    ({ correlation }) => correlation.purpose === "farewell",
  );
  const farewell = farewellEvents[0];
  const capture = farewellCaptures[0];
  if (farewellEvents.length !== 1 || farewellCaptures.length !== 1 ||
    farewell === undefined || capture === undefined ||
    capture.correlation.attemptId !== farewell.playbackAttemptId) {
    fail(
      "FAREWELL_PREPARED_CUE_PROVENANCE_MISSING",
      "current farewell evidence must bind one audible capture to one prepared cue attempt",
    );
    return;
  }
  const receipts = evidence.conversation.lifecycle.playbackReceipts.filter(
    ({ playbackAttemptId, turnId }) =>
      playbackAttemptId === farewell.playbackAttemptId && turnId === farewell.turnId,
  );
  const started = receipts.filter(
    (receipt): receipt is Extract<typeof receipt, { readonly status: "started" }> =>
      receipt.status === "started",
  );
  const finished = receipts.filter(
    (receipt): receipt is Extract<typeof receipt, { readonly status: "finished" }> =>
      receipt.status === "finished",
  );
  const settled = receipts.filter(
    (receipt): receipt is Extract<typeof receipt, { readonly status: "settled" }> =>
      receipt.status === "settled",
  );
  const assetDigests = new Set(receipts.map(({ preparedAssetSha256 }) => preparedAssetSha256));
  if (receipts.length !== 3 || started.length !== 1 || finished.length !== 1 ||
    settled.length !== 1 || receipts.some(({ playbackKind }) => playbackKind !== "prepared-cue") ||
    assetDigests.size !== 1 || !/^[a-f\d]{64}$/u.test([...assetDigests][0] ?? "") ||
    settled[0]?.settlement !== "played") {
    fail(
      "FAREWELL_PREPARED_CUE_PROVENANCE_MISSING",
      "current farewell must retain started, finished and played receipts for one checksum-pinned prepared asset",
    );
    return;
  }
  const startedAt = started[0]!.playbackStartedAtEpochMs;
  const firstPacketAt = capture.capture.firstPacketAt.epochMilliseconds;
  if (firstPacketAt < startedAt ||
    firstPacketAt - startedAt > maximumFirstPacketMilliseconds) {
    fail(
      "FAREWELL_PREPARED_CUE_LATENCY_EXCEEDED",
      "prepared farewell first packet exceeds the governed low-latency threshold",
    );
  }
}

function containsFarewellOutsideCapture(
  turns: readonly RetainedE2eEvidenceV8["transcript"]["turns"][number][],
  capturedFarewell: RetainedE2eEvidenceV8["transcript"]["turns"][number],
  expectation: BotikFarewellExpectation,
): boolean {
  const outside = turns.filter((turn) => turn !== capturedFarewell).toSorted(
    (left, right) => left.startMs - right.startMs ||
      left.endMs - right.endMs || left.turnId.localeCompare(right.turnId),
  );
  for (let index = 0; index < outside.length; index += 1) {
    const current = outside[index]!;
    const adjacent = outside[index + 1];
    if (containsAnyWholeTerm(current.text, expectation.duplicateTerms)) {
      return true;
    }
    if (
      adjacent !== undefined &&
      adjacent.startMs >= current.endMs &&
      adjacent.startMs - current.endMs <= maximumSplitTurnGapMs &&
      containsAnyWholeTerm(`${current.text} ${adjacent.text}`, expectation.duplicateTerms)
    ) {
      return true;
    }
  }
  return false;
}

function matchesExactPhrase(text: string, phrases: readonly string[]): boolean {
  const normalized = normalizeTranscriptSemantics(text);
  return phrases.some((phrase) => normalized === normalizeTranscriptSemantics(phrase));
}

export function turnsContainingAnyTerms<T extends { readonly text: string }>(
  turns: readonly T[],
  terms: readonly string[],
): readonly T[] {
  return turns.filter(({ text }) => containsAnyWholeTerm(text, terms));
}

function containsAnyWholeTerm(text: string, terms: readonly string[]): boolean {
  const normalizedText = normalizeTranscriptSemantics(text);
  return terms.some((term) =>
    containsWholeTerm(normalizedText, normalizeTranscriptSemantics(term))
  );
}

function containsWholeTerm(normalizedText: string, normalizedTerm: string): boolean {
  return ` ${normalizedText} `.includes(` ${normalizedTerm} `);
}
