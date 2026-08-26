import { describe, expect, it } from "vitest";

import {
  parseAuthoritativeTrackUploadMetadata,
  parseCraigLifecycleEvent,
  parseCraigPlaybackCommand,
  parseCraigPlaybackEvent,
  parseVoicePacket,
  parseVoicePacketBatch,
} from "../src/index.js";

const baseEvent = {
  schemaVersion: 1,
  eventId: "event-1",
  recordingId: "recording-1",
  guildId: "1533224474609057793",
  channelId: "1533224474609057794",
  occurredAt: "2026-08-02T20:00:00.000Z",
} as const;
const trustedProducer = {
  actorObservationState: "consistent",
  actorSemanticsVersion: 1,
  producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
  producerRevision: "0123456789abcdef0123456789abcdef01234567",
} as const;

describe("Craig gateway contracts", () => {
  it("accepts a versioned artifact-ready event", () => {
    const event = parseCraigLifecycleEvent({
      ...baseEvent,
      type: "recording.artifact_ready",
      endedAt: "2026-08-02T20:30:00.000Z",
      multitrackManifestKey: "recordings/recording-1/manifest.json",
      usersManifestKey: "recordings/recording-1/users.json",
    });

    expect(event.type).toBe("recording.artifact_ready");
  });

  it("accepts an authoritative-ready event with source evidence", () => {
    const event = parseCraigLifecycleEvent({
      ...baseEvent,
      type: "recording.authoritative_ready",
      endedAt: "2026-08-02T20:30:00.000Z",
      sourceFilesChecksumSha256: "a".repeat(64),
      trackCount: 2,
    });

    expect(event.type).toBe("recording.authoritative_ready");
  });

  it("accepts v2 lifecycle identity with an explicit actor vocabulary", () => {
    const actors = [
      { actorId: "1533224474609057795", kind: "human" },
      { actorId: "1533224474609057796", kind: "automation" },
      { actorId: "1533224474609057797", kind: "unknown" },
    ] as const;
    expect(parseCraigLifecycleEvent({
      ...baseEvent,
      actors,
      schemaVersion: 2,
      type: "meeting.started",
    })).toMatchObject({ actors, schemaVersion: 2 });
    expect(parseCraigLifecycleEvent({
      ...baseEvent,
      actors,
      endedAt: "2026-08-02T20:30:00.000Z",
      schemaVersion: 2,
      sourceFilesChecksumSha256: "a".repeat(64),
      trackCount: 3,
      type: "recording.authoritative_ready",
    })).toMatchObject({ actors, schemaVersion: 2 });
  });

  it("rejects duplicate actors, conflicting kinds, and inferred v2 participants", () => {
    expect(() => parseCraigLifecycleEvent({
      ...baseEvent,
      actors: [
        { actorId: "1533224474609057795", kind: "human" },
        { actorId: "1533224474609057795", kind: "automation" },
      ],
      schemaVersion: 2,
      type: "meeting.started",
    })).toThrow();
    expect(() => parseCraigLifecycleEvent({
      ...baseEvent,
      participantIds: ["1533224474609057795"],
      schemaVersion: 2,
      type: "meeting.started",
    })).toThrow();
  });

  it("accepts v3 lifecycle facts with exact producer and roster evidence", () => {
    const actors = [{ actorId: "1533224474609057795", kind: "human" }] as const;
    expect(parseCraigLifecycleEvent({
      ...baseEvent,
      ...trustedProducer,
      actors,
      rosterState: "unsealed",
      schemaVersion: 3,
      type: "meeting.started",
    })).toMatchObject({
      ...trustedProducer,
      actors,
      rosterState: "unsealed",
      schemaVersion: 3,
    });
    expect(parseCraigLifecycleEvent({
      ...baseEvent,
      ...trustedProducer,
      actors,
      endedAt: "2026-08-02T20:30:00.000Z",
      rosterState: "sealed",
      schemaVersion: 3,
      sourceFilesChecksumSha256: "a".repeat(64),
      trackCount: 1,
      type: "recording.authoritative_ready",
    })).toMatchObject({ rosterState: "sealed", schemaVersion: 3 });
  });

  it("enforces unsealed start and sealed authoritative-ready semantics", () => {
    const actors = [{ actorId: "1533224474609057795", kind: "human" }] as const;
    expect(() => parseCraigLifecycleEvent({
      ...baseEvent,
      ...trustedProducer,
      actors,
      rosterState: "sealed",
      schemaVersion: 3,
      type: "meeting.started",
    })).toThrow();
    expect(() => parseCraigLifecycleEvent({
      ...baseEvent,
      ...trustedProducer,
      actors,
      endedAt: "2026-08-02T20:30:00.000Z",
      rosterState: "unsealed",
      schemaVersion: 3,
      sourceFilesChecksumSha256: "a".repeat(64),
      trackCount: 1,
      type: "recording.authoritative_ready",
    })).toThrow();
  });

  it("parses unknown bounded v3 capabilities for recording while trust stays a consumer decision", () => {
    expect(parseCraigLifecycleEvent({
      ...baseEvent,
      ...trustedProducer,
      actors: [],
      producerCapabilityId: "meeting.lifecycle.future.v99",
      rosterState: "unsealed",
      schemaVersion: 3,
      type: "meeting.started",
    })).toMatchObject({
      producerCapabilityId: "meeting.lifecycle.future.v99",
      schemaVersion: 3,
    });
  });

  it("rejects capability-less or partially attested v3 events", () => {
    const complete = {
      ...baseEvent,
      ...trustedProducer,
      actors: [],
      rosterState: "unsealed",
      schemaVersion: 3,
      type: "meeting.started",
    } as const;
    const { producerRevision: _producerRevision, ...missingRevision } = complete;
    expect(() => parseCraigLifecycleEvent(missingRevision)).toThrow();
    expect(() => parseCraigLifecycleEvent({
      ...complete,
      actorSemanticsVersion: 0,
    })).toThrow();
    expect(() => parseCraigLifecycleEvent({
      ...complete,
      producerRevision: "not-an-immutable-revision",
    })).toThrow();
  });

  it("validates bounded authoritative track upload metadata", () => {
    expect(
      parseAuthoritativeTrackUploadMetadata({
        schemaVersion: 1,
        uploadId: "recording-1:track:1",
        recordingId: "recording-1",
        guildId: "1533224474609057793",
        channelId: "1533224474609057794",
        speakerId: "1533224474609057795",
        trackNumber: 1,
        timelineOffsetMs: 0,
        checksumSha256: "b".repeat(64),
        sizeBytes: 4096,
      }),
    ).toMatchObject({ trackNumber: 1, sizeBytes: 4096 });
  });

  it("fails closed when Craig leaks a secret or adds an unknown field", () => {
    expect(() =>
      parseCraigLifecycleEvent({
        ...baseEvent,
        type: "meeting.started",
        participantIds: [],
        accessKey: "must-never-cross-the-boundary",
      }),
    ).toThrow();
  });

  it("rejects traversal in artifact storage keys", () => {
    expect(() =>
      parseCraigLifecycleEvent({
        ...baseEvent,
        type: "recording.artifact_ready",
        endedAt: "2026-08-02T20:30:00.000Z",
        multitrackManifestKey: "../recording.info",
        usersManifestKey: "recordings/recording-1/users.json",
      }),
    ).toThrow();
  });

  it("keeps RTP sequence and owns a non-empty Opus buffer", () => {
    const packet = parseVoicePacket({
      schemaVersion: 1,
      recordingId: "recording-1",
      guildId: "1533224474609057793",
      channelId: "1533224474609057794",
      speakerId: "1533224474609057795",
      rtpTimestamp: 4_294_967_295,
      rtpSequence: 65_535,
      receivedAtMs: 1_754_167_200_000,
      relativeTimeMs: 1_250,
      opus: Uint8Array.of(1, 2, 3),
    });

    expect(packet.rtpSequence).toBe(65_535);
    expect(packet.opus).toEqual(Uint8Array.of(1, 2, 3));
  });
});

describe("voice packet batches", () => {
  it("accepts the Craig HTTP wire representation", () => {
    const batch = parseVoicePacketBatch({
      schemaVersion: 1,
      packets: [
        {
          schemaVersion: 1,
          recordingId: "recording-1",
          guildId: "1533228590643155034",
          channelId: "1533228823045214398",
          speakerId: "1533227577286852649",
          rtpTimestamp: 42,
          rtpSequence: 7,
          receivedAtMs: 1_000,
          relativeTimeMs: 20,
          opusBase64: "AQID",
        },
      ],
    });

    expect(batch.packets[0]?.opusBase64).toBe("AQID");
  });

  it("rejects empty, oversized, and unknown wire data", () => {
    expect(() => parseVoicePacketBatch({ schemaVersion: 1, packets: [] })).toThrow();
    expect(() =>
      parseVoicePacketBatch({
        schemaVersion: 1,
        packets: [
          {
            schemaVersion: 1,
            recordingId: "recording-1",
            guildId: "1533228590643155034",
            channelId: "1533228823045214398",
            speakerId: "1533227577286852649",
            rtpTimestamp: 42,
            rtpSequence: 7,
            receivedAtMs: 1_000,
            relativeTimeMs: 20,
            opusBase64: "not-base64",
            token: "must-not-cross-boundary",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("Craig conversation playback", () => {
  const playbackEnvelope = {
    schemaVersion: 1,
    recordingId: "recording-1",
    turnId: "turn-1",
    attemptId: "attempt-1",
  } as const;

  it("accepts one bounded PCM chunk and lifecycle commands", () => {
    expect(
      parseCraigPlaybackCommand({
        ...playbackEnvelope,
        type: "playback-start",
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        channels: 1,
      }),
    ).toMatchObject({ type: "playback-start" });
    expect(
      parseCraigPlaybackCommand({
        ...playbackEnvelope,
        type: "audio-chunk",
        sequence: 0,
        pcmBase64: Buffer.from(Uint8Array.of(1, 0, 2, 0)).toString("base64"),
      }),
    ).toMatchObject({ type: "audio-chunk", sequence: 0 });
    expect(
      parseCraigPlaybackCommand({
        ...playbackEnvelope,
        type: "playback-cancel",
        reason: "barge-in",
      }),
    ).toMatchObject({ type: "playback-cancel" });
  });

  it("accepts legacy v1 cancellation exactly and requires bound v2 cancellation evidence", () => {
    expect(parseCraigPlaybackCommand({
      ...playbackEnvelope,
      type: "playback-cancel",
      reason: "barge-in",
    })).toEqual({
      ...playbackEnvelope,
      type: "playback-cancel",
      reason: "barge-in",
    });
    expect(parseCraigPlaybackCommand({
      ...playbackEnvelope,
      schemaVersion: 2,
      type: "playback-cancel",
      meetingId: "meeting-1",
      cancellationObservedAtMs: 12_345,
      reason: "barge-in",
    })).toMatchObject({
      schemaVersion: 2,
      meetingId: "meeting-1",
      cancellationObservedAtMs: 12_345,
    });
  });

  it.each([
    { schemaVersion: 2, cancellationObservedAtMs: -1 },
    { schemaVersion: 2, cancellationObservedAtMs: 1.5 },
    { schemaVersion: 2, cancellationObservedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { schemaVersion: 2 },
    { schemaVersion: 3, cancellationObservedAtMs: 12_345 },
  ])("fails closed for malformed or future cancellation %#", (variant) => {
    expect(() => parseCraigPlaybackCommand({
      ...playbackEnvelope,
      type: "playback-cancel",
      meetingId: "meeting-1",
      reason: "barge-in",
      ...variant,
    })).toThrow();
  });

  it("accepts recording-scoped readiness and sender-side playback evidence", () => {
    expect(
      parseCraigPlaybackEvent({
        schemaVersion: 3,
        type: "session-ready",
        playbackCapabilities: {
          attestsDiscordVoiceSend: true,
          deduplicatesCommandIds: true,
          deduplicationRetentionSeconds: 300,
          replaysOriginalStartedAtMs: true,
        },
        recordingId: "recording-1",
        guildId: "1533224474609057793",
        channelId: "1533224474609057794",
        gatewaySessionId: "gateway-session-1",
      }),
    ).toMatchObject({ type: "session-ready" });
    expect(
      parseCraigPlaybackEvent({
        ...playbackEnvelope,
        type: "playback-started",
        startedAtMs: 4_000,
      }),
    ).toMatchObject({ type: "playback-started", startedAtMs: 4_000 });
  });

  it("rejects playback activation without complete sender durability attestation", () => {
    expect(() => parseCraigPlaybackEvent({
      schemaVersion: 1,
      type: "session-ready",
      recordingId: "recording-1",
      guildId: "1533224474609057793",
      channelId: "1533224474609057794",
      gatewaySessionId: "gateway-session-legacy",
    })).toThrow();
    expect(() => parseCraigPlaybackEvent({
      schemaVersion: 3,
      type: "session-ready",
      playbackCapabilities: {
        attestsDiscordVoiceSend: true,
        deduplicatesCommandIds: true,
        deduplicationRetentionSeconds: 300,
      },
      recordingId: "recording-1",
      guildId: "1533224474609057793",
      channelId: "1533224474609057794",
      gatewaySessionId: "gateway-session-without-original-start-replay",
    })).toThrow();
  });

  it("rejects unbounded, odd-length, or secret-bearing playback data", () => {
    expect(() =>
      parseCraigPlaybackCommand({
        ...playbackEnvelope,
        type: "audio-chunk",
        sequence: 0,
        pcmBase64: Buffer.from(Uint8Array.of(1)).toString("base64"),
      }),
    ).toThrow();
    expect(() =>
      parseCraigPlaybackCommand({
        ...playbackEnvelope,
        type: "playback-start",
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        channels: 1,
        providerApiKey: "must-not-cross-the-boundary",
      }),
    ).toThrow();
  });
});
