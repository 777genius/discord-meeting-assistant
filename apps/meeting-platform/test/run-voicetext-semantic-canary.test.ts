import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
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
    const submits: string[] = [];
    const polls: string[] = [];
    const batchResults: VoicetextBatchTaskResult[] = [
      { jobId: completed.jobId, kind: "pending", nextAction: "retry", retryAfterMs: 10 },
      completed,
      { jobId: completed.jobId, kind: "pending", nextAction: "poll", retryAfterMs: 10 },
      completed,
    ];
    const batch: VoicetextBatchClient = {
      poll: async ({ jobId }) => {polls.push(jobId); return nextBatchResult(batchResults);},
      submit: async ({ idempotencyKey }) => {submits.push(idempotencyKey); return nextBatchResult(batchResults);},
    };
    const sentPackets: Uint8Array[] = [];
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
      createBatchClient: ({ token }) => {
        expect(token).toBe("secret-machine-bearer");
        return batch;
      },
      openLiveSession,
      readFixture: async () => fixture,
      readToken: async (path) => ({
        generationId: `file-${"f".repeat(64)}`, mode: 0o600, ownerUid: 10_001,
        path, token: "secret-machine-bearer",
      }),
      wait: async () => {},
    };

    const result = await runVoicetextSemanticCanary({
      batchEndpoint: "https://voicetext.test/api/v1/transcribe/batch",
      campaignId: "campaign-1",
      fixturePath: "/fixtures/canary.ogg",
      fixtureSha256,
      imageDigestSha256: "b".repeat(64),
      liveEndpoint: "wss://voicetext.test/api/v1/transcribe/stream",
      planSha256: "c".repeat(64),
      sourceRevision: "d".repeat(40),
    }, "/run/secrets/voicetext-service-token", dependencies);

    expect(submits).toHaveLength(3);
    expect(new Set(submits).size).toBe(1);
    expect(polls).toEqual([completed.jobId]);
    expect(result.batch.firstSubmission).toEqual(result.batch.idempotentReplay);
    expect(result.live.audioAcknowledgements).toEqual({ expected: 2, received: 2 });
    expect(sentPackets).toEqual([
      Uint8Array.from([0xf8, 0xff, 0xfe]),
      Uint8Array.from([0xf8, 0xff, 0xfd]),
    ]);
    expect(finalize).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("secret-machine-bearer");
  });

  it("rejects a substituted fixture before constructing provider clients", async () => {
    const fixture = canaryFixture();
    const createBatchClient = vi.fn();
    await expect(runVoicetextSemanticCanary({
      batchEndpoint: "https://voicetext.test/api/v1/transcribe/batch",
      campaignId: "campaign-1",
      fixturePath: "/fixtures/canary.ogg",
      fixtureSha256: "a".repeat(64),
      imageDigestSha256: "b".repeat(64),
      liveEndpoint: "wss://voicetext.test/api/v1/transcribe/stream",
      planSha256: "c".repeat(64),
      sourceRevision: "d".repeat(40),
    }, "/run/secrets/token", {
      createBatchClient,
      openLiveSession: vi.fn(),
      readFixture: async () => fixture,
      readToken: async () => ({ generationId: "generation", mode: 0o600, ownerUid: 1,
        path: "/run/secrets/token", token: "secret-machine-bearer" }),
      wait: async () => {},
    })).rejects.toThrow("pinned digest");
    expect(createBatchClient).not.toHaveBeenCalled();
  });

  it("accepts only endpoints that exactly match the runtime configuration", () => {
    const argv = [
      "--fixture", "/fixtures/canary.ogg",
      "--fixture-sha256", "a".repeat(64),
      "--campaign", "campaign-1",
      "--plan-sha256", "b".repeat(64),
      "--source-revision", "c".repeat(40),
      "--image-digest-sha256", "d".repeat(64),
      "--batch-origin", "https://voicetext.test",
      "--batch-path", "/api/v1/transcribe/batch",
      "--live-origin", "wss://voicetext.test",
      "--live-path", "/api/v1/transcribe/stream",
      "--json",
    ];
    expect(parseVoicetextSemanticCanaryArguments(argv, {
      VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext-service-token",
      VOICETEXT_WS_URL: "wss://voicetext.test/api/v1/transcribe/stream",
    }).args.fixtureSha256).toBe("a".repeat(64));
    expect(() => parseVoicetextSemanticCanaryArguments(argv, {
      VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext-service-token",
      VOICETEXT_WS_URL: "wss://other.test/api/v1/transcribe/stream",
    })).toThrow("do not match");
  });

  it("fails through a silent process envelope so secrets and transcripts cannot reach stderr", () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = spawnSync(resolve(packageRoot, "node_modules/.bin/tsx"), [
      "src/run-voicetext-semantic-canary.ts", "--json",
    ], { cwd: packageRoot, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
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
