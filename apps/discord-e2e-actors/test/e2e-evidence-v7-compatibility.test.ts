import { describe, expect, it } from "vitest";

import {
  fixtureManifestV1Schema,
  verifyRetainedE2eEvidence,
} from "../src/e2e-evidence.js";
import {
  currentExpectedRevisions,
  manifest,
  retainedV7Evidence,
  speakerAId,
} from "./e2e-evidence-fixtures.js";

describe("retained conversation V7 compatibility", () => {
  it("keeps the historical v1 manifest shape readable for retained v7 evidence", () => {
    const historicalManifest = manifest();
    const voiceExpectation = historicalManifest.conversationVoiceExpectation;
    if (voiceExpectation === undefined) {
      throw new Error("conversation voice expectation fixture is missing");
    }
    delete voiceExpectation.botSpeakerId;
    delete voiceExpectation.observerGreetingLocale;
    delete historicalManifest.greetingLocaleTerms;
    delete historicalManifest.supplementalVoiceExpectation;
    for (const fixture of historicalManifest.fixtures) {
      delete fixture.greetingLocale;
      delete fixture.greetingNameStatus;
    }
    const parsed = fixtureManifestV1Schema.parse(historicalManifest);

    expect(verifyRetainedE2eEvidence(
      parsed,
      retainedV7Evidence(),
      currentExpectedRevisions,
    ).passed).toBe(true);
  });

  it("keeps the historical exact greeting event and capture turn binding", () => {
    const evidence = retainedV7Evidence();
    const greeting = evidence.conversation.lifecycle.events.find(
      (event) => event.type === "greeting" && event.participantId === speakerAId,
    );
    if (greeting === undefined || greeting.type !== "greeting") {
      throw new Error("Speaker A greeting fixture is missing");
    }
    greeting.turnId = `participant-greeting:${speakerAId}:retry-1`;

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining([
      "GREETING_TURN_MISMATCH",
      "LIFECYCLE_AUDIO_MISMATCH",
    ]));
  });
});
