import { normalizeTranscriptSemantics } from "./e2e-evidence-text-metrics.js";
import type {
  FixtureManifestV1,
  RetainedE2eEvidenceV8,
} from "./e2e-evidence-schema.js";
import type {
  VerificationFailureReporter,
} from "./e2e-evidence-verification-types.js";

const maximumTurnBoundaryToleranceMs = 250;

interface SupplementalAnswerWindow {
  readonly answerNonce: string;
  readonly farewellStartMs: number;
  readonly playbackEndMs: number;
  readonly playbackStartMs: number;
  readonly questionEndMs: number;
  readonly recordingStartMs: number;
}

interface SupplementalFarewellExpectation {
  readonly humanFarewellEndMs: number;
  readonly locale: "en" | "ru";
  readonly recordingStartMs: number;
}

export function verifySupplementalPlayback(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV8,
  recordingStartMs: number,
  recordingEndMs: number,
  fail: VerificationFailureReporter,
): void {
  const expectation = manifest.supplementalVoiceExpectation;
  const voiceExpectation = manifest.conversationVoiceExpectation;
  if (expectation === undefined || voiceExpectation === undefined) {
    fail(
      "SUPPLEMENTAL_EXPECTATION_MISSING",
      "v8 manifest must pin supplemental playback and conversation voice identities",
    );
    return;
  }
  const supplemental = evidence.conversation.supplementalPlayback;
  if (
    supplemental.runId !== evidence.actorRun.runId ||
    supplemental.actor.applicationId !== expectation.applicationId ||
    supplemental.actor.authenticatedApplicationId !== expectation.applicationId ||
    supplemental.fixture.sha256 !== expectation.fixtureSha256 ||
    supplemental.fixture.durationMs !== expectation.durationMs ||
    supplemental.target.guildId !== voiceExpectation.guildId ||
    supplemental.target.voiceChannelId !== voiceExpectation.voiceChannelId
  ) {
    fail(
      "SUPPLEMENTAL_IDENTITY_MISMATCH",
      "supplemental playback does not match its pinned run, fixture, actor, or voice target",
    );
  }
  const playbackStartMs = supplemental.playback.startedAtEpochMs - recordingStartMs;
  const playbackEndMs = supplemental.playback.endedAtEpochMs - recordingStartMs;
  const playbackDurationMs = playbackEndMs - playbackStartMs;
  if (
    supplemental.playback.startedAtEpochMs < recordingStartMs ||
    supplemental.playback.endedAtEpochMs > recordingEndMs ||
    Math.abs(playbackDurationMs - expectation.durationMs) >
      manifest.thresholds.timestampToleranceMs
  ) {
    fail(
      "SUPPLEMENTAL_PLAYBACK_INTERVAL_INVALID",
      "supplemental playback is outside the recording or its pinned duration tolerance",
    );
  }
  if (!evidence.recording.speakerIds.includes(expectation.applicationId)) {
    fail(
      "SUPPLEMENTAL_SPEAKER_MISSING",
      "supplemental Speaker D is absent from the authoritative recording",
    );
  }

  const speakerTurns = evidence.transcript.turns.filter((turn) =>
    turn.speakerId === expectation.applicationId &&
    turn.startMs < playbackEndMs && playbackStartMs < turn.endMs
  );
  const normalizedSpeakerText = normalizeTranscriptSemantics(
    speakerTurns.map(({ text }) => text).join(" "),
  );
  verifyRequiredTerms(
    normalizedSpeakerText,
    expectation.requiredQuestionTerms,
    "SUPPLEMENTAL_QUESTION_MISSING",
    fail,
  );
  verifyRequiredTerms(
    normalizedSpeakerText,
    expectation.requiredFarewellTerms,
    "SUPPLEMENTAL_FAREWELL_MISSING",
    fail,
  );

  const questionTurns = turnsContainingAnyTerms(
    speakerTurns,
    expectation.requiredQuestionTerms,
  );
  const farewellTurns = turnsContainingAnyTerms(
    speakerTurns,
    expectation.requiredFarewellTerms,
  );
  const questionEndMs = Math.max(...questionTurns.map(({ endMs }) => endMs), -1);
  const farewellStartMs = Math.min(...farewellTurns.map(({ startMs }) => startMs), Infinity);
  const farewellEndMs = Math.max(...farewellTurns.map(({ endMs }) => endMs), -1);
  if (questionEndMs < 0 || !Number.isFinite(farewellStartMs) || questionEndMs >= farewellStartMs) {
    fail(
      "SUPPLEMENTAL_TURN_ORDER_INVALID",
      "pinned Speaker D question must precede its group farewell",
    );
  }

  verifyFarewellTiming(
    manifest,
    evidence,
    {
      humanFarewellEndMs: farewellEndMs,
      locale: expectation.farewellLocale,
      recordingStartMs,
    },
    fail,
  );
  verifyAddressedAnswerSemantics(
    evidence,
    {
      answerNonce: expectation.answerNonce,
      farewellStartMs,
      playbackEndMs,
      playbackStartMs,
      questionEndMs,
      recordingStartMs,
    },
    fail,
  );
}

function verifyFarewellTiming(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV8,
  expectation: SupplementalFarewellExpectation,
  fail: VerificationFailureReporter,
): void {
  const farewellEvent = evidence.conversation.lifecycle.events.find(
    (event) => event.type === "farewell",
  );
  const farewellCaptures = evidence.conversation.voice.filter(
    ({ correlation }) => correlation.purpose === "farewell",
  );
  if (
    farewellEvent === undefined ||
    farewellCaptures.length !== 1 ||
    expectation.humanFarewellEndMs < 0
  ) {
    fail(
      "SUPPLEMENTAL_FAREWELL_EVIDENCE_MISMATCH",
      "supplemental farewell lacks one settled event and one audible response capture",
    );
    return;
  }
  if (farewellEvent.locale !== expectation.locale) {
    fail(
      "SUPPLEMENTAL_FAREWELL_LOCALE_MISMATCH",
      "settled Botik farewell locale does not match the pinned Speaker D farewell",
    );
  }
  const toleranceMs = manifest.thresholds.timestampToleranceMs;
  const turnBoundaryToleranceMs = Math.min(toleranceMs, maximumTurnBoundaryToleranceMs);
  const observedAtMs = Date.parse(farewellEvent.observedAt) - expectation.recordingStartMs;
  const captureStartMs =
    farewellCaptures[0]!.capture.firstPacketAt.epochMilliseconds - expectation.recordingStartMs;
  const captureEndMs =
    farewellCaptures[0]!.capture.endedAt.epochMilliseconds - expectation.recordingStartMs;
  if (
    captureStartMs < expectation.humanFarewellEndMs - turnBoundaryToleranceMs ||
    observedAtMs < captureStartMs ||
    observedAtMs > captureEndMs + toleranceMs
  ) {
    fail(
      "SUPPLEMENTAL_FAREWELL_EVIDENCE_MISMATCH",
      "settled Botik farewell must follow Speaker D and remain inside its audible capture",
    );
  }
}

function verifyAddressedAnswerSemantics(
  evidence: RetainedE2eEvidenceV8,
  window: SupplementalAnswerWindow,
  fail: VerificationFailureReporter,
): void {
  const answerCaptures = evidence.conversation.voice.filter(
    ({ correlation }) => correlation.purpose === "addressed-answer",
  );
  if (answerCaptures.length !== 1) {
    return;
  }
  const answer = answerCaptures[0]!;
  const answerStartMs =
    answer.capture.firstPacketAt.epochMilliseconds - window.recordingStartMs;
  const answerEndMs = answer.capture.endedAt.epochMilliseconds - window.recordingStartMs;
  if (
    answerStartMs < window.playbackStartMs || answerEndMs > window.playbackEndMs ||
    answerStartMs < window.questionEndMs || answerEndMs > window.farewellStartMs
  ) {
    fail(
      "SUPPLEMENTAL_ANSWER_INTERVAL_INVALID",
      "Botik answer must follow the pinned question and precede the group farewell",
    );
  }
  const answerText = normalizeTranscriptSemantics(
    evidence.transcript.turns.filter((turn) =>
      turn.speakerId === evidence.conversation.botSpeakerId &&
      turn.startMs < answerEndMs && answerStartMs < turn.endMs
    ).map(({ text }) => text).join(" "),
  );
  verifyRequiredTerms(
    answerText,
    [window.answerNonce],
    "SUPPLEMENTAL_ANSWER_SEMANTICS_MISSING",
    fail,
  );
}

function turnsContainingAnyTerms<T extends { readonly text: string }>(
  turns: readonly T[],
  terms: readonly string[],
): readonly T[] {
  const normalizedTerms = terms.map((term) => normalizeTranscriptSemantics(term));
  return turns.filter(({ text }) => {
    const normalized = normalizeTranscriptSemantics(text);
    return normalizedTerms.some((term) => normalized.includes(term));
  });
}

function verifyRequiredTerms(
  normalizedText: string,
  requiredTerms: readonly string[],
  failureCode: string,
  fail: VerificationFailureReporter,
): void {
  const missing = requiredTerms.filter((term) =>
    !normalizedText.includes(normalizeTranscriptSemantics(term))
  );
  if (missing.length > 0) {
    fail(failureCode, `retained transcript is missing terms: ${missing.join(", ")}`);
  }
}
