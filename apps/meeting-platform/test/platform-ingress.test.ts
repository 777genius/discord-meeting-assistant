import type {
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
import type {
  MeetingRepository,
  MeetingSnapshot,
} from "@discord-meeting/meeting-core";
import type { Logger, Metrics } from "@discord-meeting/observability-adapter";
import type {
  LifecycleIngressResult,
  PacketBatchIngressResult,
} from "@discord-meeting/recording-ingress-adapter";
import { describe, expect, it, vi } from "vitest";

import { PlatformCraigIngress } from "../src/platform-ingress.js";

const meetingEnded: CraigLifecycleEvent = {
  channelId: "1533228823045214398",
  eventId: "recording-1:end",
  guildId: "1533228590643155034",
  occurredAt: "2026-08-02T00:02:00.000Z",
  reason: "completed",
  recordingId: "recording-1",
  schemaVersion: 1,
  type: "meeting.ended",
};

const logger: Logger = {
  child: () => logger,
  debug: vi.fn(),
  error: vi.fn(),
  flush: vi.fn(async () => {}),
  info: vi.fn(),
  warn: vi.fn(),
};

const metrics: Metrics = {
  observeStage: vi.fn(),
  recordDeadLetter: vi.fn(),
  recordDiscordPublication: vi.fn(),
  recordIngress: vi.fn(),
  recordQueueRetry: vi.fn(),
  setProviderHealth: vi.fn(),
  setQueueState: vi.fn(),
};

describe("Platform Craig ingress", () => {
  it("persists a finalized recording before idempotently enqueueing post-call work", async () => {
    const order: string[] = [];
    const saved: MeetingSnapshot[] = [];
    const meetings: MeetingRepository = {
      findById: async () => null,
      save: async (snapshot) => {
        order.push("save");
        saved.push(snapshot);
      },
    };
    const enqueue = vi.fn(async () => {
      order.push("enqueue");
    });
    const lifecycleResult: LifecycleIngressResult = {
      kind: "finalized",
      recording: {
        manifestLocator: "s3://meeting/recordings/recording-1/manifest.json",
        recordingId: "recording-1",
        speakerAudio: [{
          audioLocator: "s3://meeting/recordings/recording-1/speaker.ogg",
          speakerId: "1533227577286852649",
          timelineOffsetMs: 0,
        }],
      },
      replayed: false,
    };
    const ingress = new PlatformCraigIngress({
      enqueuer: { enqueue },
      ingress: {
        ingestLifecycleEvent: async (): Promise<LifecycleIngressResult> => lifecycleResult,
        ingestPacketBatch: async (): Promise<PacketBatchIngressResult> => ({
          acceptedPackets: 1,
          duplicatePackets: 0,
          recordingId: "recording-1",
        }),
      },
      logger,
      meetings,
      metrics,
      publicationTargetId: "1533228891827736657",
    });

    await ingress.ingestLifecycle(meetingEnded);

    expect(order).toEqual(["save", "enqueue"]);
    expect(saved[0]).toMatchObject({
      meetingId: "recording-1",
      publicationTargetId: "1533228891827736657",
      revision: 0,
    });
    expect(enqueue).toHaveBeenCalledWith({ meetingId: "recording-1", schemaVersion: 1 });
  });

  it("does not enqueue non-final lifecycle events", async () => {
    const enqueue = vi.fn(async () => {});
    const ingress = new PlatformCraigIngress({
      enqueuer: { enqueue },
      ingress: {
        ingestLifecycleEvent: async (): Promise<LifecycleIngressResult> => ({
          kind: "accepted",
          recordingId: "recording-1",
          replayed: false,
        }),
        ingestPacketBatch: async (_batch: VoicePacketBatch) => ({
          acceptedPackets: 1,
          duplicatePackets: 0,
          recordingId: "recording-1",
        }),
      },
      logger,
      meetings: { findById: async () => null, save: async () => {} },
      metrics,
      publicationTargetId: "1533228891827736657",
    });

    await ingress.ingestLifecycle({ ...meetingEnded, type: "meeting.aborted" });

    expect(enqueue).not.toHaveBeenCalled();
  });
});
