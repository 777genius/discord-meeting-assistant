import { normalizeTranscriptSemantics } from "./e2e-evidence-text-metrics.js";
import {
  turnsContainingAnyTerms,
  verifyBotikFarewellTranscript,
} from "./e2e-evidence-farewell-semantics-verification.js";
import { authoritativeTrackCoverage } from "./e2e-evidence-track-verification.js";
import type {
  FixtureManifestV1,
  RetainedE2eEvidenceV8,
  RetainedE2eEvidenceV9,
  RetainedVoiceE2eEvidenceV10,
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
  readonly speakerId: string;
}

interface SupplementalFarewellExpectation {
  readonly expectedLocale: "en" | "ru";
  readonly humanFarewellEndMs: number;
  readonly humanFarewellTurnIds: readonly string[];
  readonly recordingStartMs: number;
}

interface SupplementalTrackExpectation {
  readonly playbackEndMs: number;
  readonly playbackStartMs: number;
  readonly speakerId: string;
  readonly speakerTurns: readonly { readonly endMs: number; readonly startMs: number }[];
}

export function verifySupplementalPlayback(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV8 | RetainedE2eEvidenceV9 | RetainedVoiceE2eEvidenceV10,
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
  verifySupplementalGreeting(evidence, expectation, fail);

  const allSpeakerTurns = evidence.transcript.turns.filter(
    (turn) => turn.speakerId === expectation.applicationId,
  );
  const speakerTurns = allSpeakerTurns.filter((turn) =>
    turn.startMs < playbackEndMs && playbackStartMs < turn.endMs
  );
  const turnBoundaryToleranceMs = Math.min(
    manifest.thresholds.timestampToleranceMs,
    maximumTurnBoundaryToleranceMs,
  );
  if (allSpeakerTurns.some((turn) =>
    turn.startMs < playbackStartMs - turnBoundaryToleranceMs ||
    turn.endMs > playbackEndMs + turnBoundaryToleranceMs
  )) {
    fail(
      "SUPPLEMENTAL_TURN_INTERVAL_INVALID",
      "every Speaker D transcript turn must come from the pinned playback interval",
    );
  }
  verifySupplementalTrackCoverage(manifest, evidence, {
    playbackEndMs,
    playbackStartMs,
    speakerId: expectation.applicationId,
    speakerTurns: allSpeakerTurns,
  }, fail);
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

  const questionTurns = turnsContainingAnyTerms(speakerTurns, [expectation.answerNonce]);
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
      humanFarewellTurnIds: farewellTurns.map(({ turnId }) => turnId),
      expectedLocale: expectation.farewellLocale,
      recordingStartMs,
    },
    fail,
  );
  verifyAddressedAnswerSemantics(
    manifest,
    evidence,
    {
      answerNonce: expectation.answerNonce,
      farewellStartMs,
      playbackEndMs,
      playbackStartMs,
      questionEndMs,
      recordingStartMs,
      speakerId: expectation.applicationId,
    },
    fail,
  );
}

function verifySupplementalGreeting(
  evidence: RetainedE2eEvidenceV8 | RetainedE2eEvidenceV9 | RetainedVoiceE2eEvidenceV10,
  expectation: NonNullable<FixtureManifestV1["supplementalVoiceExpectation"]>,
  fail: VerificationFailureReporter,
): void {
  const greetings = evidence.conversation.lifecycle.events.filter(
    (event): event is Extract<typeof event, { type: "greeting" }> =>
      event.type === "greeting" && event.participantId === expectation.applicationId,
  );
  const greeting = greetings[0];
  if (
    greetings.length !== 1 ||
    greeting === undefined ||
    greeting.greetingLocale !== expectation.greetingLocale ||
    greeting.participantNameStatus !== "unknown"
  ) {
    fail(
      "SUPPLEMENTAL_GREETING_MISMATCH",
      "supplemental Speaker D must have one audible default-locale greeting",
    );
  }
}

function verifyFarewellTiming(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV8 | RetainedE2eEvidenceV9 | RetainedVoiceE2eEvidenceV10,
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
  if (farewellEvent.locale !== expectation.expectedLocale) {
    fail(
      "SUPPLEMENTAL_FAREWELL_LOCALE_MISMATCH",
      "settled Botik farewell locale does not match the pinned Speaker D farewell",
    );
  }
  const requiredTerms = manifest.farewellLocaleTerms?.[farewellEvent.locale] ?? [];
  const exactPhrases = manifest.farewellExactPhrases?.[farewellEvent.locale] ?? [];
  const expectedPcmSha256 = manifest.farewellCapturePcmSha256?.[farewellEvent.locale];
  const duplicateTerms = manifest.farewellLocaleTerms === undefined
    ? []
    : [...manifest.farewellLocaleTerms.en, ...manifest.farewellLocaleTerms.ru];
  if (requiredTerms.length === 0) {
    fail(
      "SUPPLEMENTAL_FAREWELL_SEMANTICS_EXPECTATION_MISSING",
      `v8 manifest must pin recognizable ${farewellEvent.locale} Botik farewell terms`,
    );
  }
  if (expectedPcmSha256 === undefined) {
    fail(
      "SUPPLEMENTAL_FAREWELL_PCM_EXPECTATION_MISSING",
      `v8 manifest must pin the ${farewellEvent.locale} farewell capture PCM digest`,
    );
  } else if (farewellCaptures[0]!.capture.pcm.sha256 !== expectedPcmSha256) {
    fail(
      "SUPPLEMENTAL_FAREWELL_PCM_MISMATCH",
      "audible farewell PCM does not match the pinned prepared cue capture",
    );
  }
  const expectedTurnIds = new Set(expectation.humanFarewellTurnIds);
  if (
    farewellEvent.reason !== "explicit-group" ||
    farewellEvent.evidenceTurnIds.length === 0 ||
    farewellEvent.evidenceTurnIds.some((turnId) => !expectedTurnIds.has(turnId))
  ) {
    fail(
      "SUPPLEMENTAL_FAREWELL_CORRELATION_MISMATCH",
      "settled farewell must be the explicit group response bound to Speaker D turns",
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
  verifyBotikFarewellTranscript(
    evidence,
    {
      duplicateTerms,
      endMs: captureEndMs,
      exactPhrases,
      locale: farewellEvent.locale,
      requiredTerms,
      startMs: captureStartMs,
    },
    fail,
  );
}

function verifyAddressedAnswerSemantics(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV8 | RetainedE2eEvidenceV9 | RetainedVoiceE2eEvidenceV10,
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
  const answerEvents = evidence.conversation.lifecycle.events.filter(
    (event): event is Extract<typeof event, { type: "addressed-answer" }> =>
      event.type === "addressed-answer",
  );
  const answerEvent = answerEvents[0];
  if (
    answerEvents.length !== 1 ||
    answerEvent === undefined ||
    answerEvent.participantId !== window.speakerId ||
    answerEvent.turnId !== answer.correlation.turnId
  ) {
    fail(
      "SUPPLEMENTAL_ANSWER_TURN_MISMATCH",
      "addressed answer capture must reference Speaker D's admitted live turn",
    );
  }
  const answerStartMs =
    answer.capture.firstPacketAt.epochMilliseconds - window.recordingStartMs;
  const answerEndMs = answer.capture.endedAt.epochMilliseconds - window.recordingStartMs;
  const answerObservedAtMs = answerEvent === undefined
    ? -1
    : Date.parse(answerEvent.observedAt) - window.recordingStartMs;
  const turnBoundaryToleranceMs = Math.min(
    manifest.thresholds.timestampToleranceMs,
    maximumTurnBoundaryToleranceMs,
  );
  if (
    answerStartMs < window.playbackStartMs || answerEndMs > window.playbackEndMs ||
    answerStartMs < window.questionEndMs || answerEndMs > window.farewellStartMs ||
    answerObservedAtMs < window.questionEndMs - turnBoundaryToleranceMs ||
    answerObservedAtMs > answerStartMs
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

function verifySupplementalTrackCoverage(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV8 | RetainedE2eEvidenceV9 | RetainedVoiceE2eEvidenceV10,
  expectation: SupplementalTrackExpectation,
  fail: VerificationFailureReporter,
): void {
  const issue = authoritativeTrackCoverage(
    evidence,
    expectation.speakerId,
    [{ endMs: expectation.playbackEndMs, startMs: expectation.playbackStartMs },
      ...expectation.speakerTurns],
    manifest.thresholds.timestampToleranceMs,
  );
  if (issue === "track-missing") {
    fail(
      "SUPPLEMENTAL_SPEAKER_MISSING",
      "supplemental Speaker D must have exactly one authoritative S3 track",
    );
    return;
  }
  if (issue === "interval-outside-track") {
    fail(
      "SUPPLEMENTAL_TRACK_INTERVAL_MISMATCH",
      "Speaker D playback and transcript turns must fit its authoritative S3 track",
    );
  }
}

function verifyRequiredTerms(
  normalizedText: string,
  requiredTerms: readonly string[],
  failureCode: string,
  fail: VerificationFailureReporter,
): void {
  const missing = requiredTerms.filter((term) =>
    !containsWholeTerm(normalizedText, normalizeTranscriptSemantics(term))
  );
  if (missing.length > 0) {
    fail(failureCode, `retained transcript is missing terms: ${missing.join(", ")}`);
  }
}

function containsWholeTerm(normalizedText: string, normalizedTerm: string): boolean {
  return ` ${normalizedText} `.includes(` ${normalizedTerm} `);
}
