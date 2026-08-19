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
  it("retains capability-less v2 identity without making it knowledge-eligible", async () => {
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
      identityProvenance: null,
      kind: "finalized",
      lifecycleGeneration: 2,
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

    expect(saved[0]).toMatchObject({
      actors,
      identityProvenance: null,
      lifecycleGeneration: 2,
      source,
    });
    expect(saved[0]?.recording.speakerAudio).toHaveLength(2);
  });

  it("persists exact sealed-roster v3 producer provenance", async () => {
    const saved: MeetingSnapshot[] = [];
    const identityProvenance = {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "0123456789abcdef0123456789abcdef01234567",
      rosterState: "sealed",
    } as const;
    const event: RecordingLifecycleCommand = {
      actors,
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      endedAt: "2026-08-02T00:02:00.000Z",
      eventId: "recording-v3:authoritative-ready",
      occurredAt: "2026-08-02T00:02:01.000Z",
      producerCapabilityId: identityProvenance.producerCapabilityId,
      producerRevision: identityProvenance.producerRevision,
      recordingId: "recording-v3",
      rosterState: "sealed",
      schemaVersion: 3,
      source,
      sourceFilesChecksumSha256: "a".repeat(64),
      trackCount: 2,
      type: "recording.authoritative_ready",
    };
    const application = ingress({
      actors,
      identityProvenance,
      kind: "finalized",
      lifecycleGeneration: 3,
      recording: {
        manifestLocator: "s3://meeting/recordings/recording-v3/manifest.json",
        recordingId: "recording-v3",
        speakerAudio: actors.map((actor) => ({
          audioLocator: `s3://meeting/recordings/recording-v3/${actor.actorId}.ogg`,
          speakerId: actor.actorId,
          timelineOffsetMs: 0,
        })),
      },
      replayed: false,
      source,
    }, saved);

    await application.ingestLifecycle(event);

    expect(saved[0]).toMatchObject({
      actors,
      identityProvenance,
      lifecycleGeneration: 3,
      source,
    });
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
      identityProvenance: null,
      kind: "finalized",
      lifecycleGeneration: 1,
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
