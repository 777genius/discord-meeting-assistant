import {
  e2eServiceLevelsV1Schema,
  type E2eServiceLevelsV1,
  type ServiceLevelThresholds,
} from "../src/e2e-service-levels.js";

export const exactServiceLevelThresholds: ServiceLevelThresholds = {
  "join-to-greeting-first-packet": 105,
  "question-end-to-answer-first-packet": 505,
  "recording-end-to-discord-first-seen": 205,
};

const identity = { meetingId: "meeting-1", runId: "run-overlap-1" } as const;

export function serviceLevelsProof(): E2eServiceLevelsV1 {
  return e2eServiceLevelsV1Schema.parse({
    measurements: [
      {
        clockSkewAttestation: attestation("join", "meeting-clock", "observer-clock", 5),
        end: {
          atEpochMs: 1_600,
          clockId: "observer-clock",
          source: {
            ...identity,
            attemptId: "greeting-en",
            kind: "conversation-voice-first-packet",
            purpose: "greeting",
            recordingId: "meeting-1",
            turnId: "participant-greeting:1533228054724346087",
          },
        },
        measurementId: "join-to-greeting",
        serviceLevelId: "join-to-greeting-first-packet",
        start: {
          atEpochMs: 1_500,
          clockId: "meeting-clock",
          source: {
            ...identity,
            eventType: "participant.joined",
            kind: "participant-joined-receipt",
            observedAt: "1970-01-01T00:00:01.500Z",
            occurredAt: "1970-01-01T00:00:01.500Z",
            participantId: "1533228054724346087",
          },
        },
        upperBoundMs: 105,
      },
      {
        clockSkewAttestation: attestation("answer", "recording-clock", "observer-clock", 5),
        end: {
          atEpochMs: 4_100,
          clockId: "observer-clock",
          source: {
            ...identity,
            attemptId: "answer",
            kind: "conversation-voice-first-packet",
            purpose: "addressed-answer",
            recordingId: "meeting-1",
            turnId: "human-question-1",
          },
        },
        measurementId: "question-to-answer",
        serviceLevelId: "question-end-to-answer-first-packet",
        start: {
          atEpochMs: 3_600,
          clockId: "recording-clock",
          source: {
            ...identity,
            kind: "authoritative-transcript-turn-end",
            recordingId: "meeting-1",
            transcriptId: "transcript-1",
            turnId: "speaker-d-question",
          },
        },
        upperBoundMs: 505,
      },
      {
        clockSkewAttestation: attestation("link", "recording-clock", "discord-observer-clock", 5),
        end: {
          atEpochMs: 9_500,
          clockId: "discord-observer-clock",
          source: {
            ...identity,
            capabilitySha256: "6".repeat(64),
            container: { kind: "channel-message", parentChannelId: "1533228891827736657" },
            firstSeenPollCompletedAt: { epochMilliseconds: 9_500, monotonicMilliseconds: 19_500 },
            firstSeenPollStartedAt: { epochMilliseconds: 9_490, monotonicMilliseconds: 19_490 },
            kind: "discord-playback-link-first-seen-proof",
            messageId: "message-1",
            origin: "https://recordings.example.test",
            pathname: "/recordings/playback",
            projectionMarker: "meeting-1:final",
            recordingId: "meeting-1",
            resultChannelId: "1533228891827736657",
          },
        },
        measurementId: "recording-to-link",
        serviceLevelId: "recording-end-to-discord-first-seen",
        start: {
          atEpochMs: 9_300,
          clockId: "recording-clock",
          source: { ...identity, kind: "authoritative-recording-end", recordingId: "meeting-1" },
        },
        upperBoundMs: 205,
      },
    ],
    schemaVersion: 1,
  });
}

export function serviceLevelSourcesProof() {
  const measurement = serviceLevelsProof().measurements.find(({ serviceLevelId }) =>
    serviceLevelId === "recording-end-to-discord-first-seen"
  )!;
  if (measurement.serviceLevelId !== "recording-end-to-discord-first-seen") {
    throw new Error("link fixture required");
  }
  const link = measurement.end.source;
  return {
    discordPlaybackLinkProof: {
      capabilitySha256: link.capabilitySha256, container: link.container,
      firstSeenPollCompletedAt: link.firstSeenPollCompletedAt, firstSeenPollStartedAt: link.firstSeenPollStartedAt,
      messageId: link.messageId, origin: link.origin, pathname: link.pathname,
      projectionMarker: link.projectionMarker, recordingId: link.recordingId,
      resultChannelId: link.resultChannelId, runId: link.runId, schemaVersion: 1 as const,
    },
    participantLifecycleReceipts: [{
      eventType: "participant.joined" as const, observedAt: "1970-01-01T00:00:01.500Z",
      occurredAt: "1970-01-01T00:00:01.500Z", participantId: "1533228054724346087",
      type: "participant-lifecycle" as const,
    }],
    schemaVersion: 1 as const,
  };
}

export function serviceLevelEvidenceForIdentity(input: {
  readonly meetingId: string;
  readonly messageId: string;
  readonly runId: string;
  readonly transcriptId: string;
}) {
  const serviceLevels = serviceLevelsProof();
  for (const measurement of serviceLevels.measurements) {
    measurement.start.source.meetingId = input.meetingId;
    measurement.start.source.runId = input.runId;
    measurement.end.source.meetingId = input.meetingId;
    measurement.end.source.runId = input.runId;
    if ("recordingId" in measurement.start.source) {
      measurement.start.source.recordingId = input.meetingId;
    }
    measurement.end.source.recordingId = input.meetingId;
    if (measurement.serviceLevelId === "question-end-to-answer-first-packet") {
      measurement.start.source.transcriptId = input.transcriptId;
    }
    if (measurement.serviceLevelId === "recording-end-to-discord-first-seen") {
      measurement.end.source.messageId = input.messageId;
      measurement.end.source.recordingId = input.meetingId;
    }
  }
  const serviceLevelSources = serviceLevelSourcesProof();
  serviceLevelSources.discordPlaybackLinkProof.messageId = input.messageId;
  serviceLevelSources.discordPlaybackLinkProof.recordingId = input.meetingId;
  serviceLevelSources.discordPlaybackLinkProof.runId = input.runId;
  return { serviceLevels, serviceLevelSources };
}

function attestation(id: string, startClockId: string, endClockId: string, skew: number) {
  return {
    attestationId: `attestation-${id}`,
    clockSkewBoundMs: skew,
    endClockId,
    schemaVersion: 1 as const,
    startClockId,
  };
}
