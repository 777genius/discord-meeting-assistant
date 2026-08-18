import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { compileOggOpus } from "@discord-meeting/recording-ingress-adapter";
import type {
  VoicetextBatchClient,
  VoicetextBatchTaskResult,
  VoicetextLiveSession,
} from "@discord-meeting/voicetext-adapter";
import { describe, expect, it, vi } from "vitest";

import {
  parseVoicetextSemanticCanaryArguments,
  runVoicetextSemanticCanary,
  type VoicetextSemanticCanaryDependencies,
} from "../src/run-voicetext-semantic-canary.js";

const completed: Extract<VoicetextBatchTaskResult, { kind: "completed" }> = {
  jobId: "00000000-0000-4000-8000-000000000001",
  kind: "completed",
  result: {
    durationSeconds: 0.04,
    readableSegments: [{
      endSeconds: 0.04, sourceUtteranceIndices: [0], startSeconds: 0, transcript: "привет Botik",
    }],
    utterances: [{ endSeconds: 0.04, startSeconds: 0, transcript: "привет Botik" }],
  },
};

describe("Voicetext semantic canary", () => {
  it("proves same-key batch replay and live ready, ACK, and finalize without exposing the token", async () => {
    const fixture = canaryFixture();
    const fixtureSha256 = digest(fixture);
    const submits: Array<{ readonly idempotencyKey: string; readonly keyterms: readonly string[] }> = [];
    const polls: string[] = [];
    const batchResults: VoicetextBatchTaskResult[] = [
      { jobId: completed.jobId, kind: "pending", nextAction: "retry", retryAfterMs: 10 },
      completed,
      { jobId: completed.jobId, kind: "pending", nextAction: "poll", retryAfterMs: 10 },
      completed,
    ];
    const batch: VoicetextBatchClient = {
      poll: async ({ jobId }) => {polls.push(jobId); return nextBatchResult(batchResults);},
      submit: async ({ idempotencyKey, keyterms }) => {
        submits.push({ idempotencyKey, keyterms }); return nextBatchResult(batchResults);
      },
    };
    const sentPackets: Uint8Array[] = [];
    const waits: number[] = [];
    const finalize = vi.fn(async () => {});
    const live: VoicetextLiveSession = {
      finalize,
      sendPacket: async (packet) => {sentPackets.push(packet.opus); return "accepted";},
      terminate: vi.fn(),
    };
    const openLiveSession = vi.fn<VoicetextSemanticCanaryDependencies["openLiveSession"]>(
      async ({ onTranscript }) => {
        onTranscript({ endMs: 40, startMs: 0, text: "привет Botik" }, true);
        return live;
      },
    );
    const dependencies: VoicetextSemanticCanaryDependencies = {
      createBatchClient: ({ profile, token }) => {
        expect(profile).toBe("elevenlabs-scribe-v2");
        expect(token).toBe("secret-machine-bearer");
        return batch;
      },
      openLiveSession,
      readFixture: async () => fixture,
      readToken: async (path) => ({
        generationId: `file-${"f".repeat(64)}`, mode: 0o400, ownerUid: 10_001,
        path, token: "secret-machine-bearer",
      }),
      wait: async (delayMs) => {waits.push(delayMs);},
    };

    const result = await runVoicetextSemanticCanary({
      batchEndpoint: "https://voicetext.test/api/v1/transcribe/batch",
      campaignId: "campaign-1",
      deadlineMs: 20_000,
      fixturePath: "/fixtures/canary.ogg",
      fixtureSha256,
      imageDigestSha256: "b".repeat(64),
      keyterms: ["Meeting Platform", "Craig recording"],
      liveEndpoint: "wss://voicetext.test/api/v1/transcribe/stream",
      planSha256: "c".repeat(64),
      profiles: {
        batch: "elevenlabs-scribe-v2",
        live: "elevenlabs-scribe-v2-realtime",
      },
      sourceRevision: "d".repeat(40),
    }, "/run/secrets/voicetext-service-token", dependencies);

    expect(submits).toHaveLength(3);
    expect(new Set(submits.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(1);
    expect(submits.every(({ keyterms }) => keyterms.join("|") === "Meeting Platform|Craig recording")).toBe(true);
    expect(polls).toEqual([completed.jobId]);
    expect(result.batch.firstSubmission).toEqual(result.batch.idempotentReplay);
    expect(result.live.audioAcknowledgements).toEqual({ expected: 2, received: 2 });
    expect(sentPackets).toEqual([
      Uint8Array.from([0xf8, 0xff, 0xfe]),
      Uint8Array.from([0xf8, 0xff, 0xfd]),
    ]);
    expect(waits.slice(-2)).toEqual([20, 20]);
    expect(finalize).toHaveBeenCalledOnce();
    expect(openLiveSession).toHaveBeenCalledWith(expect.objectContaining({
      keyterms: ["Meeting Platform", "Craig recording"],
      profile: "elevenlabs-scribe-v2-realtime",
    }));
    expect(result.profiles).toEqual({
      batch: "elevenlabs-scribe-v2",
      live: "elevenlabs-scribe-v2-realtime",
    });
    expect(result.keyterms).toEqual(["Meeting Platform", "Craig recording"]);
    expect(JSON.stringify(result)).not.toContain("secret-machine-bearer");
  });

  it("rejects a substituted fixture before constructing provider clients", async () => {
    const fixture = canaryFixture();
    const createBatchClient = vi.fn();
    await expect(runVoicetextSemanticCanary({
      batchEndpoint: "https://voicetext.test/api/v1/transcribe/batch",
      campaignId: "campaign-1",
      deadlineMs: 20_000,
      fixturePath: "/fixtures/canary.ogg",
      fixtureSha256: "a".repeat(64),
      imageDigestSha256: "b".repeat(64),
      keyterms: ["Botik"],
      liveEndpoint: "wss://voicetext.test/api/v1/transcribe/stream",
      planSha256: "c".repeat(64),
      profiles: { batch: "deepgram-nova-3", live: "deepgram-nova-3" },
      sourceRevision: "d".repeat(40),
    }, "/run/secrets/token", {
      createBatchClient,
      openLiveSession: vi.fn(),
      readFixture: async () => fixture,
      readToken: async () => ({ generationId: "generation", mode: 0o400, ownerUid: 1,
        path: "/run/secrets/token", token: "secret-machine-bearer" }),
      wait: async () => {},
    })).rejects.toThrow("pinned digest");
    expect(createBatchClient).not.toHaveBeenCalled();
  });
});

describe("Voicetext semantic canary boundaries", () => {
  it("accepts only endpoints that exactly match the runtime configuration", () => {
    const argv = [
      "--fixture", "/fixtures/canary.ogg",
      "--fixture-sha256", "a".repeat(64),
      "--campaign", "campaign-1",
      "--deadline-ms", "19000",
      "--plan-sha256", "b".repeat(64),
      "--source-revision", "c".repeat(40),
      "--image-digest-sha256", "d".repeat(64),
      "--keyterms-json", JSON.stringify(["Meeting Platform", "Craig recording"]),
      "--batch-origin", "https://voicetext.test",
      "--batch-path", "/api/v1/transcribe/batch",
      "--batch-profile", "elevenlabs-scribe-v2",
      "--live-origin", "wss://voicetext.test",
      "--live-path", "/api/v1/transcribe/stream",
      "--live-profile", "elevenlabs-scribe-v2-realtime",
      "--json",
    ];
    expect(parseVoicetextSemanticCanaryArguments(argv, {
      VOICETEXT_BATCH_PROFILE: "elevenlabs-scribe-v2",
      VOICETEXT_LIVE_PROFILE: "elevenlabs-scribe-v2-realtime",
      VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext-service-token",
      VOICETEXT_WS_URL: "wss://voicetext.test/api/v1/transcribe/stream",
    }).args).toMatchObject({
      fixtureSha256: "a".repeat(64), keyterms: ["Meeting Platform", "Craig recording"],
    });
    expect(() => parseVoicetextSemanticCanaryArguments(argv, {
      VOICETEXT_BATCH_PROFILE: "elevenlabs-scribe-v2",
      VOICETEXT_LIVE_PROFILE: "elevenlabs-scribe-v2-realtime",
      VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext-service-token",
      VOICETEXT_WS_URL: "wss://other.test/api/v1/transcribe/stream",
    })).toThrow("do not match");
    expect(() => parseVoicetextSemanticCanaryArguments(
      argv.with(argv.indexOf("elevenlabs-scribe-v2"), "other"),
      {
        VOICETEXT_BATCH_PROFILE: "elevenlabs-scribe-v2",
        VOICETEXT_LIVE_PROFILE: "elevenlabs-scribe-v2-realtime",
        VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext-service-token",
        VOICETEXT_WS_URL: "wss://voicetext.test/api/v1/transcribe/stream",
      },
    )).toThrow("batch profile is invalid");
    expect(() => parseVoicetextSemanticCanaryArguments(
      argv.with(argv.indexOf(JSON.stringify(["Meeting Platform", "Craig recording"])), "[\" duplicated\",\" duplicated\"]"),
      {
        VOICETEXT_BATCH_PROFILE: "elevenlabs-scribe-v2",
        VOICETEXT_LIVE_PROFILE: "elevenlabs-scribe-v2-realtime",
        VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext-service-token",
        VOICETEXT_WS_URL: "wss://voicetext.test/api/v1/transcribe/stream",
      },
    )).toThrow("keyterms are invalid");
  });

  it("stops batch polling at one total deadline and performs no later provider activity", async () => {
    vi.useFakeTimers();
    try {
      const fixture = canaryFixture();
      const submit = vi.fn<VoicetextBatchClient["submit"]>(async () => ({
        jobId: completed.jobId, kind: "pending", nextAction: "poll", retryAfterMs: 10_000,
      }));
      const poll = vi.fn<VoicetextBatchClient["poll"]>(async () => completed);
      const wait = vi.fn<VoicetextSemanticCanaryDependencies["wait"]>(async (_delay, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {reject(signal.reason);}, { once: true });
        });
      });
      const operation = runVoicetextSemanticCanary(canaryArguments(fixture, 50), "/run/secrets/token", {
        createBatchClient: () => ({ poll, submit }),
        openLiveSession: vi.fn(),
        readFixture: async () => fixture,
        readToken: async () => ({ generationId: "generation", mode: 0o400, ownerUid: 1,
          path: "/run/secrets/token", token: "secret-machine-bearer" }),
        wait,
      });
      const rejection = expect(operation).rejects.toThrow("internal deadline");
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(submit).toHaveBeenCalledOnce();
      expect(poll).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a live session whose finalization ignores deadline cancellation", async () => {
    vi.useFakeTimers();
    try {
      const fixture = canaryFixture();
      const terminate = vi.fn();
      const operation = runVoicetextSemanticCanary(canaryArguments(fixture, 50), "/run/secrets/token", {
        createBatchClient: () => ({ poll: async () => completed, submit: async () => completed }),
        openLiveSession: async ({ onTranscript }) => {
          onTranscript({ endMs: 40, startMs: 0, text: "привет Botik" }, true);
          return { finalize: async () => {await new Promise<void>(() => {});},
            sendPacket: async () => "accepted", terminate };
        },
        readFixture: async () => fixture,
        readToken: async () => ({ generationId: "generation", mode: 0o400, ownerUid: 1,
          path: "/run/secrets/token", token: "secret-machine-bearer" }),
        wait: async () => {},
      });
      const rejection = expect(operation).rejects.toThrow("internal deadline");
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a live session that resolves only after its opening deadline", async () => {
    vi.useFakeTimers();
    try {
      const fixture = canaryFixture();
      const terminate = vi.fn();
      let completeOpening: ((session: VoicetextLiveSession) => void) | undefined;
      const operation = runVoicetextSemanticCanary(canaryArguments(fixture, 50), "/run/secrets/token", {
        createBatchClient: () => ({ poll: async () => completed, submit: async () => completed }),
        openLiveSession: async () => await new Promise<VoicetextLiveSession>((resolve) => {
          completeOpening = resolve;
        }),
        readFixture: async () => fixture,
        readToken: async () => ({ generationId: "generation", mode: 0o400, ownerUid: 1,
          path: "/run/secrets/token", token: "secret-machine-bearer" }),
        wait: async () => {},
      });
      const rejection = expect(operation).rejects.toThrow("internal deadline");
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      completeOpening?.({ finalize: async () => {}, sendPacket: async () => "accepted", terminate });
      await vi.waitFor(() => {expect(terminate).toHaveBeenCalledOnce();});
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects token rotation after provider work and before emitting a passing result", async () => {
    const fixture = canaryFixture();
    const readToken = vi.fn<VoicetextSemanticCanaryDependencies["readToken"]>()
      .mockResolvedValueOnce({ generationId: "generation-1", mode: 0o400, ownerUid: 1,
        path: "/run/secrets/token", token: "secret-machine-bearer-1" })
      .mockResolvedValueOnce({ generationId: "generation-2", mode: 0o400, ownerUid: 1,
        path: "/run/secrets/token", token: "secret-machine-bearer-2" });
    const finalize = vi.fn(async () => {});
    const operation = runVoicetextSemanticCanary(
      canaryArguments(fixture, 20_000), "/run/secrets/token", {
        createBatchClient: () => ({ poll: async () => completed, submit: async () => completed }),
        openLiveSession: async ({ onTranscript }) => {
          onTranscript({ endMs: 40, startMs: 0, text: "привет Botik" }, true);
          return { finalize, sendPacket: async () => "accepted", terminate: vi.fn() };
        },
        readFixture: async () => fixture,
        readToken,
        wait: async () => {},
      },
    );
    await expect(operation).rejects.toThrow("token file changed");
    expect(finalize).toHaveBeenCalledOnce();
    expect(readToken).toHaveBeenCalledTimes(2);
  });

  it("fails through a silent process envelope so secrets and transcripts cannot reach stderr", () => {
    const packageRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "src/run-voicetext-semantic-canary.ts", "--json",
    ], { cwd: packageRoot, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  }, 15_000);
});

function nextBatchResult(results: VoicetextBatchTaskResult[]): VoicetextBatchTaskResult {
  const result = results.shift();
  if (result === undefined) {throw new Error("unexpected batch call");}
  return result;
}

function canaryFixture(): Uint8Array {
  return compileOggOpus("canary", "speaker", [{
    opus: Uint8Array.from([0xf8, 0xff, 0xfe]), receivedAtMs: 0, relativeTimeMs: 0,
    rtpSequence: 1, rtpTimestamp: 0,
  }, {
    opus: Uint8Array.from([0xf8, 0xff, 0xfd]), receivedAtMs: 20, relativeTimeMs: 20,
    rtpSequence: 2, rtpTimestamp: 960,
  }]).bytes;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canaryArguments(fixture: Uint8Array, deadlineMs: number) {
  return {
    batchEndpoint: "https://voicetext.test/api/v1/transcribe/batch",
    campaignId: "campaign-1",
    deadlineMs,
    fixturePath: "/fixtures/canary.ogg",
    fixtureSha256: digest(fixture),
    imageDigestSha256: "b".repeat(64),
    keyterms: ["Botik"],
    liveEndpoint: "wss://voicetext.test/api/v1/transcribe/stream",
    planSha256: "c".repeat(64),
    profiles: { batch: "deepgram-nova-3", live: "deepgram-nova-3" },
    sourceRevision: "d".repeat(40),
  } as const;
}
