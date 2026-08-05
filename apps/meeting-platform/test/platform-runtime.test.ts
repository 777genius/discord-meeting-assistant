import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { S3Client } from "@aws-sdk/client-s3";
import type { PostCallWorker } from "@discord-meeting/bullmq-adapter";
import type {
  ConversationAudioChunk,
  ConversationRuntime,
  ConversationRuntimeEvent,
  ConversationRuntimeTurn,
  ConversationStartRequest,
  PortResult,
  VoicePlaybackEvent,
  VoicePlaybackPort,
  VoicePlaybackRequest,
  VoicePlaybackSession,
} from "@discord-meeting/meeting-core";
import type { Logger } from "@discord-meeting/observability-adapter";
import type { Client } from "discord.js";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlatformLiveMeetingRuntime } from "../src/live-meeting-runtime.js";
import type { PlatformHttpHost } from "../src/http/platform-http-host.js";
import {
  closeMeetingPlatformResources,
  createConversationCoordinator,
  createVoicetextBatchFinalTranscriptionOptions,
} from "../src/platform-runtime.js";
import type { GrpcSubscriptionRuntimeTransport } from "../src/adapters/outbound/subscription-runtime-grpc-transport.js";

const temporaryCueRoots: string[] = [];

class PendingConversationRuntime implements ConversationRuntime {
  private closeEvents: (() => void) | undefined;

  public startTurn(
    _request: ConversationStartRequest,
  ): Promise<PortResult<ConversationRuntimeTurn>> {
    const eventsClosed = new Promise<void>((resolve) => {
      this.closeEvents = resolve;
    });
    return Promise.resolve({
      ok: true,
      value: {
        cancel: async () => {
          this.closeEvents?.();
        },
        events: this.events(eventsClosed),
      },
    });
  }

  private async *events(
    closed: Promise<void>,
  ): AsyncGenerator<ConversationRuntimeEvent> {
    yield { attemptId: "runtime-attempt", type: "accepted" };
    await closed;
  }
}

class RecordingCuePlayback implements VoicePlaybackPort {
  public readonly chunks: ConversationAudioChunk[] = [];
  public readonly requests: VoicePlaybackRequest[] = [];

  public async open(
    request: VoicePlaybackRequest,
  ): Promise<PortResult<VoicePlaybackSession>> {
    this.requests.push(structuredClone(request));
    let resolveTerminal!: (event: VoicePlaybackEvent) => void;
    const terminal = new Promise<VoicePlaybackEvent>((resolve) => {
      resolveTerminal = resolve;
    });
    let terminalSent = false;
    const finishTerminal = () => {
      if (!terminalSent) {
        terminalSent = true;
        resolveTerminal({
          attemptId: request.attemptId,
          finishedAtMs: 1_300,
          type: "finished",
        });
      }
    };
    return {
      ok: true,
      value: {
        cancel: async () => {
          finishTerminal();
          return { ok: true, value: "cancelled" };
        },
        events: onePlaybackEvent(terminal),
        finish: async () => {
          finishTerminal();
          return { ok: true, value: "finished" };
        },
        write: async (chunk) => {
          this.chunks.push({ ...chunk, bytes: chunk.bytes.slice() });
          return { ok: true, value: "accepted" };
        },
      },
    };
  }
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryCueRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

async function thinkingCueRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meeting-platform-runtime-cues-"));
  temporaryCueRoots.push(root);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      audio: { channels: 1, format: "pcm_s16le", sampleRateHz: 48_000 },
      groups: {
        enAcknowledgement: [{ cueId: "en-ack", pcmFile: "en-ack.pcm" }],
        enDeliberation: [{ cueId: "en-think", pcmFile: "en-think.pcm" }],
        neutralAcknowledgement: [{ cueId: "neutral-ack", pcmFile: "neutral-ack.pcm" }],
        ruAcknowledgement: [{ cueId: "ru-ack", pcmFile: "ru-ack.pcm" }],
        ruDeliberation: [{ cueId: "ru-think", pcmFile: "ru-think.pcm" }],
      },
      version: 2,
      voiceId: "test-voice-id",
      voiceProfileId: "test-voice",
    }),
  );
  const pcm = Uint8Array.from({ length: 3_840 }, (_, index) => index % 256);
  await Promise.all(
    ["en-ack.pcm", "en-think.pcm", "neutral-ack.pcm", "ru-ack.pcm", "ru-think.pcm"].map((name) =>
      writeFile(join(root, name), pcm),
    ),
  );
  return root;
}

async function* onePlaybackEvent(
  event: Promise<VoicePlaybackEvent>,
): AsyncGenerator<VoicePlaybackEvent> {
  yield await event;
}

describe("meeting platform runtime wiring", () => {
  it("passes configured per-meeting batch concurrency into the Voicetext composition", () => {
    expect(
      createVoicetextBatchFinalTranscriptionOptions({
        batchMaxArtifactBytes: 64 * 1_024 * 1_024,
        batchMaxConcurrency: 6,
        batchMaxConcurrentMeetings: 1,
        liveMaxConcurrentSessions: 10,
        livePacketBackpressureTimeoutMs: 2_000,
        webSocketUrl: "wss://api.voicetext.site/api/v1/transcribe/stream",
      }),
    ).toMatchObject({
      maxArtifactBytesPerSpeaker: 64 * 1_024 * 1_024,
      maxConcurrency: 6,
      maxSpeakerTracks: 11,
      maxTotalArtifactBytes: 704 * 1_024 * 1_024,
    });
  });

  it("preloads local thinking cues and wires them through the system delay", async () => {
    vi.useFakeTimers();
    const runtime = new PendingConversationRuntime();
    const playback = new RecordingCuePlayback();
    const coordinator = await createConversationCoordinator({
      config: {
        conversation: {
          runtimeAddress: "pipecat-runtime:50053",
          systemPrompt: "Answer briefly.",
          thinkingCueRoot: await thinkingCueRoot(),
          voiceId: "test-voice-id",
          voiceProfileId: "test-voice",
        },
      },
      playback,
      runtime,
    });
    if (coordinator === undefined) {
      throw new Error("conversation coordinator was not composed");
    }

    await coordinator.handleFinalizedTurn({
      locale: "ru-RU",
      meetingId: "meeting-1",
      nowMs: 0,
      recordingId: "recording-1",
      speakerId: "speaker-1",
      systemPrompt: "Answer briefly.",
      text: "Ботик, ответь кратко.",
      thinkingCueLocale: "ru-RU",
      transcriptEndMs: 1_000,
      transcriptStartMs: 0,
      turnId: "turn-1",
      voiceProfileId: "test-voice",
    });
    await vi.advanceTimersByTimeAsync(1_300);

    await vi.waitFor(() => {
      expect(playback.requests).toHaveLength(1);
      expect(playback.chunks).toHaveLength(1);
    });
    expect(playback.requests[0]?.attemptId).toMatch(/^thinking-cue-v2-[0-9a-f]{64}$/u);
    expect(playback.chunks[0]?.bytes).toHaveLength(3_840);

    await coordinator.closeMeeting("meeting-1", 1_300);
    await coordinator.whenIdle("meeting-1");
  });

});

describe("meeting platform shutdown", () => {
  it("starts BullMQ admission closure before slow HTTP and live drains", async () => {
    const calls: string[] = [];
    let resumePause!: () => void;
    const pause = new Promise<void>((resolve) => {
      resumePause = resolve;
    });
    const worker = {
      cancelActivePostCallJobs: () => {
        calls.push("worker:cancel");
      },
      close: async (force?: boolean) => {
        calls.push(`worker:close:${String(force)}`);
      },
      pause: () => {
        calls.push("worker:pause");
        return pause;
      },
      waitForActivePostCallJobs: async () => {
        calls.push("worker:wait");
      },
    } as unknown as PostCallWorker;
    const server = {
      close: async () => {
        calls.push("server:close");
      },
      start: async () => {},
    } satisfies PlatformHttpHost;
    const live = {
      close: async () => {
        calls.push("live:close");
      },
    } as unknown as PlatformLiveMeetingRuntime;
    const logger = {
      flush: async () => {
        calls.push("logger:flush");
      },
    } as unknown as Logger;

    const closing = closeMeetingPlatformResources({
      deadLetterQueue: {
        close: async () => {
          calls.push("dead-letter:close");
        },
      },
      discord: {
        destroy: () => {
          calls.push("discord:destroy");
        },
      } as unknown as Client,
      live,
      logger,
      pool: {
        end: async () => {
          calls.push("pool:end");
        },
      } as unknown as Pool,
      recordings: {
        close: async () => {
          calls.push("recordings:close");
        },
      },
      outboxDispatcher: {
        whenIdle: async () => {
          calls.push("outbox:idle");
        },
      },
      queue: {
        close: async () => {
          calls.push("queue:close");
        },
      },
      queueEvents: {
        close: async () => {
          calls.push("events:close");
        },
      },
      runtimeTransport: {
        close: () => {
          calls.push("runtime:close");
        },
      } as unknown as GrpcSubscriptionRuntimeTransport,
      s3: {
        destroy: () => {
          calls.push("s3:destroy");
        },
      } as unknown as S3Client,
      server,
      worker,
    });

    await vi.waitFor(() => {
      expect(calls).toEqual([
        "worker:pause",
        "worker:cancel",
        "outbox:idle",
        "server:close",
      ]);
    });
    expect(calls).not.toContain("live:close");
    expect(calls).not.toContain("recordings:close");
    resumePause();
    await closing;

    expect(calls.indexOf("worker:cancel")).toBeLessThan(
      calls.indexOf("server:close"),
    );
    expect(calls.indexOf("worker:cancel")).toBeLessThan(
      calls.indexOf("live:close"),
    );
    expect(calls.indexOf("worker:close:true")).toBeLessThan(
      calls.indexOf("live:close"),
    );
    expect(calls.indexOf("server:close")).toBeLessThan(
      calls.indexOf("recordings:close"),
    );
    expect(calls.indexOf("worker:close:true")).toBeLessThan(
      calls.indexOf("queue:close"),
    );
  });

  it("bounds shutdown when an in-flight outbox reconciliation never settles", async () => {
    const calls: string[] = [];
    const never = new Promise<void>(() => {});
    const startedAt = performance.now();

    await expect(closeMeetingPlatformResources({
      deadLetterQueue: { close: async () => { calls.push("dead-letter:close"); } },
      discord: { destroy: () => { calls.push("discord:destroy"); } } as unknown as Client,
      logger: { flush: async () => { calls.push("logger:flush"); } } as unknown as Logger,
      outboxDispatcher: { whenIdle: async () => never },
      pool: { end: async () => { calls.push("pool:end"); } } as unknown as Pool,
      queue: { close: async () => { calls.push("queue:close"); } },
      queueEvents: { close: async () => { calls.push("events:close"); } },
      recordings: { close: async () => { calls.push("recordings:close"); } },
      runtimeTransport: { close: () => { calls.push("runtime:close"); } } as unknown as GrpcSubscriptionRuntimeTransport,
      s3: { destroy: () => { calls.push("s3:destroy"); } } as unknown as S3Client,
      server: { close: async () => { calls.push("server:close"); }, start: async () => {} },
      shutdownTimeoutMilliseconds: 25,
      worker: {
        cancelActivePostCallJobs: () => { calls.push("worker:cancel"); },
        close: async () => { calls.push("worker:close"); },
        pause: async () => { calls.push("worker:pause"); },
        waitForActivePostCallJobs: async () => { calls.push("worker:wait"); },
      } as unknown as PostCallWorker,
    })).rejects.toBeInstanceOf(AggregateError);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(calls).toEqual(expect.arrayContaining([
      "discord:destroy",
      "pool:end",
      "recordings:close",
      "runtime:close",
      "server:close",
      "worker:cancel",
    ]));
  });

  it("observes an immediate post-call rejection while HTTP shutdown is pending", async () => {
    let releaseServer!: () => void;
    const serverGate = new Promise<void>((resolve) => {
      releaseServer = resolve;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const closing = closeMeetingPlatformResources({
        deadLetterQueue: { close: async () => {} },
        discord: { destroy: () => {} } as unknown as Client,
        logger: { flush: async () => {} } as unknown as Logger,
        outboxDispatcher: { whenIdle: async () => {} },
        pool: { end: async () => {} } as unknown as Pool,
        queue: { close: async () => {} },
        queueEvents: { close: async () => {} },
        recordings: { close: async () => {} },
        runtimeTransport: { close: () => {} } as unknown as GrpcSubscriptionRuntimeTransport,
        s3: { destroy: () => {} } as unknown as S3Client,
        server: { close: async () => serverGate, start: async () => {} },
        worker: {
          cancelActivePostCallJobs: () => {},
          close: async () => {},
          pause: async () => {
            throw new Error("immediate worker shutdown failure");
          },
          waitForActivePostCallJobs: async () => {},
        } as unknown as PostCallWorker,
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toEqual([]);

      releaseServer();
      await expect(closing).rejects.toBeInstanceOf(AggregateError);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
