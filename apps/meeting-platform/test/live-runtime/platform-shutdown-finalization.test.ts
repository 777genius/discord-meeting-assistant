import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import type { S3Client } from "@aws-sdk/client-s3";
import type { PostCallWorker } from "@discord-meeting/bullmq-adapter";
import type { Client } from "discord.js";
import type { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { closeMeetingPlatformResources } from "../../src/composition/platform-shutdown.js";
import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import type { LiveTranscriptionEvent } from "../../src/live-runtime/contracts.js";
import { logger, MemoryLiveMeetingRepository, packets, ProjectionStub, started, SummaryStub } from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());

it.each(["healthy", "timeout", "pending write", "pending receipt"] as const)(
  "coordinates admitted packet drain, provider finalize and pool ownership: %s", async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-02T10:00:10.000Z");
    const meetings = new MemoryLiveMeetingRepository();
    const projector = new ProjectionStub();
    let poolClosed = false;
    const writes: number[] = [];
    const save = meetings.save.bind(meetings);
    let heldWrite = false;
    let releaseWrite!: () => void;
    vi.spyOn(meetings, "save").mockImplementation(async (...args) => {
      if (mode === "pending write" && !heldWrite && args[0].status === "ended") {
        heldWrite = true;
        await new Promise<void>((resolve) => { releaseWrite = resolve; });
      }
      expect(poolClosed).toBe(false);
      writes.push(performance.now());
      await save(...args);
    });
    let transcript!: (event: LiveTranscriptionEvent) => void;
    const terminate = vi.fn();
    const sendPacket = vi.fn(async () => "accepted" as const);
    const finalize = vi.fn(async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 20_000); });
      // Deliberately ignore terminate to prove the local callback fence.
      transcript({ meetingId: "recording-live-1", speakerId: "speaker-1", startMs: 0, endMs: 4_000, text: "final evidence", isFinal: true });
    });
    const live = new PlatformLiveMeetingRuntime({
      appendTurn: new AppendLiveTranscriptTurn(meetings), finishMeeting: new FinishLiveMeeting(meetings), logger,
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer: new SummaryStub() }),
      startMeeting: new StartLiveMeeting({ meetings }),
      markLivePacketDelivered: async () => {
        if (mode === "pending receipt") {
          await new Promise<void>((resolve) => { releaseWrite = resolve; });
          expect(poolClosed).toBe(false);
          writes.push(performance.now());
        }
      },
      packetInspector: { durationSamples48Khz: () => 960 },
      transcriber: { openSession: async (request) => {
        transcript = request.onTranscript;
        return { sendPacket, finalize, terminate };
      } },
    });
    await live.acceptLifecycle(started());
    const batch = packets();
    await live.acceptVoiceBatch({ ...batch, packets: Array.from({ length: 201 }, (_, index) => ({
      ...batch.packets[0]!, relativeTimeMs: index * 20, sequenceNumber: index, mediaTimestamp: index * 960,
    })) });
    const end = vi.fn(async () => { poolClosed = true; });
    const abort = vi.fn();
    const closing = closeMeetingPlatformResources({
      live, logger, ossNativeEvidence: { close: async () => {}, abort },
      discord: { destroy: () => {} } as unknown as Client,
      outboxDispatcher: { whenIdle: async () => {} }, pool: { end } as unknown as Pool,
      queue: { close: async () => {} }, queueEvents: { close: async () => {} },
      recordings: { close: async () => {} }, s3: { destroy: () => {} } as unknown as S3Client,
      server: { close: async () => {}, start: async () => {} },
      ...(mode === "timeout" ? { shutdownTimeoutMilliseconds: 15_000 } : {}),
      worker: { cancelActivePostCallJobs: () => {}, close: async () => {}, pause: async () => {}, waitForActivePostCallJobs: async () => {} } as unknown as PostCallWorker,
    });
    const outcome = closing.then(() => "closed", () => "failed");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sendPacket).toHaveBeenCalledTimes(mode === "pending receipt" ? 1 : 201);
    expect(finalize).toHaveBeenCalledTimes(mode === "pending receipt" ? 0 : 1);
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(end).not.toHaveBeenCalled();
    if (mode === "timeout") { expect(terminate).toHaveBeenCalledTimes(1); }
    await vi.advanceTimersByTimeAsync(9_000);
    if (mode === "healthy") {
      expect(await outcome).toBe("closed");
      expect(end).toHaveBeenCalledTimes(1);
      expect(meetings.snapshot?.status).toBe("ended");
      expect(projector.requests.at(-1)?.status).toBe("ended");
      expect(meetings.finalizedTurns).toHaveLength(1);
    } else {
      await vi.advanceTimersByTimeAsync(36_000);
      expect(await outcome).toBe("failed");
      expect(end).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledOnce();
      if (mode === "pending write") { releaseWrite(); await live.close(); }
      if (mode === "pending receipt") { releaseWrite(); await vi.advanceTimersByTimeAsync(0); }
      if (mode === "timeout") { expect(meetings.finalizedTurns).toHaveLength(0); }
    }
    const writeCount = writes.length;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(writes).toHaveLength(writeCount);
    expect(finalize).toHaveBeenCalledTimes(mode === "pending receipt" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  },
);
