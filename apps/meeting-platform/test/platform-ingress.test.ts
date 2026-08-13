import {
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import type {
  IngressMetrics,
  Logger,
} from "@discord-meeting/observability-adapter";
import { describe, expect, it, vi } from "vitest";

import {
  MeetingPublicationTargetUnavailableError,
  PlatformRecordingIngress,
} from "../src/application/platform-ingress.js";
import {
  canonicalLiveAudioFormat,
  RecordingIngressRejectedError,
  type DerivedLiveLifecycleEvent,
  type LiveVoicePacketBatchCommand,
  type RecordingLifecycleCommand,
  type RecordingLifecycleIngressResult,
} from "../src/application/recording-ingress.js";

const meetingEnded: RecordingLifecycleCommand = {
  eventId: "recording-1:end",
  occurredAt: "2026-08-02T00:02:00.000Z",
  reason: "completed",
  recordingId: "recording-1",
  schemaVersion: 1,
  source: {
    roomId: "1533228823045214398",
    scopeId: "1533228590643155034",
  },
  type: "meeting.ended",
};

const voiceBatch: LiveVoicePacketBatchCommand = {
  format: canonicalLiveAudioFormat,
  packets: [
    {
      mediaTimestamp: 960,
      payloadBase64: Buffer.from([0xf8, 0xff, 0xfe]).toString("base64"),
      receivedAtMs: 1_000,
      recordingId: "recording-1",
      relativeTimeMs: 0,
      schemaVersion: 1,
      sequenceNumber: 1,
      source: meetingEnded.source,
      speakerId: "1533227577286852649",
    },
  ],
  schemaVersion: 1,
};

const logger: Logger = {
  child: () => logger,
  debug: vi.fn(),
  error: vi.fn(),
  flush: vi.fn(async () => {}),
  info: vi.fn(),
  warn: vi.fn(),
};

const metrics: IngressMetrics = {
  recordDerivedLiveFailure: vi.fn(),
  recordIngress: vi.fn(),
};

const failureClassifier = { classify: () => null } as const;
const defaultPublicationTargets = {
  resolve: async () => "1533228891827736657",
} as const;

describe("Platform recording ingress", () => {
  it("atomically records and schedules a finalized recording before dispatch", async () => {
    const order: string[] = [];
    const saved: MeetingSnapshot[] = [];
    const recordAndSchedule = vi.fn(async (snapshot: MeetingSnapshot) => {
      order.push("record-and-schedule");
      saved.push(snapshot);
    });
    const dispatchPending = vi.fn(async () => {
      order.push("dispatch");
      return { dispatched: 1, failed: 0 };
    });
    const lifecycleResult: RecordingLifecycleIngressResult = {
      actors: null,
      kind: "finalized",
      recording: {
        manifestLocator: "s3://meeting/recordings/recording-1/manifest.json",
        recordingId: "recording-1",
        speakerAudio: [
          {
            audioLocator: "s3://meeting/recordings/recording-1/speaker.ogg",
            speakerId: "1533227577286852649",
            timelineOffsetMs: 0,
          },
        ],
      },
      replayed: false,
      source: meetingEnded.source,
    };
    const ingress = new PlatformRecordingIngress({
      dispatcher: { dispatchPending },
      failureClassifier,
      ingress: {
        ingestAuthoritativeTrack: async () => ({ replayed: false }),
        ingestLifecycleEvent: async (): Promise<RecordingLifecycleIngressResult> =>
          lifecycleResult,
        ingestPacketBatch: async () => ({
          acceptedPackets: 1,
          duplicatePackets: 0,
          recordingId: "recording-1",
        }),
      },
      live: {
        acceptLifecycle: () => {
          order.push("live-lifecycle");
        },
        acceptVoiceBatch: () => {},
        prepareForAuthoritativeFinal: () => {
          order.push("live-prepared");
        },
      },
      logger,
      metrics,
      outbox: { recordAndSchedule },
      publicationTargets: defaultPublicationTargets,
    });

    await ingress.ingestLifecycle(meetingEnded);

    expect(order).toEqual([
      "live-lifecycle",
      "live-prepared",
      "record-and-schedule",
      "dispatch",
    ]);
    expect(saved[0]).toMatchObject({
      actors: null,
      meetingId: "recording-1",
      publicationTargetId: "1533228891827736657",
      revision: 0,
      source: meetingEnded.source,
    });
    expect(recordAndSchedule).toHaveBeenCalledWith(saved[0], 0);
    expect(dispatchPending).toHaveBeenCalledOnce();
  });

  it("does not enqueue non-final lifecycle events", async () => {
    const recordAndSchedule = vi.fn(async () => {});
    const dispatchPending = vi.fn(async () => ({ dispatched: 0, failed: 0 }));
    const ingress = new PlatformRecordingIngress({
      dispatcher: { dispatchPending },
      failureClassifier,
      ingress: {
        ingestAuthoritativeTrack: async () => ({ replayed: false }),
        ingestLifecycleEvent: async (): Promise<RecordingLifecycleIngressResult> => ({
          kind: "accepted",
          recordingId: "recording-1",
          replayed: false,
        }),
        ingestPacketBatch: async () => ({
          acceptedPackets: 1,
          duplicatePackets: 0,
          recordingId: "recording-1",
        }),
      },
      logger,
      metrics,
      outbox: { recordAndSchedule },
      publicationTargets: defaultPublicationTargets,
    });

    await ingress.ingestLifecycle({ ...meetingEnded, type: "meeting.aborted" });

    expect(recordAndSchedule).not.toHaveBeenCalled();
    expect(dispatchPending).not.toHaveBeenCalled();
  });

  it("resolves the final target from the normalized recording source", async () => {
    const saved: MeetingSnapshot[] = [];
    const resolve = vi.fn(async () => "77777777777777777");
    const ingress = new PlatformRecordingIngress({
      dispatcher: {
        dispatchPending: async () => ({ dispatched: 1, failed: 0 }),
      },
      failureClassifier,
      ingress: {
        ingestAuthoritativeTrack: async () => ({ replayed: false }),
        ingestLifecycleEvent: async () => ({
          actors: null,
          kind: "finalized" as const,
          recording: {
            manifestLocator:
              "s3://meeting/recordings/recording-1/manifest.json",
            recordingId: "recording-1",
            speakerAudio: [
              {
                audioLocator: "s3://meeting/recordings/recording-1/speaker.ogg",
                speakerId: "1533227577286852649",
                timelineOffsetMs: 0,
              },
            ],
          },
          replayed: false,
          source: meetingEnded.source,
        }),
        ingestPacketBatch: async () => ({
          acceptedPackets: 0,
          duplicatePackets: 0,
          recordingId: "recording-1",
        }),
      },
      logger,
      metrics,
      outbox: {
        recordAndSchedule: async (snapshot) => void saved.push(snapshot),
      },
      publicationTargets: { resolve },
    });

    await ingress.ingestLifecycle(meetingEnded);

    expect(resolve).toHaveBeenCalledWith(meetingEnded.source);
    expect(saved[0]?.publicationTargetId).toBe("77777777777777777");
  });

  it("defers publication lookup and preserves participant identity at the live boundary", async () => {
    const resolve = vi.fn(async () => "77777777777777777");
    const acceptLifecycle = vi.fn(async (event: DerivedLiveLifecycleEvent) => {
      if (event.type === "meeting.started") {
        expect(resolve).not.toHaveBeenCalled();
        expect(event.participantIds).toEqual(["1533227577286852649"]);
        await expect(event.publicationTarget.resolve()).resolves.toBe(
          "77777777777777777",
        );
      } else if (event.type === "participant.joined") {
        expect(event.participantId).toBe("1533228054724346087");
      }
    });
    const started: RecordingLifecycleCommand = {
      eventId: "recording-1:start",
      occurredAt: "2026-08-02T00:00:00.000Z",
      participantIds: ["1533227577286852649"],
      recordingId: "recording-1",
      schemaVersion: 1,
      source: meetingEnded.source,
      type: "meeting.started",
    };
    const ingress = new PlatformRecordingIngress({
      dispatcher: {
        dispatchPending: async () => ({ dispatched: 0, failed: 0 }),
      },
      failureClassifier,
      ingress: {
        ingestAuthoritativeTrack: async () => ({ replayed: false }),
        ingestLifecycleEvent: async () => ({
          kind: "accepted" as const,
          recordingId: "recording-1",
          replayed: false,
        }),
        ingestPacketBatch: async () => ({
          acceptedPackets: 0,
          duplicatePackets: 0,
          recordingId: "recording-1",
        }),
      },
      live: {
        acceptLifecycle,
        acceptVoiceBatch: () => {},
        prepareForAuthoritativeFinal: () => {},
      },
      logger,
      metrics,
      outbox: { recordAndSchedule: async () => {} },
      publicationTargets: { resolve },
    });

    await ingress.ingestLifecycle(started);
    await ingress.ingestLifecycle({
      ...started,
      eventId: "recording-1:join:2",
      participantId: "1533228054724346087",
      type: "participant.joined",
    });

    expect(resolve).toHaveBeenCalledWith(started.source);
    expect(acceptLifecycle).toHaveBeenCalledTimes(2);
    expect(acceptLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      occurredAt: started.occurredAt,
      recordingId: started.recordingId,
      type: "meeting.started",
    }));
  });
});

describe("Platform recording ingress failure isolation", () => {
  it("retains finalized ingress but refuses publication when the source is unconfigured", async () => {
    const recordAndSchedule = vi.fn(async () => {});
    const ingress = new PlatformRecordingIngress({
      dispatcher: {
        dispatchPending: async () => ({ dispatched: 0, failed: 0 }),
      },
      failureClassifier,
      ingress: {
        ingestAuthoritativeTrack: async () => ({ replayed: false }),
        ingestLifecycleEvent: async () => ({
          actors: null,
          kind: "finalized" as const,
          recording: {
            manifestLocator:
              "s3://meeting/recordings/recording-1/manifest.json",
            recordingId: "recording-1",
            speakerAudio: [
              {
                audioLocator: "s3://meeting/recordings/recording-1/speaker.ogg",
                speakerId: "1533227577286852649",
                timelineOffsetMs: 0,
              },
            ],
          },
          replayed: true,
          source: meetingEnded.source,
        }),
        ingestPacketBatch: async () => ({
          acceptedPackets: 0,
          duplicatePackets: 0,
          recordingId: "recording-1",
        }),
      },
      logger,
      metrics,
      outbox: { recordAndSchedule },
      publicationTargets: { resolve: async () => null },
    });

    await expect(ingress.ingestLifecycle(meetingEnded)).rejects.toBeInstanceOf(
      MeetingPublicationTargetUnavailableError,
    );
    expect(recordAndSchedule).not.toHaveBeenCalled();
  });

  it("tees voice packets to live processing only after durable ingress succeeds", async () => {
    const order: string[] = [];
    const acceptVoiceBatch = vi.fn(() => {
      order.push("live");
    });
    const ingress = new PlatformRecordingIngress({
      dispatcher: {
        dispatchPending: async () => ({ dispatched: 0, failed: 0 }),
      },
      failureClassifier,
      ingress: {
        ingestAuthoritativeTrack: async () => ({ replayed: false }),
        ingestLifecycleEvent: async () => ({
          kind: "accepted" as const,
          recordingId: "recording-1",
          replayed: false,
        }),
        ingestPacketBatch: async () => {
          order.push("durable");
          return {
            acceptedPackets: 1,
            duplicatePackets: 0,
            recordingId: "recording-1",
          };
        },
      },
      live: {
        acceptLifecycle: () => {},
        acceptVoiceBatch,
        prepareForAuthoritativeFinal: () => {},
      },
      logger,
      metrics,
      outbox: { recordAndSchedule: async () => {} },
      publicationTargets: defaultPublicationTargets,
    });
    await ingress.ingestVoiceBatch(voiceBatch);

    expect(order).toEqual(["durable", "live"]);
    expect(acceptVoiceBatch).toHaveBeenCalledWith({
      format: canonicalLiveAudioFormat,
      packets: [
        {
          mediaTimestamp: 960,
          payloadBase64: voiceBatch.packets[0]?.payloadBase64,
          receivedAtMs: 1_000,
          recordingId: "recording-1",
          relativeTimeMs: 0,
          sequenceNumber: 1,
          speakerId: "1533227577286852649",
        },
      ],
    });
  });

  it("waits for bounded live admission only after the durable packet write", async () => {
    const order: string[] = [];
    let releaseLiveAdmission!: () => void;
    const liveAdmission = new Promise<void>((resolve) => {
      releaseLiveAdmission = resolve;
    });
    const ingress = new PlatformRecordingIngress({
      dispatcher: {
        dispatchPending: async () => ({ dispatched: 0, failed: 0 }),
      },
      failureClassifier,
      ingress: {
        ingestAuthoritativeTrack: async () => ({ replayed: false }),
        ingestLifecycleEvent: async () => ({
          kind: "accepted" as const,
          recordingId: "recording-1",
          replayed: false,
        }),
        ingestPacketBatch: async () => {
          order.push("durable");
          return {
            acceptedPackets: 1,
            duplicatePackets: 0,
            recordingId: "recording-1",
          };
        },
      },
      live: {
        acceptLifecycle: () => {},
        acceptVoiceBatch: async () => {
          order.push("live");
          await liveAdmission;
        },
        prepareForAuthoritativeFinal: () => {},
      },
      logger,
      metrics,
      outbox: { recordAndSchedule: async () => {} },
      publicationTargets: defaultPublicationTargets,
    });
    let settled = false;
    const accepted = ingress.ingestVoiceBatch(voiceBatch).then(() => {
      settled = true;
      return null;
    });
    await vi.waitFor(() => {
      expect(order).toEqual(["durable", "live"]);
    });
    expect(settled).toBe(false);

    releaseLiveAdmission();
    await accepted;
    expect(settled).toBe(true);
  });
});

describe("Platform derived ingress failure isolation", () => {
  it("keeps a durable packet accepted when derived live admission faults", async () => {
    const ingestPacketBatch = vi.fn(
      async () => ({
        acceptedPackets: 1,
        duplicatePackets: 0,
        recordingId: "recording-1",
      }),
    );
    const ingress = new PlatformRecordingIngress({
      dispatcher: {
        dispatchPending: async () => ({ dispatched: 0, failed: 0 }),
      },
      failureClassifier,
      ingress: {
        ingestAuthoritativeTrack: async () => ({ replayed: false }),
        ingestLifecycleEvent: async () => ({
          kind: "accepted" as const,
          recordingId: "recording-1",
          replayed: false,
        }),
        ingestPacketBatch,
      },
      live: {
        acceptLifecycle: () => {},
        acceptVoiceBatch: async () => {
          throw new Error("derived live unavailable");
        },
        prepareForAuthoritativeFinal: () => {},
      },
      logger,
      metrics,
      outbox: { recordAndSchedule: async () => {} },
      publicationTargets: defaultPublicationTargets,
    });
    await expect(ingress.ingestVoiceBatch(voiceBatch)).resolves.toBeUndefined();
    expect(ingestPacketBatch).toHaveBeenCalledWith(voiceBatch);
  });

  it("translates concrete durable failures into the application-owned model", async () => {
    const durableFailure = new Error("private spool state");
    const acceptLifecycle = vi.fn();
    const ingress = new PlatformRecordingIngress({
      dispatcher: {
        dispatchPending: async () => ({ dispatched: 0, failed: 0 }),
      },
      failureClassifier: {
        classify: (error) => error === durableFailure ? "conflict" : null,
      },
      ingress: {
        ingestAuthoritativeTrack: async () => ({ replayed: false }),
        ingestLifecycleEvent: async () => {
          throw durableFailure;
        },
        ingestPacketBatch: async () => ({
          acceptedPackets: 0,
          duplicatePackets: 0,
          recordingId: "recording-1",
        }),
      },
      live: {
        acceptLifecycle,
        acceptVoiceBatch: () => {},
        prepareForAuthoritativeFinal: () => {},
      },
      logger,
      metrics,
      outbox: { recordAndSchedule: async () => {} },
      publicationTargets: defaultPublicationTargets,
    });

    await expect(ingress.ingestLifecycle(meetingEnded)).rejects.toMatchObject({
      cause: durableFailure,
      rejection: "conflict",
    } satisfies Partial<RecordingIngressRejectedError>);
    expect(acceptLifecycle).not.toHaveBeenCalled();
  });

  it("keeps a durable lifecycle accepted when derived lifecycle and final fences fault", async () => {
    const recordAndSchedule = vi.fn(async () => {});
    const recordDerivedLiveFailure = vi.fn();
    const ingress = new PlatformRecordingIngress({
      dispatcher: {
        dispatchPending: async () => ({ dispatched: 1, failed: 0 }),
      },
      failureClassifier,
      ingress: {
        ingestAuthoritativeTrack: async () => ({ replayed: false }),
        ingestLifecycleEvent: async () => ({
          actors: null,
          kind: "finalized" as const,
          recording: {
            manifestLocator: "s3://meeting/recordings/recording-1/manifest.json",
            recordingId: "recording-1",
            speakerAudio: [],
          },
          replayed: false,
          source: meetingEnded.source,
        }),
        ingestPacketBatch: async () => ({
          acceptedPackets: 0,
          duplicatePackets: 0,
          recordingId: "recording-1",
        }),
      },
      live: {
        acceptLifecycle: async () => {
          throw new Error("derived lifecycle unavailable");
        },
        acceptVoiceBatch: () => {},
        prepareForAuthoritativeFinal: async () => {
          throw new Error("derived final fence unavailable");
        },
      },
      logger,
      metrics: { recordDerivedLiveFailure, recordIngress: vi.fn() },
      outbox: { recordAndSchedule },
      publicationTargets: defaultPublicationTargets,
    });

    await expect(ingress.ingestLifecycle(meetingEnded)).resolves.toBeUndefined();
    expect(recordAndSchedule).toHaveBeenCalledOnce();
    expect(recordDerivedLiveFailure.mock.calls).toEqual([
      ["lifecycle"],
      ["prepare-final"],
    ]);
  });
});
