import type { MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";
import { describe, expect, it, vi } from "vitest";

import { PlatformRecordingIngress } from "../src/application/platform-ingress.js";
import type {
  RecordingLifecycleCommand,
  RecordingLifecycleIngressResult,
} from "../src/application/recording-ingress.js";

const source = {
  roomId: "1533228823045214398",
  scopeId: "1533228590643155034",
} as const;
const actors = [
  { actorId: "1533227577286852649", kind: "human" as const },
  { actorId: "1533227577286852650", kind: "automation" as const },
];

function ingress(
  result: RecordingLifecycleIngressResult,
  saved: MeetingSnapshot[],
): PlatformRecordingIngress {
  return new PlatformRecordingIngress({
    dispatcher: { dispatchPending: async () => ({ dispatched: 1, failed: 0 }) },
    failureClassifier: { classify: () => null },
    ingress: {
      ingestAuthoritativeTrack: async () => ({ replayed: false }),
      ingestLifecycleEvent: async () => result,
      ingestPacketBatch: async () => ({
        acceptedPackets: 0,
        duplicatePackets: 0,
        recordingId: "recording-1",
      }),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    metrics: {
      recordDerivedLiveFailure: vi.fn(),
      recordIngress: vi.fn(),
    },
    outbox: { recordAndSchedule: async (snapshot) => void saved.push(snapshot) },
    publicationTargets: { resolve: async () => "1533228891827736657" },
  });
}

describe("Platform recording identity admission", () => {
  it("creates a knowledge-eligible meeting from spool-retained v2 identity", async () => {
    const saved: MeetingSnapshot[] = [];
    const event: RecordingLifecycleCommand = {
      actors,
      endedAt: "2026-08-02T00:02:00.000Z",
      eventId: "recording-1:authoritative-ready",
      occurredAt: "2026-08-02T00:02:01.000Z",
      recordingId: "recording-1",
      schemaVersion: 2,
      source,
      sourceFilesChecksumSha256: "a".repeat(64),
      trackCount: 2,
      type: "recording.authoritative_ready",
    };
    const application = ingress({
      actors,
      kind: "finalized",
      recording: {
        manifestLocator: "s3://meeting/recordings/recording-1/manifest.json",
        recordingId: "recording-1",
        speakerAudio: [
          {
            audioLocator: "s3://meeting/recordings/recording-1/human.ogg",
            speakerId: actors[0]!.actorId,
            timelineOffsetMs: 0,
          },
          {
            audioLocator: "s3://meeting/recordings/recording-1/botik.ogg",
            speakerId: actors[1]!.actorId,
            timelineOffsetMs: 0,
          },
        ],
      },
      replayed: false,
      source,
    }, saved);

    await application.ingestLifecycle(event);

    expect(saved[0]).toMatchObject({ actors, source });
    expect(saved[0]?.recording.speakerAudio).toHaveLength(2);
  });

  it("uses source for v1 routing without enriching legacy meeting identity", async () => {
    const saved: MeetingSnapshot[] = [];
    const event: RecordingLifecycleCommand = {
      endedAt: "2026-08-02T00:02:00.000Z",
      eventId: "recording-legacy:authoritative-ready",
      occurredAt: "2026-08-02T00:02:01.000Z",
      recordingId: "recording-legacy",
      schemaVersion: 1,
      source,
      sourceFilesChecksumSha256: "a".repeat(64),
      trackCount: 1,
      type: "recording.authoritative_ready",
    };
    const application = ingress({
      actors: null,
      kind: "finalized",
      recording: {
        manifestLocator: "s3://meeting/recordings/recording-legacy/manifest.json",
        recordingId: "recording-legacy",
        speakerAudio: [{
          audioLocator: "s3://meeting/recordings/recording-legacy/human.ogg",
          speakerId: actors[0]!.actorId,
          timelineOffsetMs: 0,
        }],
      },
      replayed: true,
      source,
    }, saved);

    await application.ingestLifecycle(event);

    expect(saved[0]).toMatchObject({ actors: null, source: null });
  });
});
