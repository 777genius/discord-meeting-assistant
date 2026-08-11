import type {
  RetainedE2eEvidence,
} from "./e2e-evidence-schema.js";
import type {
  VerificationFailureReporter,
} from "./e2e-evidence-verification-types.js";

type RetainedConversationEvidence = Extract<
  RetainedE2eEvidence,
  { schemaVersion: 7 | 8 }
>;

export function verifyAddressedAnswer(
  evidence: RetainedConversationEvidence,
  recordingStartMs: number,
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
