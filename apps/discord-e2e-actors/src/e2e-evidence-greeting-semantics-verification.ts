import { normalizeTranscriptSemantics } from "./e2e-evidence-text-metrics.js";
import type { FixtureManifestV1, RetainedE2eEvidenceV8, RetainedE2eEvidenceV9 } from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

export function verifyGreetingAudioSemantics(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV8 | RetainedE2eEvidenceV9,
  recordingStartMs: number,
  fail: VerificationFailureReporter,
): void {
  verifyPinnedGreetingParticipants(manifest, evidence, fail);
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
    const expectedGreeting = expectedGreetingForParticipant(manifest, greeting.participantId);
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
    if (
      greeting.participantNameStatus === "known" &&
      (expectedGreeting?.participantNameStatus !== "known" ||
        expectedGreeting.spokenToken === undefined ||
        !paddedTranscript.includes(
          ` ${normalizeTranscriptSemantics(expectedGreeting.spokenToken)} `,
        ))
    ) {
      fail(
        "NAMED_GREETING_AUDIO_SEMANTICS_MISSING",
        `audible ${greeting.greetingLocale} greeting does not contain its pinned spoken token`,
      );
    }
  }
}

interface PinnedGreetingExpectation {
  readonly greetingLocale: "en" | "ru";
  readonly participantId: string;
  readonly participantNameStatus: "known" | "unknown";
  readonly spokenToken?: string;
}

function verifyPinnedGreetingParticipants(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV8 | RetainedE2eEvidenceV9,
  fail: VerificationFailureReporter,
): void {
  const voice = manifest.conversationVoiceExpectation;
  const supplemental = manifest.supplementalVoiceExpectation;
  const fixtureExpectations = manifest.fixtures.flatMap((fixture) =>
    fixture.greetingLocale === undefined || fixture.greetingNameStatus === undefined
      ? []
      : [{
          greetingLocale: fixture.greetingLocale,
          participantId: fixture.speakerId,
          participantNameStatus: fixture.greetingNameStatus,
          ...(fixture.greetingSpokenToken === undefined
            ? {}
            : { spokenToken: fixture.greetingSpokenToken }),
        }]
  );
  if (
    voice === undefined ||
    voice.observerGreetingLocale === undefined ||
    supplemental === undefined ||
    manifest.fixtures.length !== 2 ||
    new Set(manifest.fixtures.map(({ actorName }) => actorName)).size !== 2 ||
    !manifest.fixtures.some(({ actorName }) => actorName === "speaker-a") ||
    !manifest.fixtures.some(({ actorName }) => actorName === "speaker-b") ||
    fixtureExpectations.length !== 2 ||
    fixtureExpectations.some(({ participantNameStatus, spokenToken }) =>
      participantNameStatus === "known" && spokenToken === undefined
    )
  ) {
    fail(
      "PINNED_GREETING_EXPECTATION_MISSING",
      "v8 manifest must pin the exact speaker-a, speaker-b, observer and speaker-d greeting roles",
    );
    return;
  }
  const expected: readonly PinnedGreetingExpectation[] = [
    ...fixtureExpectations,
    {
      greetingLocale: voice.observerGreetingLocale,
      participantId: voice.observerApplicationId,
      participantNameStatus: "unknown",
    },
    {
      greetingLocale: supplemental.greetingLocale,
      participantId: supplemental.applicationId,
      participantNameStatus: "unknown",
    },
  ];
  const greetings = evidence.conversation.lifecycle.events.filter(
    (event): event is Extract<typeof event, { type: "greeting" }> => event.type === "greeting",
  );
  const expectedIds = new Set(expected.map(({ participantId }) => participantId));
  if (
    expectedIds.size !== expected.length ||
    greetings.length !== expected.length ||
    expected.some((pinned) => !greetings.some((greeting) =>
      greeting.participantId === pinned.participantId &&
      greeting.greetingLocale === pinned.greetingLocale &&
      greeting.participantNameStatus === pinned.participantNameStatus
    ))
  ) {
    fail(
      "PINNED_GREETING_MISMATCH",
      "completed greetings do not match the four pinned actor identities",
    );
  }
}

function expectedGreetingForParticipant(
  manifest: FixtureManifestV1,
  participantId: string,
): PinnedGreetingExpectation | undefined {
  const fixture = manifest.fixtures.find(({ speakerId }) => speakerId === participantId);
  if (
    fixture?.greetingLocale === undefined ||
    fixture.greetingNameStatus === undefined
  ) {
    return undefined;
  }
  return {
    greetingLocale: fixture.greetingLocale,
    participantId,
    participantNameStatus: fixture.greetingNameStatus,
    ...(fixture.greetingSpokenToken === undefined
      ? {}
      : { spokenToken: fixture.greetingSpokenToken }),
  };
}
