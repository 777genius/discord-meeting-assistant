import { describe, expect, it } from "vitest";

import {
  parseCraigLifecycleEvent,
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
