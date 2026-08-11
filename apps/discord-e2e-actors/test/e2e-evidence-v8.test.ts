import { describe, expect, it } from "vitest";

import { verifyRetainedE2eEvidence } from "../src/e2e-evidence.js";
import {
  currentExpectedRevisions,
  manifest,
  retainedV8Evidence,
  speakerBId,
} from "./e2e-evidence-fixtures.js";

describe("retained conversation V8 supplemental semantics", () => {
  it("requires the supplemental Speaker D default-locale greeting", () => {
    const fixtureManifest = manifest();
    const supplemental = fixtureManifest.supplementalVoiceExpectation;
    if (supplemental === undefined) {
      throw new Error("supplemental voice expectation fixture is missing");
    }
    const evidence = retainedV8Evidence();
    evidence.conversation.lifecycle.events = evidence.conversation.lifecycle.events.filter(
      (event) => event.type !== "greeting" || event.participantId !== supplemental.applicationId,
    );

    const codes = verifyRetainedE2eEvidence(
      fixtureManifest,
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("SUPPLEMENTAL_GREETING_MISMATCH");
  });

  it("rejects misbound or semantically unproven supplemental Botik evidence", () => {
    const evidence = retainedV8Evidence();
    evidence.conversation.supplementalPlayback.actor.authenticatedApplicationId =
      "1534999999999999999";
    const botikTurn = evidence.transcript.turns.find(
      ({ speakerId }) => speakerId === evidence.conversation.botSpeakerId,
    );
    if (botikTurn === undefined) {
      throw new Error("Botik answer fixture is missing");
    }
    botikTurn.text = "Нерелевантный ответ";
    const answer = evidence.conversation.voice.find(
      ({ correlation }) => correlation.purpose === "addressed-answer",
    );
    if (answer === undefined) {
      throw new Error("addressed answer capture fixture is missing");
    }
    answer.capture.startedAt.epochMilliseconds = 3_400;
    answer.capture.firstPacketAt.epochMilliseconds = 3_500;
    answer.capture.endedAt.epochMilliseconds = 3_700;

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining([
      "SUPPLEMENTAL_IDENTITY_MISMATCH",
      "SUPPLEMENTAL_ANSWER_INTERVAL_INVALID",
      "SUPPLEMENTAL_ANSWER_SEMANTICS_MISSING",
    ]));
  });

  it("rejects a Botik farewell that starts before Speaker D finishes", () => {
    const evidence = retainedV8Evidence();
    const farewell = evidence.conversation.voice.find(
      ({ correlation }) => correlation.purpose === "farewell",
    );
    if (farewell === undefined) {
      throw new Error("farewell capture fixture is missing");
    }
    farewell.capture.startedAt.epochMilliseconds = 4_900;
    farewell.capture.firstPacketAt.epochMilliseconds = 5_000;

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("SUPPLEMENTAL_FAREWELL_EVIDENCE_MISMATCH");
  });

  it("requires Botik to answer the group farewell in its pinned language", () => {
    const evidence = retainedV8Evidence();
    const farewell = evidence.conversation.lifecycle.events.find(
      (event) => event.type === "farewell",
    );
    if (farewell === undefined) {
      throw new Error("farewell lifecycle fixture is missing");
    }
    farewell.locale = "en";

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("SUPPLEMENTAL_FAREWELL_LOCALE_MISMATCH");
  });

  it("rejects stale, duplicate and misbound v8 conversation evidence", () => {
    const evidence = retainedV8Evidence();
    evidence.conversation.lifecycle.events.push({
      ...evidence.conversation.lifecycle.events[0]!,
    });
    evidence.conversation.voice[0]!.runId = "stale-run";
    evidence.conversation.voice[0]!.capture.firstPacketAt.epochMilliseconds = 20_000;
    evidence.conversation.voice[0]!.capture.endedAt.epochMilliseconds = 20_500;
    evidence.conversation.voice[1]!.observer.applicationId = "1534999999999999999";
    evidence.conversation.voice[2]!.correlation.recordingId = "wrong-recording";
    evidence.conversation.voice[4]!.correlation.attemptId =
      evidence.conversation.voice[3]!.correlation.attemptId;
    evidence.conversation.botSpeakerId = "wrong-bot-speaker";
    const codes = verifyRetainedE2eEvidence(
      { ...manifest(), allowedBotSpeakerIds: ["1534231284467896512"] },
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining([
      "DUPLICATE_GREETING",
      "VOICE_CORRELATION_MISMATCH",
      "VOICE_IDENTITY_MISMATCH",
      "STALE_VOICE_CAPTURE",
      "DUPLICATE_VOICE_ATTEMPT",
      "BOT_RECORDING_TRACK_MISSING",
      "BOT_SPEAKER_NOT_PINNED",
      "ANSWER_TRANSCRIPT_MISMATCH",
    ]));
  });

  it("binds the first greeting to the reconnect actor and audible Botik source", () => {
    const evidence = retainedV8Evidence();
    const reconnectGreeting = evidence.conversation.lifecycle.events.find(
      (event) => event.type === "greeting" && event.participantId === speakerBId,
    );
    if (reconnectGreeting === undefined) {
      throw new Error("reconnect greeting fixture is missing");
    }
    reconnectGreeting.observedAt = "1970-01-01T00:00:01.300Z";
    evidence.conversation.lifecycle.events[0]!.observedAt = "1970-01-01T00:00:07.000Z";
    evidence.conversation.voice[1]!.source.craigBotId = "1534999999999999998";
    evidence.conversation.voice[2]!.observer.voiceChannelId = "1534999999999999997";

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining([
      "LIFECYCLE_AUDIO_MISMATCH",
      "RECONNECT_GREETING_ORDER_INVALID",
      "VOICE_IDENTITY_MISMATCH",
    ]));
  });

  it.each([
    ["applicationId", "1534999999999999996"],
    ["guildId", "1534999999999999995"],
    ["voiceChannelId", "1534999999999999994"],
  ] as const)("rejects a consistently wrong observer %s", (field, value) => {
    const evidence = retainedV8Evidence();
    for (const observation of evidence.conversation.voice) {
      observation.observer[field] = value;
      if (field === "applicationId") {
        observation.observer.authenticatedBotId = value;
      }
    }

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("VOICE_IDENTITY_MISMATCH");
  });
});
