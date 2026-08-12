import { verifyAddressedAnswer } from "./e2e-evidence-addressed-answer-verification.js";
import { verifyGreetingAudioSemantics } from "./e2e-evidence-greeting-semantics-verification.js";
import { verifySupplementalPlayback } from "./e2e-evidence-supplemental-verification.js";
import { authoritativeTrackCoverage } from "./e2e-evidence-track-verification.js";
import {
  conversationVoiceCampaignEvidenceIssue,
  conversationVoiceCampaignLifecycleIssue,
} from
  "./conversation-voice-campaign-contract.js";
import type {
  DeploymentRevisionExpectation,
  FixtureManifestV1,
  RetainedE2eEvidence,
} from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

export function verifyConversationEvidence(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  expectedRevisions: DeploymentRevisionExpectation,
  fail: VerificationFailureReporter,
): void {
  if (evidence.schemaVersion !== 7 && evidence.schemaVersion !== 8) {
    return;
  }
  const recordingStartMs = Date.parse(evidence.recording.startedAt);
  const recordingEndMs = Date.parse(evidence.recording.endedAt);
  const voiceExpectation = manifest.conversationVoiceExpectation;
  if (
    evidence.schemaVersion === 8
      ? voiceExpectation === undefined ||
        evidence.conversation.botSpeakerId !== voiceExpectation.botSpeakerId
      : !manifest.allowedBotSpeakerIds.includes(evidence.conversation.botSpeakerId)
  ) {
    fail("BOT_SPEAKER_NOT_PINNED", "Botik speaker does not match the exact manifest identity");
  }
  if (
    evidence.schemaVersion === 8 &&
    (expectedRevisions.pipecat === undefined || evidence.deployment.pipecat === undefined)
  ) {
    fail(
      "PIPECAT_PROVENANCE_MISSING",
      "v8 conversation proof requires exact Pipecat revision and deployment provenance",
    );
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
    verifyBotTrackCoverage(manifest, evidence, recordingStartMs, fail);
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
    if (!isVerifiedGreetingTurnId(
      greeting.turnId,
      greeting.participantId,
      evidence.schemaVersion === 8,
    )) {
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

function isVerifiedGreetingTurnId(
  turnId: string,
  participantId: string,
  allowRetries: boolean,
): boolean {
  const initialTurnId = `participant-greeting:${participantId}`;
  if (turnId === initialTurnId) {
    return true;
  }
  if (!allowRetries) {
    return false;
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
  if (evidence.schemaVersion === 8) {
    const campaignIssue = conversationVoiceCampaignEvidenceIssue(voice);
    if (campaignIssue !== undefined) {
      fail("VOICE_CAMPAIGN_ORDER_INVALID", campaignIssue);
    }
    const lifecycleIssue = conversationVoiceCampaignLifecycleIssue(
      voice,
      evidence.conversation.lifecycle.events,
      manifest.thresholds.timestampToleranceMs,
    );
    if (lifecycleIssue !== undefined) {
      fail("VOICE_CAMPAIGN_LIFECYCLE_INVALID", lifecycleIssue);
    }
  }
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

function verifyBotTrackCoverage(
  manifest: FixtureManifestV1,
  evidence: RetainedConversationEvidence,
  recordingStartMs: number,
  fail: VerificationFailureReporter,
): void {
  const intervals = [
    ...evidence.conversation.voice.map(({ capture }) => ({
      endMs: capture.endedAt.epochMilliseconds - recordingStartMs,
      startMs: capture.firstPacketAt.epochMilliseconds - recordingStartMs,
    })),
    ...evidence.transcript.turns.filter(
      ({ speakerId }) => speakerId === evidence.conversation.botSpeakerId,
    ),
  ];
  const issue = authoritativeTrackCoverage(
    evidence,
    evidence.conversation.botSpeakerId,
    intervals,
    manifest.thresholds.timestampToleranceMs,
  );
  if (issue === "track-missing") {
    fail("BOT_RECORDING_TRACK_MISSING", "Botik must have exactly one authoritative S3 track");
    return;
  }
  if (issue === "interval-outside-track") {
    fail(
      "BOT_TRACK_INTERVAL_MISMATCH",
      "Botik captures and transcript turns must fit its authoritative S3 track",
    );
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
      correlation.purpose === event.type && isLifecycleTurnBinding(
        event,
        correlation.turnId,
        evidence.schemaVersion,
      )
    );
    if (matches.length !== 1) {
      fail("LIFECYCLE_AUDIO_MISMATCH", `expected one audible capture for ${event.turnId}`);
      continue;
    }
    const capture = matches[0]!;
    const observedAt = Date.parse(event.observedAt);
    const timingMismatch = event.type === "addressed-answer"
      ? observedAt > capture.capture.firstPacketAt.epochMilliseconds
      : observedAt < capture.capture.firstPacketAt.epochMilliseconds ||
        observedAt > capture.capture.endedAt.epochMilliseconds +
          manifest.thresholds.timestampToleranceMs;
    if (timingMismatch) {
      fail("LIFECYCLE_AUDIO_MISMATCH", `audible capture is not time-bound to ${event.turnId}`);
    }
  }
  if (evidence.schemaVersion === 8) {
    for (const observation of voice) {
      const matches = lifecycle.events.filter((event) =>
        event.type === observation.correlation.purpose &&
        isLifecycleTurnBinding(event, observation.correlation.turnId, evidence.schemaVersion)
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
  schemaVersion: 7 | 8,
): boolean {
  if (capturedTurnId === event.turnId) {
    return true;
  }
  return schemaVersion === 8 && event.type === "greeting" &&
    isVerifiedGreetingTurnId(event.turnId, event.participantId, true) &&
    capturedTurnId === `participant-greeting:${event.participantId}`;
}
