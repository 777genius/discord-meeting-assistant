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
  if (reconnectFixture.length !== 1) {
    fail(
      "RECONNECT_RECEIPT_IDENTITY_MISMATCH",
      "reconnect negative proof is not bound to the pinned speaker-b participant",
    );
    return;
  }
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
  const localeTerms = manifest.greetingLocaleTerms;
  if (localeTerms === undefined) {
    return;
  }
  const greetingTerms = [...localeTerms.en, ...localeTerms.ru]
    .map(normalizeTranscriptSemantics);
  const greetingCaptures = evidence.conversation.voice.filter(
    ({ correlation }) => correlation.purpose === "greeting",
  ).map(({ capture }) => ({
    endMs: capture.endedAt.epochMilliseconds - recordingStartMs,
    startMs: capture.firstPacketAt.epochMilliseconds - recordingStartMs,
  }));
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
      !greetingCaptures.some(({ endMs, startMs }) =>
        turn.startMs < endMs && startMs < turn.endMs
      );
  });
  if (repeatedGreeting) {
    fail(
      "RECONNECT_AUDIBLE_GREETING_REPEATED",
      "Botik produced greeting-shaped transcript evidence after the SUT rejoined",
    );
  }
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
