import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FetchVoicetextBatchClient,
  VoicetextLiveTranscriptionAdapter,
  type VoicetextBatchProfile,
  type VoicetextBatchTaskResult,
  type VoicetextLiveProfile,
  type VoicetextLiveTranscriptEvent,
} from "../src/index.js";
import { LOOPBACK_TOKEN, startLoopbackGateway } from "./voicetext-gateway-black-box-fixture.js";
import {
  boundedFetch,
  expectUnauthenticatedWebSocketRejection,
  readJson,
} from "./voicetext-gateway-black-box-support.js";

const POLL_ATTEMPTS = 50;
const POLL_INTERVAL_MS = 1_000;
const LOCAL_TOKEN = "local-routing-token-32-bytes-long-0001";

const profileExpectations = [
  { mode: "live", model: "nova-3", profile: "deepgram-nova-3", protocol_version: 2, provider: "deepgram", ready: true },
  { mode: "live", model: "scribe_v2_realtime", profile: "elevenlabs-scribe-v2-realtime", protocol_version: 2, provider: "elevenlabs", ready: true },
  { contract_version: 2, mode: "batch", model: "nova-3", profile: "deepgram-nova-3", provider: "deepgram", ready: true },
  { contract_version: 3, mode: "batch", model: "scribe_v2", profile: "elevenlabs-scribe-v2", provider: "elevenlabs", ready: true },
] as const;

type ProviderlessConfiguration = {
  readonly fixturePath: string;
  readonly httpOrigin: URL;
  readonly token: string;
  readonly wsOrigin: URL;
};

describe("VoiceText gateway providerless black-box contract fixture", () => {
  let inMemoryServer!: Server;
  let inMemoryOrigin = "";

  beforeAll(async () => {
    inMemoryServer = createRoutingServer();
    await new Promise<void>((resolve, reject) => {
      inMemoryServer.once("error", reject);
      inMemoryServer.listen(0, "127.0.0.1", resolve);
    });
    const address = inMemoryServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("in-memory gateway fixture did not bind TCP");
    }
    inMemoryOrigin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      inMemoryServer.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  });

  it("keeps ordinary route contract coverage providerless and deterministic", async () => {
    expect(Buffer.byteLength(LOCAL_TOKEN)).toBeGreaterThanOrEqual(32);
    await assertLocalRoutingContract(parseOrigin(inMemoryOrigin, ["http:", "https:"]));
  });

  it("documents providerless conformance separately from the real-provider canary", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const packageManifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
    expect(readme).toMatch(/default package suite is providerless[\s\S]*in-process contract gateway/iu);
    expect(readme).toMatch(/separate provider canary[\s\S]*real Opus speech packets/iu);
    for (const variable of [
      "VOICETEXT_GATEWAY_PROVIDER_CANARY_REQUIRED",
      "VOICETEXT_GATEWAY_PROVIDER_CANARY_IDENTITY_FILE",
      "VOICETEXT_GATEWAY_PROVIDER_CANARY_RECEIPT",
    ]) {
      expect(readme).toContain(variable);
    }
    expect(`${readme}\n${packageManifest}`).not.toContain("VOICETEXT_GATEWAY_BLACK_BOX");
    expect(readme).toMatch(/does not qualify a language/iu);
  });

  it("drives all four profiles through the production clients against an in-process contract gateway", async () => {
    const gateway = await startLoopbackGateway();
    try {
      await assertProviderlessGatewayContract({
        fixturePath: gateway.fixturePath,
        httpOrigin: gateway.httpOrigin,
        token: LOOPBACK_TOKEN,
        wsOrigin: gateway.wsOrigin,
      });
      expect(gateway.counters).toEqual({
        deepgram_batch: 1,
        deepgram_live: 1,
        elevenlabs_batch: 1,
        elevenlabs_live: 1,
      });
    } finally {
      await gateway.stop();
    }
  });
});

async function assertLocalRoutingContract(origin: URL): Promise<void> {
  for (const path of ["/health", "/health/live", "/health/ready"]) {
    expect((await boundedFetch(new URL(path, origin))).status, `${path} must be routed`).toBe(200);
  }
  expect((await boundedFetch(new URL("/api/v1/transcribe/batch", origin), { method: "POST" })).status).toBe(401);
  expect((await boundedFetch(new URL("/__voicetext_providerless_unknown__", origin))).status).toBe(404);
}

async function assertProviderlessGatewayContract(configuration: ProviderlessConfiguration): Promise<void> {
  await assertHealthAndClosedBoundaries(configuration);
  const fixture = await readFile(configuration.fixturePath);
  expect(fixture.subarray(0, 4).toString("ascii"), "the supplied fixture must be Ogg").toBe("OggS");
  expect(fixture.includes(Buffer.from("OpusHead")), "the supplied fixture must contain Opus").toBe(true);

  const batchProfiles: readonly VoicetextBatchProfile[] = [
    "deepgram-nova-3",
    "elevenlabs-scribe-v2",
  ];
  const liveProfiles: readonly VoicetextLiveProfile[] = [
    "deepgram-nova-3",
    "elevenlabs-scribe-v2-realtime",
  ];
  for (const [index, profile] of batchProfiles.entries()) {
    await assertBatchProfile(configuration, fixture, profile, idempotencyKey("batch", index));
  }
  for (const [index, profile] of liveProfiles.entries()) {
    await assertLiveProfile(configuration, profile, index);
  }
}

async function assertHealthAndClosedBoundaries(configuration: ProviderlessConfiguration): Promise<void> {
  const health = await boundedFetch(new URL("/health", configuration.httpOrigin));
  expect(health.status).toBe(200);
  expect(await readJson(health)).toEqual({ status: "ok", provider_profiles: profileExpectations });
  for (const path of ["/health/live", "/health/ready"]) {
    expect((await boundedFetch(new URL(path, configuration.httpOrigin))).status).toBe(200);
  }
  const unauthorized = await boundedFetch(
    new URL("/api/v1/transcribe/batch/123e4567-e89b-42d3-a456-426614174000", configuration.httpOrigin),
  );
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("x-voicetext-error-code")).toBe("UNAUTHORIZED");
  const unauthorizedBody = await unauthorized.text();
  expect(unauthorizedBody).toBe('{"error_code":"UNAUTHORIZED"}');
  expect(unauthorizedBody).not.toContain(configuration.token);
  expect((await boundedFetch(new URL("/__voicetext_providerless_unknown__", configuration.httpOrigin))).status).toBe(404);
  await expectUnauthenticatedWebSocketRejection(streamEndpoint(configuration.wsOrigin));
  await assertBatchResourceBound(configuration);
}

async function assertBatchResourceBound(configuration: ProviderlessConfiguration): Promise<void> {
  const form = new FormData();
  form.set("contract_version", "2");
  form.set("provider", "deepgram");
  form.set("model", "nova-3");
  form.set("language", "multi");
  form.set("keyterms", "[]");
  form.set("file", new Blob([new Uint8Array(1_024 * 1_024 + 1)], { type: "audio/ogg" }), "oversized.ogg");
  const response = await boundedFetch(new URL("/api/v1/transcribe/batch", configuration.httpOrigin), {
    body: form,
    headers: {
      authorization: `Bearer ${configuration.token}`,
      "x-idempotency-key": "resource-bound".padEnd(64, "0"),
    },
    method: "POST",
  });
  expect(response.status).toBe(400);
  expect(response.headers.get("x-voicetext-error-code")).toBe("MULTIPART_FIELD_TOO_LARGE");
}

async function assertBatchProfile(
  configuration: ProviderlessConfiguration,
  fixture: Uint8Array,
  profile: VoicetextBatchProfile,
  key: string,
): Promise<void> {
  const client = new FetchVoicetextBatchClient({
    endpoint: new URL("/api/v1/transcribe/batch", configuration.httpOrigin).toString(),
    profile,
    token: configuration.token,
  });
  const signal = AbortSignal.timeout(110_000);
  const submitted = await client.submit({ audio: fixture, idempotencyKey: key, keyterms: ["Quanta"], signal });
  expect(submitted.kind).toBe("pending");
  const completed = await pollUntilCompleted(client, submitted, signal);
  expect(completed.result.durationSeconds).toBeGreaterThan(0);
  expect(completed.result.utterances).toEqual([
    expect.objectContaining({ transcript: "synthetic speech" }),
  ]);

  const replay = await client.submit({ audio: fixture, idempotencyKey: key, keyterms: ["Quanta"], signal });
  expect(replay).toEqual(completed);
}

async function pollUntilCompleted(
  client: FetchVoicetextBatchClient,
  initial: VoicetextBatchTaskResult,
  signal: AbortSignal,
): Promise<Extract<VoicetextBatchTaskResult, { readonly kind: "completed" }>> {
  let result = initial;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (result.kind === "completed") {
      return result;
    }
    if (result.kind === "failed") {
      throw new Error(`batch job failed with ${result.errorCode}`);
    }
    result = await client.poll({ jobId: result.jobId, signal });
    if (result.kind === "pending") {
      await delay(Math.min(result.retryAfterMs, POLL_INTERVAL_MS));
    }
  }
  throw new Error("batch job did not reach a terminal state within the bounded poll window");
}

async function assertLiveProfile(
  configuration: ProviderlessConfiguration,
  profile: VoicetextLiveProfile,
  index: number,
): Promise<void> {
  const events: VoicetextLiveTranscriptEvent[] = [];
  const adapter = new VoicetextLiveTranscriptionAdapter({
    audioAckTimeoutMs: 10_000,
    endpoint: streamEndpoint(configuration.wsOrigin).toString(),
    finalizeTimeoutMs: 30_000,
    keyterms: ["Quanta"],
    language: "multi",
    profile,
    token: configuration.token,
  });
  const session = await adapter.openSession({
    idempotencyKey: `providerless-live-${index}`,
    meetingId: "providerless-meeting",
    onTranscript: (event) => events.push(event),
    speakerId: `speaker-${index}`,
  });
  expect(session.constructor.name).toBe("LiveSession");
  const audio = Uint8Array.from([0xf8, 0xff, 0xfe]);
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    await expect(session.sendPacket({
      durationSamples48Khz: 960,
      opus: audio,
      packetId: `packet-${sequence}`,
      relativeTimeMs: sequence * 20,
    })).resolves.toBe("accepted");
  }
  await session.finalize();
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ isFinal: false, text: "synthetic live speech" }),
    expect.objectContaining({ isFinal: true, text: "synthetic live speech" }),
  ]));
}

function parseOrigin(raw: string, protocols: readonly string[]): URL {
  const origin = new URL(raw);
  if (!protocols.includes(origin.protocol) || origin.pathname !== "/" || origin.search !== "" ||
      origin.hash !== "" || origin.username !== "" || origin.password !== "") {
    throw new Error(`gateway origin must be a credential-free ${protocols.join("/")} origin`);
  }
  return origin;
}

function streamEndpoint(origin: URL): URL {
  return new URL("/api/v1/transcribe/stream", origin);
}

function idempotencyKey(kind: string, profile: number): string {
  return createHash("sha256").update(`${kind}:${profile}`).digest("hex");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function createRoutingServer(): Server {
  return createServer((request, response) => {
    if (["/health", "/health/live", "/health/ready"].includes(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    if (request.url === "/api/v1/transcribe/batch") {
      response.writeHead(401, { "content-type": "application/json", "x-voicetext-error-code": "UNAUTHORIZED" });
      response.end('{"error_code":"UNAUTHORIZED"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
}
