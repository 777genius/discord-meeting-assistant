import { describe, expect, it } from "vitest";

import {
  retainedE2eEvidenceV8Schema,
  retainedReconnectE2eEvidenceV8Schema,
  verifyRetainedE2eEvidence,
  type RetainedE2eEvidenceV8,
} from "../src/e2e-evidence.js";
import {
  currentExpectedRevisions,
  manifest,
  retainedV8Evidence,
  speakerBId,
} from "./e2e-evidence-fixtures.js";

type LifecycleEvent = RetainedE2eEvidenceV8["conversation"]["lifecycle"]["events"][number];
type GreetingEvent = Extract<LifecycleEvent, { type: "greeting" }>;

function botikFarewell(evidence: RetainedE2eEvidenceV8) {
  const turn = evidence.transcript.turns.find(
    ({ turnId }) => turnId === "botik-farewell-ru",
  );
  if (turn === undefined) {
    throw new Error("Botik farewell fixture is missing");
  }
  return turn;
}

function farewellEvent(evidence: RetainedE2eEvidenceV8) {
  const event = evidence.conversation.lifecycle.events.find(
    (candidate): candidate is Extract<LifecycleEvent, { type: "farewell" }> =>
      candidate.type === "farewell",
  );
  if (event === undefined) {
    throw new Error("farewell lifecycle fixture is missing");
  }
  return event;
}

function failureCodes(evidence: RetainedE2eEvidenceV8, fixtureManifest = manifest()) {
  return verifyRetainedE2eEvidence(
    fixtureManifest,
    evidence,
    currentExpectedRevisions,
  ).failures.map(({ code }) => code);
}

describe("retained conversation V8 supplemental semantics", () => {
  it("requires the pinned unknown observer greeting", () => {
    const fixtureManifest = manifest();
    const observerId = fixtureManifest.conversationVoiceExpectation?.observerApplicationId;
    if (observerId === undefined) {
      throw new Error("conversation observer expectation fixture is missing");
    }
    const evidence = retainedV8Evidence();
    evidence.conversation.lifecycle.events = evidence.conversation.lifecycle.events.filter(
      (event) => event.type !== "greeting" || event.participantId !== observerId,
    );

    const codes = verifyRetainedE2eEvidence(
      fixtureManifest,
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("PINNED_GREETING_MISMATCH");
  });

  it("requires the reconnect actor to use its pinned named English greeting", () => {
    const evidence = retainedV8Evidence();
    const greeting = evidence.conversation.lifecycle.events.find(
      (event): event is GreetingEvent =>
        event.type === "greeting" && event.participantId === speakerBId,
    );
    if (greeting === undefined) {
      throw new Error("reconnect greeting fixture is missing");
    }
    greeting.greetingLocale = "ru";

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("PINNED_GREETING_MISMATCH");
  });

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
      ({ turnId }) => turnId === "botik-answer-1",
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
});

describe("retained conversation V8 boundary policies", () => {
  it("ignores unrelated semantic lifecycle events when correlating the six captures", () => {
    const evidence = retainedV8Evidence();
    evidence.conversation.lifecycle.events.splice(1, 0, {
      greetingLocale: "ru",
      observedAt: "1970-01-01T00:00:00.250Z",
      participantId: "unrelated-participant",
      participantNameStatus: "unknown",
      turnId: "participant-greeting:unrelated-participant",
      type: "greeting",
    });

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).not.toContain("VOICE_CAMPAIGN_LIFECYCLE_INVALID");
    expect(codes).not.toContain("LIFECYCLE_AUDIO_MISMATCH");
  });

  it("requires the exact semantic and chronological capture campaign", () => {
    const extraEvidence = retainedV8Evidence();
    extraEvidence.conversation.voice.push(
      structuredClone(extraEvidence.conversation.voice[5]!),
    );
    const reorderedEvidence = retainedV8Evidence();
    [reorderedEvidence.conversation.voice[4], reorderedEvidence.conversation.voice[5]] = [
      reorderedEvidence.conversation.voice[5]!,
      reorderedEvidence.conversation.voice[4]!,
    ];
    const greetingAfterAnswer = retainedV8Evidence();
    [greetingAfterAnswer.conversation.voice[3], greetingAfterAnswer.conversation.voice[4]] = [
      greetingAfterAnswer.conversation.voice[4]!,
      greetingAfterAnswer.conversation.voice[3]!,
    ];

    for (const evidence of [extraEvidence, reorderedEvidence, greetingAfterAnswer]) {
      const codes = verifyRetainedE2eEvidence(
        manifest(),
        evidence,
        currentExpectedRevisions,
      ).failures.map(({ code }) => code);
      expect(codes).toContain("VOICE_CAMPAIGN_ORDER_INVALID");
    }
  });

  it("rejects lifecycle receipt timestamps swapped over canonical captures", () => {
    const evidence = retainedV8Evidence();
    const firstObservedAt = evidence.conversation.lifecycle.events[0]!.observedAt;
    evidence.conversation.lifecycle.events[0]!.observedAt =
      evidence.conversation.lifecycle.events[1]!.observedAt;
    evidence.conversation.lifecycle.events[1]!.observedAt = firstObservedAt;

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("VOICE_CAMPAIGN_LIFECYCLE_INVALID");
  });

  it("honors a tighter manifest tolerance for the addressed turn boundary", () => {
    const fixtureManifest = manifest();
    fixtureManifest.thresholds.timestampToleranceMs = 100;
    const evidence = retainedV8Evidence();
    const answerEvent = evidence.conversation.lifecycle.events.find(
      (event) => event.type === "addressed-answer",
    );
    if (answerEvent === undefined) {
      throw new Error("addressed answer lifecycle fixture is missing");
    }
    answerEvent.observedAt = "1970-01-01T00:00:03.450Z";

    const codes = verifyRetainedE2eEvidence(
      fixtureManifest,
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("SUPPLEMENTAL_ANSWER_INTERVAL_INVALID");
  });

  it("does not treat a farewell-term prefix as a whole farewell word", () => {
    const evidence = retainedV8Evidence();
    const farewellTurn = evidence.transcript.turns.find(
      ({ turnId }) => turnId === "speaker-d-farewell",
    );
    if (farewellTurn === undefined) {
      throw new Error("Speaker D farewell fixture is missing");
    }
    farewellTurn.text = "Всем покажи.";

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("SUPPLEMENTAL_FAREWELL_MISSING");
  });
});

describe("retained conversation V8 farewell response semantics", () => {
  it("rejects arbitrary Botik audio even when the transcript remains semantic", () => {
    const evidence = retainedV8Evidence();
    const farewellCapture = evidence.conversation.voice.find(
      ({ correlation }) => correlation.purpose === "farewell",
    );
    if (farewellCapture === undefined) {
      throw new Error("farewell capture fixture is missing");
    }
    farewellCapture.capture.pcm.sha256 = "b".repeat(64);

    expect(failureCodes(evidence)).toContain("SUPPLEMENTAL_FAREWELL_PCM_MISMATCH");
  });

  it("rejects a second farewell-shaped Botik turn outside the farewell capture", () => {
    const evidence = retainedV8Evidence();
    evidence.transcript.turns.push({
      endMs: 5_900,
      speakerId: evidence.conversation.botSpeakerId,
      startMs: 5_600,
      text: "Goodbye!",
      turnId: "botik-farewell-duplicate",
    });

    expect(failureCodes(evidence)).toContain("SUPPLEMENTAL_FAREWELL_DUPLICATE");
  });

  it.each([
    ["ru", "Покажи!"],
    ["en", "Goodbyeish!"],
  ] as const)("matches %s farewell terms as whole tokens", (locale, text) => {
    const fixtureManifest = manifest();
    const supplemental = fixtureManifest.supplementalVoiceExpectation;
    const evidence = retainedV8Evidence();
    if (supplemental === undefined) {
      throw new Error("farewell fixtures are missing");
    }
    supplemental.farewellLocale = locale;
    farewellEvent(evidence).locale = locale;
    botikFarewell(evidence).text = text;

    expect(failureCodes(evidence, fixtureManifest))
      .toContain("SUPPLEMENTAL_FAREWELL_SEMANTICS_MISSING");
  });

  it("fails closed when the manifest omits Botik farewell semantics", () => {
    const fixtureManifest = manifest();
    delete fixtureManifest.farewellLocaleTerms;

    expect(failureCodes(retainedV8Evidence(), fixtureManifest)).toEqual(
      expect.arrayContaining([
        "SUPPLEMENTAL_FAREWELL_SEMANTICS_EXPECTATION_MISSING",
        "SUPPLEMENTAL_FAREWELL_SEMANTICS_MISSING",
      ]),
    );
  });

  it("requires exactly one Botik transcript turn inside the farewell capture", () => {
    const evidence = retainedV8Evidence();
    evidence.transcript.turns.push({
      endMs: 7_000,
      speakerId: evidence.conversation.botSpeakerId,
      startMs: 6_800,
      text: "Фоновый ответ",
      turnId: "botik-farewell-overlap-extra",
    });

    expect(failureCodes(evidence)).toContain("SUPPLEMENTAL_FAREWELL_SEMANTICS_MISSING");
  });

  it("rejects an extra Botik turn that only partially overlaps the farewell capture", () => {
    const evidence = retainedV8Evidence();
    evidence.transcript.turns.push({
      endMs: 6_750,
      speakerId: evidence.conversation.botSpeakerId,
      startMs: 6_400,
      text: "Фоновая реплика",
      turnId: "partial-farewell-overlap",
    });

    expect(failureCodes(evidence)).toContain("SUPPLEMENTAL_FAREWELL_SEMANTICS_MISSING");
  });

  it("rejects a Botik farewell turn outside the audible farewell interval", () => {
    const evidence = retainedV8Evidence();
    const farewellTurn = botikFarewell(evidence);
    farewellTurn.startMs = 6_000;
    farewellTurn.endMs = 6_400;

    expect(failureCodes(evidence)).toContain("SUPPLEMENTAL_FAREWELL_SEMANTICS_MISSING");
  });

  it.each([
    ["starts before", 6_500, 6_900],
    ["ends after", 6_700, 7_300],
  ] as const)("rejects a farewell turn that %s the capture", (_label, startMs, endMs) => {
    const evidence = retainedV8Evidence();
    const farewellTurn = botikFarewell(evidence);
    farewellTurn.startMs = startMs;
    farewellTurn.endMs = endMs;

    expect(failureCodes(evidence)).toContain("SUPPLEMENTAL_FAREWELL_SEMANTICS_MISSING");
  });

  it("rejects a farewell transcript that does not match the settled locale", () => {
    const evidence = retainedV8Evidence();
    farewellEvent(evidence).locale = "en";
    botikFarewell(evidence).text = "Пока!";

    expect(failureCodes(evidence)).toEqual(expect.arrayContaining([
      "SUPPLEMENTAL_FAREWELL_LOCALE_MISMATCH",
      "SUPPLEMENTAL_FAREWELL_SEMANTICS_MISSING",
    ]));
  });

  it.each([
    "Я не говорю пока",
    "Скажи пока?",
    "Он сказал: пока",
    "Do not say goodbye",
    "Say goodbye?",
  ])("rejects farewell-like non-prepared text: %s", (text) => {
    const evidence = retainedV8Evidence();
    botikFarewell(evidence).text = text;

    expect(failureCodes(evidence)).toContain("SUPPLEMENTAL_FAREWELL_SEMANTICS_MISSING");
  });

  it("rejects a duplicate multiword farewell split across adjacent Botik turns", () => {
    const evidence = retainedV8Evidence();
    evidence.transcript.turns.push(
      { endMs: 5_200, speakerId: evidence.conversation.botSpeakerId, startMs: 5_000, text: "до", turnId: "split-farewell-1" },
      { endMs: 5_500, speakerId: evidence.conversation.botSpeakerId, startMs: 5_300, text: "встречи", turnId: "split-farewell-2" },
    );

    expect(failureCodes(evidence)).toContain("SUPPLEMENTAL_FAREWELL_DUPLICATE");
  });

  it("finds a split duplicate in chronological order despite interleaved transcript storage", () => {
    const evidence = retainedV8Evidence();
    evidence.transcript.turns.push(
      { endMs: 5_200, speakerId: evidence.conversation.botSpeakerId, startMs: 5_000, text: "до", turnId: "split-ordered-1" },
      { endMs: 2_000, speakerId: "1533873978417086474", startMs: 1_900, text: "interleaved", turnId: "interleaved-human" },
      { endMs: 5_500, speakerId: evidence.conversation.botSpeakerId, startMs: 5_300, text: "встречи", turnId: "split-ordered-2" },
    );

    expect(failureCodes(evidence)).toContain("SUPPLEMENTAL_FAREWELL_DUPLICATE");
  });

  it("does not join distant Botik fragments into a farewell duplicate", () => {
    const evidence = retainedV8Evidence();
    evidence.transcript.turns.push(
      { endMs: 4_000, speakerId: evidence.conversation.botSpeakerId, startMs: 3_900, text: "до", turnId: "distant-1" },
      { endMs: 5_500, speakerId: evidence.conversation.botSpeakerId, startMs: 5_400, text: "встречи", turnId: "distant-2" },
    );

    expect(failureCodes(evidence)).not.toContain("SUPPLEMENTAL_FAREWELL_DUPLICATE");
  });
});

describe("retained conversation V8 reconnect response semantics", () => {
  it("rejects a second audible greeting after reconnect even without a settled greeting log", () => {
    const evidence = retainedV8Evidence();
    evidence.transcript.turns.push({
      endMs: 2_700,
      speakerId: evidence.conversation.botSpeakerId,
      startMs: 2_400,
      text: "Hi, Test B!",
      turnId: "unlogged-reconnect-greeting",
    });

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("RECONNECT_AUDIBLE_GREETING_REPEATED");
  });

  it("does not hide a repeated reconnect greeting behind another participant capture", () => {
    const evidence = retainedV8Evidence();
    const otherGreeting = evidence.conversation.voice.find(
      ({ correlation }) =>
        correlation.purpose === "greeting" && correlation.turnId.endsWith("1533873978417086474"),
    );
    if (otherGreeting === undefined) {
      throw new Error("other participant greeting capture fixture is missing");
    }
    const startMs = 2_400;
    evidence.transcript.turns.push({
      endMs: startMs + 300,
      speakerId: evidence.conversation.botSpeakerId,
      startMs,
      text: "Hi, Test B!",
      turnId: "reconnect-greeting-over-other-capture",
    });

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("RECONNECT_AUDIBLE_GREETING_REPEATED");
  });

  it("still parses historical V8 while requiring current reconnect and playback proof", () => {
    const evidence = retainedV8Evidence();
    const { reconnectNoRepeat: _reconnectNoRepeat, ...legacyConversation } = evidence.conversation;
    const { recordingPlayback: _recordingPlayback, ...historicalEvidence } = evidence;

    const parsed = retainedE2eEvidenceV8Schema.parse({
      ...historicalEvidence,
      conversation: legacyConversation,
    });
    const codes = verifyRetainedE2eEvidence(
      manifest(),
      parsed,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("RECONNECT_NEGATIVE_PROOF_MISSING");
    expect(retainedReconnectE2eEvidenceV8Schema.safeParse({
      ...historicalEvidence,
      conversation: evidence.conversation,
    }).success).toBe(false);
  });

  it("rejects a generic greeting in place of a pinned known English name", () => {
    const evidence = retainedV8Evidence();
    const greetingTurn = evidence.transcript.turns.find(
      ({ turnId }) => turnId === "botik-greeting-en",
    );
    if (greetingTurn === undefined) {
      throw new Error("English greeting transcript fixture is missing");
    }
    greetingTurn.text = "Hi!";

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("NAMED_GREETING_AUDIO_SEMANTICS_MISSING");
  });

  it("rejects a generic greeting in place of a pinned known Russian name", () => {
    const evidence = retainedV8Evidence();
    const greetingTurn = evidence.transcript.turns.find(
      ({ turnId }) => turnId === "botik-greeting-ru",
    );
    if (greetingTurn === undefined) {
      throw new Error("Russian greeting transcript fixture is missing");
    }
    greetingTurn.text = "Привет!";

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("NAMED_GREETING_AUDIO_SEMANTICS_MISSING");
  });

  it("rejects reconnect proof without the SUT rejoin lifecycle receipt", () => {
    const evidence = retainedV8Evidence();
    evidence.conversation.reconnectNoRepeat.lifecycleReceipts =
      evidence.conversation.reconnectNoRepeat.lifecycleReceipts.filter(
        ({ eventType }) => eventType !== "participant.joined",
      );

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("RECONNECT_LIFECYCLE_RECEIPT_MISSING");
  });

  it("rejects a reconnect receipt that does not match the actor timeline", () => {
    const evidence = retainedV8Evidence();
    const rejoined = evidence.conversation.reconnectNoRepeat.lifecycleReceipts.find(
      ({ eventType }) => eventType === "participant.joined",
    );
    if (rejoined === undefined) {
      throw new Error("SUT rejoin receipt fixture is missing");
    }
    rejoined.occurredAt = "1970-01-01T00:00:03.000Z";

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("RECONNECT_LIFECYCLE_RECEIPT_MISMATCH");
  });

  it("rejects a negative window not continuously covered by the Botik track", () => {
    const evidence = retainedV8Evidence();
    const botikTrack = evidence.recording.s3.tracks.find(
      ({ speakerId }) => speakerId === evidence.conversation.botSpeakerId,
    );
    if (botikTrack === undefined) {
      throw new Error("Botik track fixture is missing");
    }
    botikTrack.durationMs -= 1_000;

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("RECONNECT_NEGATIVE_WINDOW_TRACK_GAP");
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
      { ...manifest(), allowedBotSpeakerIds: ["1533877611258708230"] },
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
    reconnectGreeting.observedAt = "1970-01-01T00:00:02.200Z";
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
