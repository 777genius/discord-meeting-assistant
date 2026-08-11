import { normalizeTranscriptSemantics } from "./e2e-evidence-text-metrics.js";
import type { FixtureManifestV1, RetainedE2eEvidenceV8 } from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

export function verifyGreetingAudioSemantics(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV8,
  recordingStartMs: number,
  fail: VerificationFailureReporter,
): void {
  const localeTerms = manifest.greetingLocaleTerms;
  if (localeTerms === undefined) {
    fail(
      "GREETING_SEMANTICS_EXPECTATION_MISSING",
      "v8 manifest must pin recognizable greeting terms for both languages",
    );
    return;
  }
  const greetings = evidence.conversation.lifecycle.events.filter(
    (event) => event.type === "greeting",
  );
  for (const greeting of greetings) {
    const captures = evidence.conversation.voice.filter(({ correlation }) =>
      correlation.purpose === "greeting" &&
      (correlation.turnId === greeting.turnId ||
        correlation.turnId === `participant-greeting:${greeting.participantId}`)
    );
    if (captures.length !== 1) {
      continue;
    }
    const captureStartMs =
      captures[0]!.capture.firstPacketAt.epochMilliseconds - recordingStartMs;
    const captureEndMs = captures[0]!.capture.endedAt.epochMilliseconds - recordingStartMs;
    const transcriptText = normalizeTranscriptSemantics(
      evidence.transcript.turns.filter((turn) =>
        turn.speakerId === evidence.conversation.botSpeakerId &&
        turn.startMs < captureEndMs && captureStartMs < turn.endMs
      ).map(({ text }) => text).join(" "),
    );
    const paddedTranscript = ` ${transcriptText} `;
    if (!localeTerms[greeting.greetingLocale].some((term) =>
      paddedTranscript.includes(` ${normalizeTranscriptSemantics(term)} `))) {
      fail(
        "GREETING_AUDIO_SEMANTICS_MISSING",
        `audible ${greeting.greetingLocale} greeting is absent from the Botik transcript interval`,
      );
    }
  }
}
