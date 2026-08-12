import { normalizeTranscriptSemantics } from "./e2e-evidence-text-metrics.js";
import { authoritativeTrackCoverage } from "./e2e-evidence-track-verification.js";
import type {
  FixtureManifestV1,
  RetainedE2eEvidenceV8,
} from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

export function verifyReconnectNoRepeat(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV8,
  recordingStartMs: number,
  recordingEndMs: number,
  fail: VerificationFailureReporter,
): void {
  const reconnectFixture = manifest.fixtures.filter(
    ({ actorName }) => actorName === "speaker-b",
  );
  const expectedParticipantId = reconnectFixture[0]?.speakerId;
  const retained = evidence.conversation.reconnectNoRepeat;
  if (evidence.actorRun.scenario !== "reconnect") {
    return;
  }
  if (retained === undefined) {
    fail(
      "RECONNECT_NEGATIVE_PROOF_MISSING",
      "new reconnect acceptance requires retained SUT lifecycle and negative-window proof",
    );
    return;
  }
  if (reconnectFixture.length !== 1) {
    fail(
      "RECONNECT_RECEIPT_IDENTITY_MISMATCH",
      "reconnect negative proof is not bound to the pinned speaker-b participant",
    );
    return;
  }
  const joinedAtMs = validateReconnectReceiptWindow({
    evidence, fail, manifest,
    expectedParticipantId,
    recordingStartMs,
    recordingEndMs,
    retained,
  });
  if (joinedAtMs === undefined) {
    return;
  }
  const reconnectGreeting = reconnectFixture[0];
  const localeTerms = reconnectGreeting?.greetingLocale === undefined
    ? undefined
    : manifest.greetingLocaleTerms?.[reconnectGreeting.greetingLocale];
  const spokenToken = reconnectGreeting?.greetingSpokenToken;
  if (localeTerms === undefined || spokenToken === undefined) {
    fail(
      "RECONNECT_GREETING_EXPECTATION_MISSING",
      "reconnect negative proof requires a pinned named greeting expectation",
    );
    return;
  }
  const greetingTerms = localeTerms.map(normalizeTranscriptSemantics);
  const normalizedSpokenToken = normalizeTranscriptSemantics(spokenToken);
  const windowStartMs = joinedAtMs - recordingStartMs;
  const trackCoverage = authoritativeTrackCoverage(
    evidence,
    evidence.conversation.botSpeakerId,
    [{ endMs: recordingEndMs - recordingStartMs, startMs: windowStartMs }],
    0,
  );
  reportNegativeWindowTrackGap(trackCoverage, fail);
  const repeatedGreeting = evidence.transcript.turns.some((turn) => {
    if (
      turn.speakerId !== evidence.conversation.botSpeakerId ||
      turn.endMs <= windowStartMs ||
      turn.startMs >= recordingEndMs - recordingStartMs
    ) {
      return false;
    }
    const paddedText = ` ${normalizeTranscriptSemantics(turn.text)} `;
    return greetingTerms.some((term) => paddedText.includes(` ${term} `)) &&
      paddedText.includes(` ${normalizedSpokenToken} `);
  });
  if (repeatedGreeting) {
    fail(
      "RECONNECT_AUDIBLE_GREETING_REPEATED",
      "Botik repeated the reconnect participant's pinned named greeting after rejoin",
    );
  }
}

function validateReconnectReceiptWindow(input: {
  readonly evidence: RetainedE2eEvidenceV8;
  readonly expectedParticipantId: string | undefined;
  readonly fail: VerificationFailureReporter;
  readonly manifest: FixtureManifestV1;
  readonly recordingEndMs: number;
  readonly recordingStartMs: number;
  readonly retained: NonNullable<
    RetainedE2eEvidenceV8["conversation"]["reconnectNoRepeat"]
  >;
}): number | undefined {
  const {
    evidence, expectedParticipantId, fail, manifest,
    recordingEndMs, recordingStartMs, retained,
  } = input;
  const receipts = retained.participantId === expectedParticipantId
    ? retained.lifecycleReceipts : [];
  const left = receipts.filter(({ eventType }) => eventType === "participant.left");
  if (left.length !== 1) {
    fail(
      "RECONNECT_LIFECYCLE_RECEIPT_MISSING",
      "reconnect proof requires one SUT participant left/rejoined receipt pair",
    );
    return;
  }
  const leftAtMs = Date.parse(left[0]!.occurredAt);
  const rejoined = receipts.filter(({ eventType, occurredAt }) =>
    eventType === "participant.joined" && Date.parse(occurredAt) > leftAtMs
  );
  if (rejoined.length !== 1) {
    fail(
      "RECONNECT_LIFECYCLE_RECEIPT_MISSING",
      "reconnect proof requires one SUT participant left/rejoined receipt pair",
    );
    return;
  }
  const joinedAtMs = Date.parse(rejoined[0]!.occurredAt);
  const leftObservedAtMs = Date.parse(left[0]!.observedAt);
  const joinedObservedAtMs = Date.parse(rejoined[0]!.observedAt);
  const actorEvents = evidence.actorRun.events.filter(
    ({ actorName }) => actorName === "speaker-b",
  );
  const disconnected = actorEvents.find(({ type }) => type === "disconnected");
  const reconnectedReady = actorEvents.filter(({ type }) => type === "ready").at(-1);
  const toleranceMs = manifest.thresholds.timestampToleranceMs;
  if (
    disconnected === undefined ||
    reconnectedReady === undefined ||
    leftAtMs >= joinedAtMs ||
    leftObservedAtMs >= joinedObservedAtMs ||
    Math.abs(leftAtMs - (recordingStartMs + disconnected.atRecordingMs)) > toleranceMs ||
    Math.abs(joinedAtMs - (recordingStartMs + reconnectedReady.atRecordingMs)) > toleranceMs ||
    Math.abs(leftObservedAtMs - leftAtMs) > toleranceMs ||
    Math.abs(joinedObservedAtMs - joinedAtMs) > toleranceMs
  ) {
    fail(
      "RECONNECT_LIFECYCLE_RECEIPT_MISMATCH",
      "SUT participant left/rejoined receipts do not match the actor reconnect sequence",
    );
  }
  if (
    retained.negativeWindow.startedAt !== rejoined[0]!.occurredAt ||
    retained.negativeWindow.endedAt !== evidence.recording.endedAt ||
    joinedAtMs < recordingStartMs ||
    joinedAtMs >= recordingEndMs
  ) {
    fail(
      "RECONNECT_NEGATIVE_WINDOW_MISMATCH",
      "negative proof must continuously span the SUT rejoin receipt to recording end",
    );
    return;
  }
  return joinedAtMs;
}

function reportNegativeWindowTrackGap(
  issue: ReturnType<typeof authoritativeTrackCoverage>,
  fail: VerificationFailureReporter,
): void {
  if (issue !== undefined) {
    fail(
      "RECONNECT_NEGATIVE_WINDOW_TRACK_GAP",
      "authoritative Botik track does not continuously cover the reconnect negative window",
    );
  }
}
