import { describe, expect, it } from "vitest";

import {
  fixtureManifestV1Schema,
  retainedE2eEvidenceSchema,
  retainedE2eEvidenceV2Schema,
  verifyRetainedE2eEvidence as verifyRetainedE2eEvidenceAgainstExpectedRevision,
} from "../src/e2e-evidence.js";
import {
  currentExpectedRevisions,
  directMessageEvidence,
  expectedRevisions,
  manifest,
  overlapEvidence,
  reconnectEvidence,
  reidentify,
  retainedV4Evidence,
  retainedV5Evidence,
  retainedV6Evidence,
  retainedV7Evidence,
  retainedV8Evidence,
  sequentialEvidence,
  speakerAId,
  speakerBId,
  verifyE2eCampaign,
  verifyRetainedE2eEvidence,
} from "./e2e-evidence-fixtures.js";

describe("verifyRetainedE2eEvidence", () => {
  it("defaults a fixture speech start offset to playback start for existing manifests", () => {
    expect(manifest().fixtures.map(({ speechStartOffsetMs }) => speechStartOffsetMs)).toEqual([0, 0]);
  });

  it("rejects duplicate allowed bot speaker IDs in a fixture manifest", () => {
    expect(fixtureManifestV1Schema.safeParse({
      ...manifest(),
      allowedBotSpeakerIds: ["bot-1", "bot-1"],
    }).success).toBe(false);
  });

  it("rejects a supplemental answer nonce that is not pinned in the question", () => {
    const candidate = manifest();
    const supplemental = candidate.supplementalVoiceExpectation;
    if (supplemental === undefined) {
      throw new Error("supplemental voice expectation fixture is missing");
    }

    expect(fixtureManifestV1Schema.safeParse({
      ...candidate,
      supplementalVoiceExpectation: {
        ...supplemental,
        requiredQuestionTerms: ["ботик"],
      },
    }).success).toBe(false);
  });

  it.each([
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    7_000,
  ])("rejects an invalid fixture speech start offset: %s", (speechStartOffsetMs) => {
    const candidate = manifest();
    const firstFixture = candidate.fixtures[0];
    if (firstFixture === undefined) {
      throw new Error("speaker-a fixture is required");
    }

    expect(fixtureManifestV1Schema.safeParse({
      ...candidate,
      fixtures: [{ ...firstFixture, speechStartOffsetMs }, ...candidate.fixtures.slice(1)],
    }).success).toBe(false);
  });

  it("accepts accurate speaker, timing, overlap, evidence and replay proof", () => {
    const verification = verifyRetainedE2eEvidence(manifest(), overlapEvidence());

    expect(verification).toEqual({
      failures: [],
      metrics: [
        { characterErrorRate: 0, speakerId: speakerAId, wordErrorRate: 0 },
        { characterErrorRate: 0, speakerId: speakerBId, wordErrorRate: 0 },
      ],
      passed: true,
    });
  });

  it("allows pinned bot tracks without letting them satisfy human overlap", () => {
    const botSpeakerId = "1534231284467896512";
    const fixtureManifest = manifest();
    fixtureManifest.allowedBotSpeakerIds = [botSpeakerId];
    const evidence = sequentialEvidence();
    evidence.recording.speakerIds.push(botSpeakerId);
    evidence.recording.s3.tracks.push({
      checksumSha256: "4".repeat(64),
      durationMs: evidence.recording.durationMs,
      locator: "s3://bucket/meeting-1/botik.ogg",
      sizeBytes: 1_000,
      speakerId: botSpeakerId,
      timelineOffsetMs: 0,
    });
    evidence.transcript.turns.push({
      endMs: 7_000,
      speakerId: botSpeakerId,
      startMs: 6_500,
      text: "Synthetic Botik greeting",
      turnId: "turn-botik",
    });

    expect(verifyRetainedE2eEvidence(fixtureManifest, evidence).passed).toBe(true);

    fixtureManifest.allowedBotSpeakerIds = [];
    expect(verifyRetainedE2eEvidence(fixtureManifest, evidence).failures.map(({ code }) => code))
      .toContain("UNEXPECTED_SPEAKER");
  });

  it("keeps a complete retained v4 proof readable and verifiable", () => {
    const evidence = retainedV4Evidence();

    expect(retainedE2eEvidenceSchema.parse(evidence).schemaVersion).toBe(4);
    expect(verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      { ...expectedRevisions, subscriptionRuntime: "e".repeat(40) },
    ).passed).toBe(true);
  });

  it("keeps historical v5 clean-summary evidence readable", () => {
    const evidence = retainedV5Evidence();
    expect(retainedE2eEvidenceSchema.parse(evidence).schemaVersion).toBe(5);
    expect(verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).passed).toBe(true);
  });

  it("accepts the v6 layered summary with both evidence attachments", () => {
    const evidence = retainedV6Evidence();
    evidence.publication.embedDescription = [
      "## Итоги встречи",
      "Команда согласовала релиз и проверку очереди.",
      `Ответственный: <@${speakerBId}>`,
    ].join("\n");

    expect(verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).passed).toBe(true);
  });

});

describe("retained conversation evidence v7/v8", () => {
  it("continues accepting retained v7 evidence without supplemental fields", () => {
    const evidence = retainedV7Evidence();
    const result = verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    );

    expect(result.failures).toEqual([]);
  });

  it("preserves the historical v7 greeting acceptance contract", () => {
    const evidence = retainedV7Evidence();
    for (const event of evidence.conversation.lifecycle.events) {
      if (event.type === "greeting") {
        event.participantNameStatus = "unknown";
      }
    }

    const result = verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    );

    expect(result.failures).toEqual([]);
  });

  it("verifies lifecycle audio, once-only semantics and retained Botik answer", () => {
    const evidence = retainedV8Evidence();
    const result = verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    );
    expect(result.failures).toEqual([]);
  });

  it("accepts a bounded successful greeting retry with its exact audible capture", () => {
    const evidence = retainedV8Evidence();
    const greeting = evidence.conversation.lifecycle.events.find(
      (event) => event.type === "greeting" && event.participantId === speakerAId,
    );
    if (greeting === undefined) {
      throw new Error("speaker-a greeting fixture is missing");
    }
    const originalTurnId = greeting.turnId;
    const retryTurnId = `${originalTurnId}:retry-1`;
    greeting.turnId = retryTurnId;
    const baseCapture = evidence.conversation.voice.find(
      ({ correlation }) => correlation.turnId === originalTurnId,
    );
    if (baseCapture === undefined) {
      throw new Error("speaker-a greeting voice fixture is missing");
    }

    const result = verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    );

    expect(result.failures).toEqual([]);
  });

  it("rejects a greeting retry outside the bounded runtime policy", () => {
    const evidence = retainedV8Evidence();
    const greeting = evidence.conversation.lifecycle.events.find(
      (event) => event.type === "greeting" && event.participantId === speakerAId,
    );
    if (greeting === undefined) {
      throw new Error("speaker-a greeting fixture is missing");
    }
    const originalTurnId = greeting.turnId;
    const retryTurnId = `${originalTurnId}:retry-4`;
    greeting.turnId = retryTurnId;
    const baseCapture = evidence.conversation.voice.find(
      ({ correlation }) => correlation.turnId === originalTurnId,
    );
    if (baseCapture === undefined) {
      throw new Error("speaker-a greeting voice fixture is missing");
    }

    const codes = verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("GREETING_TURN_MISMATCH");
  });

  it("requires named greetings in both languages", () => {
    const evidence = retainedV8Evidence();
    for (const event of evidence.conversation.lifecycle.events) {
      if (event.type === "greeting") {
        event.participantNameStatus = "unknown";
      }
    }

    const codes = verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("NAMED_GREETING_LOCALE_MISSING");
  });

  it("requires each audible greeting to match its declared language", () => {
    const evidence = retainedV8Evidence();
    const englishGreeting = evidence.transcript.turns.find(
      ({ turnId }) => turnId === "botik-greeting-en",
    );
    if (englishGreeting === undefined) {
      throw new Error("English Botik greeting fixture is missing");
    }
    englishGreeting.text = "Добрый день";

    const codes = verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("GREETING_AUDIO_SEMANTICS_MISSING");
  });

  it("rejects audible lifecycle captures without one settled event", () => {
    const evidence = retainedV8Evidence();
    const extraCapture = structuredClone(evidence.conversation.voice[0]!);
    extraCapture.correlation.attemptId = "orphan-greeting-attempt";
    extraCapture.correlation.turnId = "participant-greeting:orphan-participant";
    evidence.conversation.voice.push(extraCapture);

    const codes = verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("ORPHAN_LIFECYCLE_AUDIO");
  });

});

describe("verifyRetainedE2eEvidence continued", () => {

  it("rejects v6 evidence when a layered attachment is absent", () => {
    const evidence = retainedV6Evidence();

    expect(retainedE2eEvidenceSchema.safeParse({
      ...evidence,
      publication: {
        ...evidence.publication,
        attachments: evidence.publication.attachments.slice(0, 1),
      },
    }).success).toBe(false);
  });

  it("rejects a changed layered attachment after replay", () => {
    const evidence = retainedV6Evidence();
    evidence.replay.attachments[0]!.sizeBytes += 1;

    expect(verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code)).toContain("REPLAY_ATTACHMENT_CHANGED");
  });

  it("keeps inherited processing and attachment gates active for v8", () => {
    const evidence = retainedV8Evidence();
    evidence.replay.attachments[0]!.sizeBytes += 1;
    const transcription = evidence.processing.stages.find(
      ({ stage }) => stage === "transcription",
    );
    if (transcription === undefined) {
      throw new Error("transcription processing fixture is missing");
    }
    transcription.durationMs = 30_001;

    const codes = verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining([
      "REPLAY_ATTACHMENT_CHANGED",
      "STAGE_LATENCY_EXCEEDED",
    ]));
  });

  it("treats Discord attachment ordering as non-semantic", () => {
    const evidence = retainedV6Evidence();
    evidence.replay.attachments.reverse();

    expect(verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).passed).toBe(true);
  });

  it("keeps historical v4 inline evidence requirements", () => {
    const evidence = retainedV4Evidence();
    evidence.publication.embedDescription = [
      "## Итоги встречи",
      `Ответственный: <@${speakerBId}>`,
    ].join("\n");

    const codes = verifyRetainedE2eEvidenceAgainstExpectedRevision(
      manifest(),
      evidence,
      { ...expectedRevisions, subscriptionRuntime: "e".repeat(40) },
    ).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining([
      "DISCORD_EVIDENCE_INTERVAL_MISSING",
      "DISCORD_SPEAKER_MENTION_MISSING",
    ]));
  });

  it("accepts a v3 direct-message receipt without inventing a thread", () => {
    const evidence = directMessageEvidence(overlapEvidence());

    expect(evidence.publication.container).toEqual({
      kind: "channel-message",
      parentChannelId: "1533228891827736657",
    });
    expect(evidence.publication.matchingThreadCount).toBe(0);
    expect(verifyRetainedE2eEvidence(manifest(), evidence).passed).toBe(true);
  });

  it("rejects a direct-message receipt that reports a thread marker", () => {
    const evidence = directMessageEvidence(overlapEvidence());
    evidence.publication.matchingThreadCount = 1;

    expect(verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code))
      .toContain("DUPLICATE_BUSINESS_EFFECT");
  });

  it("uses the shared Craig media origin once for cooked track durations", () => {
    const evidence = overlapEvidence();

    expect(evidence.recording.s3.tracks).toMatchObject([
      { durationMs: 7_000, timelineOffsetMs: 100 },
      { durationMs: 7_750, timelineOffsetMs: 850 },
    ]);
    expect(evidence.recording.durationMs).toBe(7_850);
    expect(verifyRetainedE2eEvidence(manifest(), evidence).passed).toBe(true);
  });

  it("rejects inaccurate transcription and missing required terminology", () => {
    const evidence = overlapEvidence();
    const turnB = evidence.transcript.turns[1];
    if (turnB === undefined) {
      throw new Error("speaker-b fixture turn is required");
    }
    evidence.transcript.turns[1] = {
      ...turnB,
      text: "Неразборчивая короткая фраза",
    };

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining(["WER_EXCEEDED", "CER_EXCEEDED", "TERM_MISSING"]));
  });

  it("treats the fixed spoken Russian date and its numeric STT form as equivalent", () => {
    const dateManifest = manifest();
    const speakerAFixture = dateManifest.fixtures[0];
    if (speakerAFixture === undefined) {
      throw new Error("speaker-a manifest fixture is required");
    }
    speakerAFixture.sourceText =
      "Проверить Discord thread до седьмого августа две тысячи двадцать шестого года";
    speakerAFixture.requiredTerms = ["Discord thread", "августа", "2026"];

    const evidence = overlapEvidence();
    const speakerATurn = evidence.transcript.turns[0];
    if (speakerATurn === undefined) {
      throw new Error("speaker-a transcript turn is required");
    }
    evidence.transcript.turns[0] = {
      ...speakerATurn,
      text: "Проверить Discord thread до 7 августа 2026 года",
    };

    const verification = verifyRetainedE2eEvidence(dateManifest, evidence);
    const speakerAMetrics = verification.metrics.find(({ speakerId }) => speakerId === speakerAId);

    expect(speakerAMetrics).toEqual({
      characterErrorRate: 0,
      speakerId: speakerAId,
      wordErrorRate: 0,
    });
    expect(verification.failures.map(({ code }) => code)).not.toContain("TERM_MISSING");
  });

  it("accepts mixed numeric and spoken dates in transcripts and summary deadlines", () => {
    const dateManifest = manifest();
    const speakerAFixture = dateManifest.fixtures[0];
    if (speakerAFixture === undefined) {
      throw new Error("speaker-a manifest fixture is required");
    }
    speakerAFixture.sourceText =
      "Проверить Discord thread до седьмого августа две тысячи двадцать шестого года";
    speakerAFixture.requiredTerms = ["Discord thread", "августа", "2026"];
    dateManifest.summaryExpectations.actionItems = [{
      deadline: "до 7 августа 2026 года",
      ownerSpeakerId: speakerBId,
      requiredTerms: ["Redis queue", "idempotency key"],
    }];

    const evidence = overlapEvidence();
    const speakerATurn = evidence.transcript.turns[0];
    const actionItem = evidence.summary.actionItems[0];
    if (speakerATurn === undefined || actionItem === undefined) {
      throw new Error("speaker-a turn and action item are required");
    }
    evidence.transcript.turns[0] = {
      ...speakerATurn,
      text: "Проверить Discord thread до 7 августа две тысячи двадцать шестого года",
    };
    evidence.summary.actionItems[0] = {
      ...actionItem,
      deadline: "до 7 августа две тысячи двадцать шестого года",
    };

    const verification = verifyRetainedE2eEvidence(dateManifest, evidence);

    expect(verification.failures.map(({ code }) => code)).not.toEqual(
      expect.arrayContaining(["TERM_MISSING", "ACTION_SEMANTICS_MISSING"]),
    );
  });

});

describe("verifyRetainedE2eEvidence failures and reconnect", () => {
  it("still fails required year evidence when STT loses 2026", () => {
    const dateManifest = manifest();
    const speakerAFixture = dateManifest.fixtures[0];
    if (speakerAFixture === undefined) {
      throw new Error("speaker-a manifest fixture is required");
    }
    speakerAFixture.sourceText =
      "Проверить Discord thread до седьмого августа две тысячи двадцать шестого года";
    speakerAFixture.requiredTerms = ["Discord thread", "августа", "2026"];

    const evidence = overlapEvidence();
    const speakerATurn = evidence.transcript.turns[0];
    if (speakerATurn === undefined) {
      throw new Error("speaker-a transcript turn is required");
    }
    evidence.transcript.turns[0] = {
      ...speakerATurn,
      text: "Проверить Discord thread до 7 августа года",
    };

    const codes = verifyRetainedE2eEvidence(dateManifest, evidence).failures.map(({ code }) => code);

    expect(codes).toContain("TERM_MISSING");
  });

  it("rejects missing evidence turns and duplicate replay effects", () => {
    const evidence = overlapEvidence();
    const decision = evidence.summary.decisions[0];
    if (decision === undefined) {
      throw new Error("summary decision fixture is required");
    }
    evidence.summary.decisions[0] = {
      ...decision,
      evidenceTurnIds: ["invented-turn"],
    };
    evidence.replay.matchingMessageCount = 2;
    evidence.replay.threadId = "duplicate-thread";

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining([
      "UNKNOWN_EVIDENCE_TURN",
      "DUPLICATE_BUSINESS_EFFECT",
      "REPLAY_IDENTITY_CHANGED",
    ]));
  });

  it("requires the complete summary contract and validates open-question evidence", () => {
    const evidence = overlapEvidence();
    const question = evidence.summary.openQuestions[0];
    if (question === undefined) {
      throw new Error("summary open-question fixture is required");
    }
    evidence.summary.openQuestions[0] = {
      ...question,
      evidenceTurnIds: ["invented-question-turn"],
    };
    evidence.summary.transcriptId = "different-transcript";

    const failures = verifyRetainedE2eEvidence(manifest(), evidence).failures;

    expect(failures).toContainEqual({
      code: "UNKNOWN_EVIDENCE_TURN",
      message: "open question references missing turn invented-question-turn",
    });
    expect(failures.map(({ code }) => code)).toContain("SUMMARY_TRANSCRIPT_MISMATCH");

    const incomplete = structuredClone(evidence) as unknown as {
      summary: { overview?: string };
    };
    delete incomplete.summary.overview;
    expect(retainedE2eEvidenceV2Schema.safeParse(incomplete).success).toBe(false);
  });

  it("requires initial ready, reconnect during speaker A, then one playback", () => {
    const evidence = reconnectEvidence();

    expect(verifyRetainedE2eEvidence(manifest(), evidence).passed).toBe(true);

    const initialReadyIndex = evidence.actorRun.events.findIndex(
      (event) => event.actorName === "speaker-b" && event.type === "ready",
    );
    if (initialReadyIndex < 0) {
      throw new Error("speaker-b initial ready event is required");
    }
    evidence.actorRun.events.splice(initialReadyIndex, 1);
    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);
    expect(codes).toContain("RECONNECT_SEQUENCE_INVALID");
  });

  it("rejects reconnect evidence bound to a different recording", () => {
    const evidence = reconnectEvidence();
    evidence.actorRun.recordingId = "different-recording";

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("ACTOR_RECORDING_CORRELATION_MISMATCH");
  });

  it("rejects speaker B playback beginning before reconnect ready", () => {
    const evidence = reconnectEvidence();
    const reconnectReadyIndex = evidence.actorRun.events.findIndex(
      (event, index) => index > 1 && event.actorName === "speaker-b" && event.type === "ready",
    );
    const reconnectReady = evidence.actorRun.events[reconnectReadyIndex];
    if (reconnectReady === undefined) {
      throw new Error("speaker-b reconnect ready event is required");
    }
    evidence.actorRun.events[reconnectReadyIndex] = {
      ...reconnectReady,
      atRecordingMs: 1_300,
    };

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("RECONNECT_SEQUENCE_INVALID");
  });

  it("rejects reconnect completion outside the continuing speaker A playback", () => {
    const evidence = reconnectEvidence();
    const readyIndex = evidence.actorRun.events.findIndex(
      (event, index) => index > 1 && event.actorName === "speaker-b" && event.type === "ready",
    );
    const ready = evidence.actorRun.events[readyIndex];
    if (ready === undefined) {
      throw new Error("speaker-b reconnect ready event is required");
    }
    evidence.actorRun.events[readyIndex] = { ...ready, atRecordingMs: 7_200 };

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("RECONNECT_NOT_DURING_SPEAKER_A");
  });
});

describe("verifyRetainedE2eEvidence sequential and campaign bounds", () => {
  it("accepts sequential Craig tracks with offset zero and retained initial silence", () => {
    expect(verifyRetainedE2eEvidence(manifest(), sequentialEvidence()).passed).toBe(true);
  });

  it("compares sequential transcript speech to actor playback instead of silent S3 origin", () => {
    const evidence = sequentialEvidence();
    const speakerBTurn = evidence.transcript.turns[1];
    if (speakerBTurn === undefined) {
      throw new Error("speaker-b sequential turn is required");
    }
    evidence.transcript.turns[1] = {
      ...speakerBTurn,
      startMs: 0,
    };

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("START_TIMESTAMP_MISMATCH");
  });

  it("anchors transcript speech after a configured silent fixture prefix", () => {
    const offsetManifest = manifest();
    const speakerA = offsetManifest.fixtures[0];
    const evidence = overlapEvidence();
    const speakerATurn = evidence.transcript.turns[0];
    if (speakerA === undefined || speakerATurn === undefined) {
      throw new Error("speaker-a fixture and turn are required");
    }
    speakerA.speechStartOffsetMs = 3_000;
    evidence.transcript.turns[0] = { ...speakerATurn, startMs: 3_100 };

    expect(verifyRetainedE2eEvidence(offsetManifest, evidence).passed).toBe(true);
  });

  it("still rejects transcript speech before a configured silent fixture prefix", () => {
    const offsetManifest = manifest();
    const speakerA = offsetManifest.fixtures[0];
    if (speakerA === undefined) {
      throw new Error("speaker-a fixture is required");
    }
    speakerA.speechStartOffsetMs = 3_000;

    const codes = verifyRetainedE2eEvidence(offsetManifest, overlapEvidence())
      .failures.map(({ code }) => code);

    expect(codes).toContain("START_TIMESTAMP_MISMATCH");
  });

  it("rejects an actor playback window extending beyond its silent S3 track", () => {
    const evidence = sequentialEvidence();
    const speakerBTrack = evidence.recording.s3.tracks[1];
    if (speakerBTrack === undefined) {
      throw new Error("speaker-b sequential track is required");
    }
    evidence.recording.s3.tracks[1] = {
      ...speakerBTrack,
      durationMs: 8_000,
    };

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("ACTOR_S3_TIMELINE_MISMATCH");
  });

  it("uses the single post-reconnect playback window as transcript bounds", () => {
    const lateStart = reconnectEvidence();
    const lateStartTurn = lateStart.transcript.turns[1];
    if (lateStartTurn === undefined) {
      throw new Error("speaker-b reconnect turn is required");
    }
    lateStart.transcript.turns[1] = { ...lateStartTurn, startMs: 2_500 };
    expect(
      verifyRetainedE2eEvidence(manifest(), lateStart).failures.map(({ code }) => code),
    ).toContain("START_TIMESTAMP_MISMATCH");

    const earlyEnd = reconnectEvidence();
    const earlyEndTurn = earlyEnd.transcript.turns[1];
    if (earlyEndTurn === undefined) {
      throw new Error("speaker-b reconnect turn is required");
    }
    earlyEnd.transcript.turns[1] = { ...earlyEndTurn, endMs: 7_600 };
    expect(
      verifyRetainedE2eEvidence(manifest(), earlyEnd).failures.map(({ code }) => code),
    ).toContain("END_TIMESTAMP_MISMATCH");
  });

  it("rejects internal Discord identifiers and missing human-readable UX evidence", () => {
    const evidence = overlapEvidence();
    evidence.publication.embedDescription =
      `turn:v1:hidden meeting-projection:raw ${evidence.summary.summaryId}`;

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining([
      "DISCORD_ACTION_OWNER_MENTION_MISSING",
      "DISCORD_EVIDENCE_INTERVAL_MISSING",
      "DISCORD_EVIDENCE_LABEL_MISSING",
      "DISCORD_INTERNAL_ID_VISIBLE",
      "DISCORD_SPEAKER_MENTION_MISSING",
    ]));
  });

  it("rejects provenance captured from containers deployed after the recording began", () => {
    const evidence = overlapEvidence();
    evidence.deployment.craig.containerStartedAt = "1970-01-01T00:00:01.000Z";

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("DEPLOYMENT_STARTED_AFTER_RECORDING");
  });

  it("requires all scenarios and isolated identities across the campaign", () => {
    const runs = [
      reidentify(sequentialEvidence(), "sequential"),
      reidentify(overlapEvidence(), "overlap"),
      reidentify(reconnectEvidence(), "reconnect"),
    ];

    expect(verifyE2eCampaign(manifest(), runs).passed).toBe(true);

    runs[2]!.publication.threadId = runs[1]!.publication.threadId;
    runs[2]!.replay.threadId = runs[1]!.replay.threadId;
    const failed = verifyE2eCampaign(manifest(), runs);
    expect(failed.failures.map(({ code }) => code)).toContain("CAMPAIGN_STATE_LEAK");
  });

  it("requires identical immutable deployment provenance across campaign runs", () => {
    const runs = [
      reidentify(sequentialEvidence(), "sequential"),
      reidentify(overlapEvidence(), "overlap"),
      reidentify(reconnectEvidence(), "reconnect"),
    ];
    runs[2]!.deployment.meetingPlatform.imageId = `sha256:${"c".repeat(64)}`;

    const codes = verifyE2eCampaign(manifest(), runs).failures.map(({ code }) => code);

    expect(codes).toContain("CAMPAIGN_DEPLOYMENT_CHANGED");
  });

  it("rejects a consistent campaign retained from an older release candidate", () => {
    const runs = [
      reidentify(sequentialEvidence(), "sequential"),
      reidentify(overlapEvidence(), "overlap"),
      reidentify(reconnectEvidence(), "reconnect"),
    ];
    for (const run of runs) {
      run.deployment.meetingPlatform.sourceRevision = "d".repeat(40);
    }

    const failed = verifyE2eCampaign(manifest(), runs);
    const runFailureCodes = Object.values(failed.runResults)
      .flatMap(({ failures }) => failures.map(({ code }) => code));
    expect(runFailureCodes).toContain("DEPLOYMENT_SOURCE_REVISION_MISMATCH");
  });

  it("allows a v3 direct-message campaign to share its results channel but not a message", () => {
    const runs = [
      directMessageEvidence(reidentify(sequentialEvidence(), "direct-sequential")),
      directMessageEvidence(reidentify(overlapEvidence(), "direct-overlap")),
      directMessageEvidence(reidentify(reconnectEvidence(), "direct-reconnect")),
    ];

    expect(verifyE2eCampaign(manifest(), runs).passed).toBe(true);

    runs[2]!.publication.messageId = runs[1]!.publication.messageId;
    runs[2]!.replay.messageId = runs[1]!.replay.messageId;
    expect(verifyE2eCampaign(manifest(), runs).failures.map(({ code }) => code))
      .toContain("CAMPAIGN_STATE_LEAK");
  });
});
