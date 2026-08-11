import { verifyAddressedAnswer } from "./e2e-evidence-addressed-answer-verification.js";
import { verifyGreetingAudioSemantics } from "./e2e-evidence-greeting-semantics-verification.js";
import { verifySupplementalPlayback } from "./e2e-evidence-supplemental-verification.js";
import { characterErrorRate, normalizeTranscriptSemantics, wordErrorRate } from "./e2e-evidence-text-metrics.js";
import type { FixtureManifestV1, RetainedE2eEvidence } from "./e2e-evidence-schema.js";
import type {
  TranscriptVerificationContext, VerificationFailureReporter,
} from "./e2e-evidence-verification-types.js";

export function verifyConversationEvidence(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  if (evidence.schemaVersion !== 7 && evidence.schemaVersion !== 8) {
    return;
  }
  const recordingStartMs = Date.parse(evidence.recording.startedAt);
  const recordingEndMs = Date.parse(evidence.recording.endedAt);
  if (!manifest.allowedBotSpeakerIds.includes(evidence.conversation.botSpeakerId)) {
    fail("BOT_SPEAKER_NOT_PINNED", "Botik speaker is not pinned by the fixture manifest");
  }
  if (evidence.actorRun.scenario !== "reconnect") {
    fail(
      "LIFECYCLE_RECONNECT_NOT_PROVEN",
      "v7/v8 lifecycle evidence must come from a reconnect run",
    );
  }
  verifyGreetingAndFarewellLifecycle(
    manifest,
    evidence,
    recordingStartMs,
    recordingEndMs,
    fail,
  );
  verifyVoiceCaptureIdentity(manifest, evidence, recordingStartMs, recordingEndMs, fail);
  verifyLifecycleAudioBindings(manifest, evidence, fail);
  if (evidence.schemaVersion === 8) {
    verifyGreetingAudioSemantics(manifest, evidence, recordingStartMs, fail);
    verifySupplementalPlayback(manifest, evidence, recordingStartMs, recordingEndMs, fail);
  }
  verifyAddressedAnswer(evidence, recordingStartMs, fail);
}

type RetainedConversationEvidence = Extract<
  RetainedE2eEvidence,
  { schemaVersion: 7 | 8 }
>;
const maximumVerifiedGreetingRetry = 3;

function verifyGreetingAndFarewellLifecycle(
  manifest: FixtureManifestV1,
  evidence: RetainedConversationEvidence,
  recordingStartMs: number,
  recordingEndMs: number,
  fail: VerificationFailureReporter,
): void {
  const { lifecycle } = evidence.conversation;
  const greetings = lifecycle.events.filter((event) => event.type === "greeting");
  const farewells = lifecycle.events.filter((event) => event.type === "farewell");
  if (new Set(greetings.map(({ participantId }) => participantId)).size !== greetings.length) {
    fail("DUPLICATE_GREETING", "a participant has more than one completed greeting playback");
  }
  if (!greetings.some(({ greetingLocale }) => greetingLocale === "ru") ||
    !greetings.some(({ greetingLocale }) => greetingLocale === "en")) {
    fail("GREETING_LOCALE_MISSING", "completed greeting proof must include Russian and English");
  }
  if (evidence.schemaVersion === 8 &&
    (!greetings.some(({ greetingLocale, participantNameStatus }) =>
      greetingLocale === "ru" && participantNameStatus === "known") ||
      !greetings.some(({ greetingLocale, participantNameStatus }) =>
        greetingLocale === "en" && participantNameStatus === "known"))) {
    fail(
      "NAMED_GREETING_LOCALE_MISSING",
      "completed greeting proof must include named Russian and English participants",
    );
  }
  if (!greetings.some(({ participantNameStatus }) => participantNameStatus === "unknown")) {
    fail("UNKNOWN_GREETING_MISSING", "completed greeting proof has no unknown participant");
  }
  for (const greeting of greetings) {
    if (!isVerifiedGreetingTurnId(greeting.turnId, greeting.participantId)) {
      fail("GREETING_TURN_MISMATCH", `greeting turn is not bound to ${greeting.participantId}`);
    }
  }
  verifyReconnectGreeting(manifest, evidence, greetings, recordingStartMs, fail);
  if (farewells.length !== 1) {
    fail("FAREWELL_COUNT_MISMATCH", "expected exactly one completed prepared farewell");
  }
  for (const event of lifecycle.events) {
    const observedAt = Date.parse(event.observedAt);
    if (observedAt < recordingStartMs || observedAt > recordingEndMs) {
      fail("STALE_LIFECYCLE_EVENT", "conversation lifecycle event is outside the recording interval");
    }
  }
}

function isVerifiedGreetingTurnId(turnId: string, participantId: string): boolean {
  const initialTurnId = `participant-greeting:${participantId}`;
  if (turnId === initialTurnId) {
    return true;
  }
  for (let retry = 1; retry <= maximumVerifiedGreetingRetry; retry += 1) {
    if (turnId === `${initialTurnId}:retry-${retry}`) {
      return true;
    }
  }
  return false;
}

function verifyReconnectGreeting(
  manifest: FixtureManifestV1,
  evidence: RetainedConversationEvidence,
  greetings: readonly Extract<
    RetainedConversationEvidence["conversation"]["lifecycle"]["events"][number],
    { type: "greeting" }
  >[],
  recordingStartMs: number,
  fail: VerificationFailureReporter,
): void {
  const reconnectFixture = manifest.fixtures.find(({ actorName }) => actorName === "speaker-b");
  const disconnected = evidence.actorRun.events.find(
    (event) => event.actorName === "speaker-b" && event.type === "disconnected",
  );
  if (reconnectFixture === undefined || disconnected === undefined) {
    fail("RECONNECT_GREETING_MISSING", "reconnect actor metadata is missing");
    return;
  }
  const reconnectGreetings = greetings.filter(
    ({ participantId }) => participantId === reconnectFixture.speakerId,
  );
  if (reconnectGreetings.length !== 1) {
    fail("RECONNECT_GREETING_MISSING", "reconnect actor must have exactly one greeting");
    return;
  }
  const observedAtRecordingMs = Date.parse(reconnectGreetings[0]!.observedAt) - recordingStartMs;
  if (observedAtRecordingMs > disconnected.atRecordingMs) {
    fail(
      "RECONNECT_GREETING_ORDER_INVALID",
      "reconnect actor greeting must complete before its disconnect",
    );
  }
}

function verifyVoiceCaptureIdentity(
  manifest: FixtureManifestV1,
  evidence: RetainedConversationEvidence,
  recordingStartMs: number,
  recordingEndMs: number,
  fail: VerificationFailureReporter,
): void {
  const { voice, botSpeakerId } = evidence.conversation;
  const attemptIds = voice.map(({ correlation }) => correlation.attemptId);
  if (new Set(attemptIds).size !== attemptIds.length) {
    fail("DUPLICATE_VOICE_ATTEMPT", "conversation voice attempt IDs must be unique");
  }
  const observerApplications = new Set(voice.map(({ observer }) => observer.applicationId));
  const observerGuilds = new Set(voice.map(({ observer }) => observer.guildId));
  const observerVoiceChannels = new Set(voice.map(({ observer }) => observer.voiceChannelId));
  const craigBots = new Set(voice.map(({ source }) => source.craigBotId));
  if (
    observerApplications.size !== 1 || observerGuilds.size !== 1 ||
    observerVoiceChannels.size !== 1 || craigBots.size !== 1
  ) {
    fail("VOICE_IDENTITY_MISMATCH", "voice captures use different Discord identities or channels");
  }
  verifyVoiceCaptureExpectation(
    manifest,
    observerApplications,
    observerGuilds,
    observerVoiceChannels,
    fail,
  );
  for (const observation of voice) {
    if (observation.runId !== evidence.actorRun.runId ||
      observation.correlation.recordingId !== evidence.recording.recordingId) {
      fail("VOICE_CORRELATION_MISMATCH", "voice capture is bound to a different run or recording");
    }
    if (observation.observer.authenticatedBotId !== observation.observer.applicationId ||
      observation.source.craigBotId === observation.observer.applicationId ||
      observation.observer.applicationId === botSpeakerId ||
      observation.source.craigBotId !== botSpeakerId) {
      fail("VOICE_IDENTITY_MISMATCH", "voice capture has the wrong authenticated application identity");
    }
    const startedAt = observation.capture.startedAt.epochMilliseconds;
    const firstPacketAt = observation.capture.firstPacketAt.epochMilliseconds;
    const endedAt = observation.capture.endedAt.epochMilliseconds;
    if (
      startedAt > firstPacketAt || firstPacketAt < recordingStartMs ||
      endedAt > recordingEndMs || endedAt < firstPacketAt
    ) {
      fail("STALE_VOICE_CAPTURE", "voice capture is outside the authoritative recording interval");
    }
  }
}

function verifyVoiceCaptureExpectation(
  manifest: FixtureManifestV1,
  observerApplications: ReadonlySet<string>,
  observerGuilds: ReadonlySet<string>,
  observerVoiceChannels: ReadonlySet<string>,
  fail: VerificationFailureReporter,
): void {
  const expectation = manifest.conversationVoiceExpectation;
  if (expectation === undefined) {
    fail("VOICE_EXPECTATION_MISSING", "fixture manifest does not pin the observer, guild, and voice channel");
    return;
  }
  if (
    !observerApplications.has(expectation.observerApplicationId) ||
    !observerGuilds.has(expectation.guildId) ||
    !observerVoiceChannels.has(expectation.voiceChannelId)
  ) {
    fail("VOICE_IDENTITY_MISMATCH", "voice capture does not match the fixture manifest environment");
  }
}

function verifyLifecycleAudioBindings(
  manifest: FixtureManifestV1,
  evidence: RetainedConversationEvidence,
  fail: VerificationFailureReporter,
): void {
  const { lifecycle, voice } = evidence.conversation;
  for (const event of lifecycle.events) {
    const matches = voice.filter(({ correlation }) =>
      correlation.purpose === event.type && isLifecycleTurnBinding(event, correlation.turnId)
    );
    if (matches.length !== 1) {
      fail("LIFECYCLE_AUDIO_MISMATCH", `expected one audible capture for ${event.turnId}`);
      continue;
    }
    const capture = matches[0]!;
    const observedAt = Date.parse(event.observedAt);
    if (
      observedAt < capture.capture.firstPacketAt.epochMilliseconds ||
      observedAt > capture.capture.endedAt.epochMilliseconds +
        manifest.thresholds.timestampToleranceMs
    ) {
      fail("LIFECYCLE_AUDIO_MISMATCH", `audible capture is not time-bound to ${event.turnId}`);
    }
  }
  if (evidence.schemaVersion === 8) {
    for (const observation of voice) {
      if (observation.correlation.purpose === "addressed-answer") {
        continue;
      }
      const matches = lifecycle.events.filter((event) =>
        event.type === observation.correlation.purpose &&
        isLifecycleTurnBinding(event, observation.correlation.turnId)
      );
      if (matches.length !== 1) {
        fail(
          "ORPHAN_LIFECYCLE_AUDIO",
          `audible capture has no unique settled lifecycle event for ${observation.correlation.turnId}`,
        );
      }
    }
  }
}

function isLifecycleTurnBinding(
  event: RetainedConversationEvidence["conversation"]["lifecycle"]["events"][number],
  capturedTurnId: string,
): boolean {
  if (capturedTurnId === event.turnId) {
    return true;
  }
  return event.type === "greeting" &&
    isVerifiedGreetingTurnId(event.turnId, event.participantId) &&
    capturedTurnId === `participant-greeting:${event.participantId}`;
}

export function verifyTranscript(context: TranscriptVerificationContext): void {
  verifyTranscriptSpeakers(context);
  verifyTranscriptTurns(context);
  verifyFixtureTranscripts(context);
  verifyTranscriptOverlap(context);
}

function verifyTranscriptSpeakers(context: TranscriptVerificationContext): void {
  const { evidence, fail, manifest } = context;
  const expectedSpeakers = new Set(manifest.fixtures.map(({ speakerId }) => speakerId));
  const allowedSpeakers = new Set([
    ...expectedSpeakers,
    ...manifest.allowedBotSpeakerIds,
  ]);
  const recordedSpeakers = new Set(evidence.recording.speakerIds);
  const transcriptSpeakers = new Set(evidence.transcript.turns.map(({ speakerId }) => speakerId));
  for (const speakerId of expectedSpeakers) {
    if (!recordedSpeakers.has(speakerId) || !transcriptSpeakers.has(speakerId)) {
      fail("SPEAKER_MISSING", `speaker ${speakerId} is absent from recording or transcript evidence`);
    }
  }
  for (const speakerId of new Set([...recordedSpeakers, ...transcriptSpeakers])) {
    if (!allowedSpeakers.has(speakerId)) {
      fail("UNEXPECTED_SPEAKER", `unexpected speaker ${speakerId} appears in retained evidence`);
    }
  }
}

function verifyTranscriptTurns(context: TranscriptVerificationContext): void {
  const { evidence, fail } = context;
  for (const turn of evidence.transcript.turns) {
    if (turn.endMs <= turn.startMs) {
      fail("INVALID_TURN_TIME", `turn ${turn.turnId} must end after it starts`);
    }
  }
  const turnIds = evidence.transcript.turns.map(({ turnId }) => turnId);
  if (new Set(turnIds).size !== turnIds.length) {
    fail("DUPLICATE_TURN", "transcript turn IDs must be unique");
  }
}

function verifyFixtureTranscripts(context: TranscriptVerificationContext): void {
  const { evidence, fail, manifest, metrics, scenario } = context;
  for (const fixture of manifest.fixtures) {
    const turns = evidence.transcript.turns
      .filter(({ speakerId }) => speakerId === fixture.speakerId)
      .toSorted((left, right) => left.startMs - right.startMs);
    const expectedCount = scenario.playbackCountByFixture[fixture.fixtureId] ?? 0;
    const expectedText = Array.from({ length: expectedCount }, () => fixture.sourceText).join(" ");
    const actualText = turns.map(({ text }) => text).join(" ");
    const wordRate = wordErrorRate(expectedText, actualText);
    const characterRate = characterErrorRate(expectedText, actualText);
    metrics.push({
      characterErrorRate: characterRate,
      speakerId: fixture.speakerId,
      wordErrorRate: wordRate,
    });
    verifyErrorRates(fixture.fixtureId, wordRate, characterRate, manifest, fail);
    verifyRequiredTerms(fixture.fixtureId, fixture.requiredTerms, actualText, fail);
    verifyTranscriptTiming(context, fixture.fixtureId, turns);
  }
}

function verifyErrorRates(
  fixtureId: string,
  wordRate: number,
  characterRate: number,
  context: TranscriptVerificationContext["manifest"],
  fail: TranscriptVerificationContext["fail"],
): void {
  if (wordRate > context.thresholds.maxWordErrorRate) {
    fail("WER_EXCEEDED", `${fixtureId} WER ${wordRate.toFixed(3)} exceeds threshold`);
  }
  if (characterRate > context.thresholds.maxCharacterErrorRate) {
    fail("CER_EXCEEDED", `${fixtureId} CER ${characterRate.toFixed(3)} exceeds threshold`);
  }
}

function verifyRequiredTerms(
  fixtureId: string,
  terms: readonly string[],
  actualText: string,
  fail: TranscriptVerificationContext["fail"],
): void {
  const normalizedActual = normalizeTranscriptSemantics(actualText);
  for (const term of terms) {
    if (!normalizedActual.includes(normalizeTranscriptSemantics(term))) {
      fail("TERM_MISSING", `${fixtureId} transcript is missing required term ${term}`);
    }
  }
}

function verifyTranscriptTiming(
  context: TranscriptVerificationContext,
  fixtureId: string,
  turns: readonly TranscriptVerificationContext["evidence"]["transcript"]["turns"][number][],
): void {
  const fixture = context.manifest.fixtures.find((candidate) => candidate.fixtureId === fixtureId);
  if (fixture === undefined) {
    return;
  }
  const fixtureWindows = context.playbackWindows
    .filter((window) => window.fixtureId === fixtureId)
    .toSorted((left, right) => left.startMs - right.startMs);
  const firstWindow = fixtureWindows[0];
  const lastWindow = fixtureWindows.at(-1);
  const firstTurn = turns[0];
  const lastTurn = turns.at(-1);
  if (
    firstTurn !== undefined &&
    firstWindow !== undefined &&
    Math.abs(firstTurn.startMs - (firstWindow.startMs + fixture.speechStartOffsetMs)) >
      context.manifest.thresholds.timestampToleranceMs
  ) {
    context.fail("START_TIMESTAMP_MISMATCH", `${fixtureId} transcript start is outside tolerance`);
  }
  if (
    lastTurn !== undefined &&
    lastWindow !== undefined &&
    Math.abs(lastTurn.endMs - lastWindow.endMs) > context.manifest.thresholds.timestampToleranceMs
  ) {
    context.fail("END_TIMESTAMP_MISMATCH", `${fixtureId} transcript end is outside tolerance`);
  }
}

function verifyTranscriptOverlap(context: TranscriptVerificationContext): void {
  const { evidence, fail, scenario } = context;
  const fixtureSpeakerIds = new Set(context.manifest.fixtures.map(({ speakerId }) => speakerId));
  const fixtureTurns = evidence.transcript.turns.filter(({ speakerId }) =>
    fixtureSpeakerIds.has(speakerId)
  );
  const hasOverlap = fixtureTurns.some((left, leftIndex) =>
    fixtureTurns.some((right, rightIndex) =>
      leftIndex < rightIndex &&
      left.speakerId !== right.speakerId &&
      left.startMs < right.endMs &&
      right.startMs < left.endMs,
    ),
  );
  if (hasOverlap !== scenario.expectOverlap) {
    fail("OVERLAP_MISMATCH", `scenario expected overlap=${String(scenario.expectOverlap)}`);
  }
}
