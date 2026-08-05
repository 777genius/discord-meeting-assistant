import { describe, expect, it, vi } from "vitest";

import { CraigRecordingIngressAdapter } from "../src/adapters/outbound/craig-recording-ingress-adapter.js";
import { canonicalLiveAudioFormat } from "../src/application/recording-ingress.js";

describe("CraigRecordingIngressAdapter", () => {
  it("maps provider-neutral application commands to Craig durability contracts", async () => {
    const ingestAuthoritativeTrack = vi.fn(async () => ({ replayed: false }));
    const ingestLifecycleEvent = vi.fn(async () => ({
      kind: "accepted" as const,
      recordingId: "recording-1",
      replayed: false,
    }));
    const ingestPacketBatch = vi.fn(async () => ({
      acceptedPackets: 1,
      duplicatePackets: 0,
      recordingId: "recording-1",
    }));
    const adapter = new CraigRecordingIngressAdapter({
      ingestAuthoritativeTrack,
      ingestLifecycleEvent,
      ingestPacketBatch,
    });
    const source = {
      roomId: "1533228823045214398",
      scopeId: "1533228590643155034",
    } as const;

    await adapter.ingestLifecycleEvent({
      eventId: "recording-1:start",
      occurredAt: "2026-08-02T00:00:00.000Z",
      participantIds: ["1533227577286852649"],
      recordingId: "recording-1",
      schemaVersion: 1,
      source,
      type: "meeting.started",
    });
    await adapter.ingestPacketBatch({
      format: canonicalLiveAudioFormat,
      packets: [
        {
          mediaTimestamp: 960,
          payloadBase64: "AQID",
          receivedAtMs: 1_000,
          recordingId: "recording-1",
          relativeTimeMs: 20,
          schemaVersion: 1,
          sequenceNumber: 7,
          source,
          speakerId: "1533227577286852649",
        },
      ],
      schemaVersion: 1,
    });
    const body = (async function* () {
      yield Uint8Array.from([1, 2, 3]);
    })();
    await adapter.ingestAuthoritativeTrack({
      checksumSha256: "a".repeat(64),
      recordingId: "recording-1",
      schemaVersion: 1,
      sizeBytes: 3,
      source,
      speakerId: "1533227577286852649",
      timelineOffsetMs: 0,
      trackNumber: 1,
      uploadId: "upload-1",
    }, body);

    expect(ingestLifecycleEvent).toHaveBeenCalledWith({
      channelId: source.roomId,
      eventId: "recording-1:start",
      guildId: source.scopeId,
      occurredAt: "2026-08-02T00:00:00.000Z",
      participantIds: ["1533227577286852649"],
      recordingId: "recording-1",
      schemaVersion: 1,
      type: "meeting.started",
    });
    expect(ingestPacketBatch).toHaveBeenCalledWith({
      packets: [
        {
          channelId: source.roomId,
          guildId: source.scopeId,
          opusBase64: "AQID",
          receivedAtMs: 1_000,
          recordingId: "recording-1",
          relativeTimeMs: 20,
          rtpSequence: 7,
          rtpTimestamp: 960,
          schemaVersion: 1,
          speakerId: "1533227577286852649",
        },
      ],
      schemaVersion: 1,
    });
    expect(ingestAuthoritativeTrack).toHaveBeenCalledWith({
      channelId: source.roomId,
      checksumSha256: "a".repeat(64),
      guildId: source.scopeId,
      recordingId: "recording-1",
      schemaVersion: 1,
      sizeBytes: 3,
      speakerId: "1533227577286852649",
      timelineOffsetMs: 0,
      trackNumber: 1,
      uploadId: "upload-1",
    }, body);
  });
});
