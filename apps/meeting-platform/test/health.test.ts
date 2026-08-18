import { HealthAggregator } from "@discord-meeting/observability-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPostCallDurabilityHealthProbe,
  createTranscriptionHealthProbe,
} from "../src/composition/health.js";
import type { PlatformConfig } from "../src/config.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("post-call durability health", () => {
  it("reports a retained dead-letter replica failure as degraded, not ready failure", async () => {
    const durabilityFailure = new AggregateError(
      [new Error("Redis DLQ replica failed")],
      "Post-call terminal durability effects failed",
    );
    const health = new HealthAggregator([
      createPostCallDurabilityHealthProbe({
        assertPostCallDurability: () => {
          throw durabilityFailure;
        },
      }),
    ]);

    await expect(health.snapshot()).resolves.toMatchObject({
      dependencies: [
        {
          code: "CHECK_FAILED",
          critical: false,
          name: "post-call-durability",
          status: "unhealthy",
        },
      ],
      ready: true,
      status: "degraded",
    });
  });
});

describe("Voicetext health", () => {
  it("requires the exact configured live and batch profiles to be ready", async () => {
    const health = new HealthAggregator([
      createTranscriptionHealthProbe(voicetextConfig()),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "ok",
      provider_profiles: [
        { mode: "live", provider: "deepgram", ready: true },
        { mode: "live", provider: "elevenlabs", ready: false },
        { mode: "batch", provider: "deepgram", ready: true },
        { mode: "batch", provider: "elevenlabs", ready: true },
      ],
    }), { status: 200 })));

    await expect(health.snapshot()).resolves.toMatchObject({
      dependencies: [{ name: "stt", status: "unhealthy" }],
      ready: false,
      status: "unhealthy",
    });
  });

  it("accepts health only when both selected profile entries are uniquely ready", async () => {
    const health = new HealthAggregator([
      createTranscriptionHealthProbe(voicetextConfig()),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "ok",
      provider_profiles: [
        { mode: "live", provider: "deepgram", ready: true },
        { mode: "live", provider: "elevenlabs", ready: true },
        { mode: "batch", provider: "deepgram", ready: true },
        { mode: "batch", provider: "elevenlabs", ready: true },
      ],
    }), { status: 200 })));

    await expect(health.snapshot()).resolves.toMatchObject({
      dependencies: [{ name: "stt", status: "healthy" }],
      ready: true,
      status: "healthy",
    });
  });
});

function voicetextConfig(): PlatformConfig {
  return {
    transcriptionProvider: "voicetext",
    voicetext: {
      batchMaxArtifactBytes: 1,
      batchMaxConcurrency: 1,
      batchMaxConcurrentMeetings: 1,
      batchProfile: "elevenlabs-scribe-v2",
      liveMaxConcurrentSessions: 1,
      livePacketBackpressureTimeoutMs: 1,
      liveProfile: "elevenlabs-scribe-v2-realtime",
      webSocketUrl: "wss://voicetext.test/api/v1/transcribe/stream",
    },
  } as PlatformConfig;
}
