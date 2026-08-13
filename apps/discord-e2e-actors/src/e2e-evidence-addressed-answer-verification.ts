import type {
  RetainedE2eEvidence,
} from "./e2e-evidence-schema.js";
import type {
  VerificationFailureReporter,
} from "./e2e-evidence-verification-types.js";

type RetainedConversationEvidence = Extract<
  RetainedE2eEvidence,
  { schemaVersion: 7 | 8 | 9 }
>;

export function verifyAddressedAnswer(
  evidence: RetainedConversationEvidence,
  recordingStartMs: number,
  timestampToleranceMs: number,
  fail: VerificationFailureReporter,
): void {
  const { voice, botSpeakerId } = evidence.conversation;
  const answerCaptures = voice.filter(
    ({ correlation }) => correlation.purpose === "addressed-answer",
  );
  if (answerCaptures.length !== 1) {
    fail("ANSWER_AUDIO_COUNT_MISMATCH", "expected exactly one audible addressed answer capture");
  }
  if (!evidence.recording.speakerIds.includes(botSpeakerId)) {
    fail("BOT_RECORDING_TRACK_MISSING", "Botik speaker is absent from the authoritative recording");
  }
  for (const answer of answerCaptures) {
    if (evidence.schemaVersion >= 8) {
      verifyAddressedAnswerPlayback(
        evidence as Extract<RetainedConversationEvidence, { schemaVersion: 8 | 9 }>,
        answer,
        timestampToleranceMs,
        fail,
      );
    }
    const answerStartMs = answer.capture.firstPacketAt.epochMilliseconds - recordingStartMs;
    const answerEndMs = answer.capture.endedAt.epochMilliseconds - recordingStartMs;
    const transcriptMatches = evidence.transcript.turns.filter((turn) =>
      turn.speakerId === botSpeakerId && turn.startMs < answerEndMs && answerStartMs < turn.endMs
    );
    if (transcriptMatches.length !== 1) {
      fail(
        "ANSWER_TRANSCRIPT_MISMATCH",
        "audible addressed answer is not retained as one Botik transcript turn",
      );
    }
  }
}

function verifyAddressedAnswerPlayback(
  evidence: Extract<RetainedConversationEvidence, { schemaVersion: 8 | 9 }>,
  answer: RetainedConversationEvidence["conversation"]["voice"][number],
  timestampToleranceMs: number,
  fail: VerificationFailureReporter,
): void {
  const activeAdmissions = evidence.conversation.lifecycle.events.filter((event) =>
    event.type === "addressed-answer" &&
    event.turnId === answer.correlation.turnId &&
    event.outcome === "active"
  );
  const queuedAdmissions = evidence.conversation.lifecycle.events.filter((event) =>
    event.type === "addressed-answer" &&
    event.turnId === answer.correlation.turnId &&
    event.outcome === "queued"
  );
  if (activeAdmissions.length !== 1 || queuedAdmissions.length !== 0) {
    fail(
      "ANSWER_ADMISSION_MISMATCH",
      "addressed answer requires one active, non-queued admission",
    );
  }
  if (
    answer.correlation.provenance !== "playback-readiness-handshake" ||
    answer.correlation.meetingId !== evidence.meetingId
  ) {
    fail(
      "ANSWER_PLAYBACK_RECEIPT_MISMATCH",
      "addressed answer correlation must come from its exact playback readiness handshake",
    );
    return;
  }

  const receipts = evidence.conversation.lifecycle.playbackReceipts.filter((receipt) =>
    receipt.turnId === answer.correlation.turnId &&
    receipt.playbackAttemptId === answer.correlation.attemptId &&
    receipt.playbackKind === "answer"
  );
  const competingReceipts = evidence.conversation.lifecycle.playbackReceipts.filter((receipt) =>
    receipt.turnId === answer.correlation.turnId &&
    receipt.playbackKind === "answer" &&
    receipt.playbackAttemptId !== answer.correlation.attemptId
  );
  const started = receipts.filter((receipt) => receipt.status === "started");
  const finished = receipts.filter((receipt) => receipt.status === "finished");
  const settled = receipts.filter((receipt) => receipt.status === "settled");
  if (
    started.length !== 1 || finished.length !== 1 || settled.length !== 1 ||
    settled[0]!.settlement !== "played" || competingReceipts.length !== 0
  ) {
    fail(
      "ANSWER_PLAYBACK_RECEIPT_MISMATCH",
      "addressed answer requires unique started, finished, and settled-played receipts",
    );
    return;
  }

  const startedReceipt = started[0]!;
  const finishedReceipt = finished[0]!;
  const playedReceipt = settled[0]!;
  const captureStartMs = answer.capture.firstPacketAt.epochMilliseconds;
  const captureEndMs = answer.capture.endedAt.epochMilliseconds;
  const ordered = startedReceipt.playbackStartedAtEpochMs <=
      finishedReceipt.playbackFinishedAtEpochMs &&
    finishedReceipt.playbackFinishedAtEpochMs <=
      playedReceipt.playbackSettledAtEpochMs + timestampToleranceMs;
  const captureIsBoundedByPlayback = captureStartMs >=
      startedReceipt.playbackStartedAtEpochMs - timestampToleranceMs &&
    captureEndMs <= finishedReceipt.playbackFinishedAtEpochMs + timestampToleranceMs;
  if (!ordered || !captureIsBoundedByPlayback) {
    fail(
      "ANSWER_PLAYBACK_RECEIPT_MISMATCH",
      "answer playback receipts are unordered or do not bound the audible capture interval",
    );
  }
}
