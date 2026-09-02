import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { WebSocket, type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOOPBACK_TOKEN, startLoopbackGateway } from "./voicetext-gateway-black-box-fixture.js";

const FETCH_TIMEOUT_MS = 5_000;
const FRAME_TIMEOUT_MS = 5_000;
const POLL_ATTEMPTS = 50;
const POLL_INTERVAL_MS = 20;
const LOCAL_TOKEN = "local-routing-token-32-bytes-long-0001";

const profileExpectations = [
  { mode: "live", model: "nova-3", profile: "deepgram-nova-3", protocol_version: 2, provider: "deepgram", ready: true },
  { mode: "live", model: "scribe_v2_realtime", profile: "elevenlabs-scribe-v2-realtime", protocol_version: 2, provider: "elevenlabs", ready: true },
  { contract_version: 2, mode: "batch", model: "nova-3", profile: "deepgram-nova-3", provider: "deepgram", ready: true },
  { contract_version: 3, mode: "batch", model: "scribe_v2", profile: "elevenlabs-scribe-v2", provider: "elevenlabs", ready: true },
] as const;

type BatchProfile = {
  readonly contractVersion: 2 | 3;
  readonly provider: "deepgram" | "elevenlabs";
  readonly model: "nova-3" | "scribe_v2";
};

type LiveProfile = {
  readonly provider: "deepgram" | "elevenlabs";
  readonly model: "nova-3" | "scribe_v2_realtime";
};

type ExternalConfiguration = {
  readonly httpOrigin: URL;
  readonly wsOrigin: URL;
  readonly token: string;
  readonly fixturePath: string;
  readonly providerWire: boolean;
};

const externalConfiguration = loadExternalConfiguration();

describe("VoiceText gateway black-box cross-head fixture", () => {
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

  it("keeps ordinary package routing coverage providerless and deterministic", async () => {
    expect(Buffer.byteLength(LOCAL_TOKEN)).toBeGreaterThanOrEqual(32);
    await assertLocalRoutingContract(parseOrigin(inMemoryOrigin, ["http:", "https:"]));
  });

  it("executes all four profiles against a deterministic loopback contract gateway", async () => {
    const gateway = await startLoopbackGateway();
    try {
      try {
        await assertExternalGatewayContract({
          fixturePath: gateway.fixturePath,
          httpOrigin: gateway.httpOrigin,
          providerWire: true,
          token: LOOPBACK_TOKEN,
          wsOrigin: gateway.wsOrigin,
        });
      } catch (error) {
        throw new Error(
          `loopback contract failed after ${JSON.stringify(gateway.counters)}: ${error instanceof Error ? error.stack : String(error)}`,
          { cause: error },
        );
      }
      expect(gateway.counters).toEqual({
        deepgram_batch: 2,
        deepgram_live: 2,
        elevenlabs_batch: 2,
        elevenlabs_live: 2,
      });
    } finally {
      await gateway.stop();
    }
  });

  it.skipIf(externalConfiguration === undefined)(
    "consumes all four real gateway provider and mode profiles",
    async () => {
      await assertExternalGatewayContract(requireExternalConfiguration(externalConfiguration));
    },
    120_000,
  );
});

async function assertLocalRoutingContract(origin: URL): Promise<void> {
  for (const path of ["/health", "/health/live", "/health/ready"]) {
    expect((await boundedFetch(new URL(path, origin))).status, `${path} must be routed`).toBe(200);
  }
  expect((await boundedFetch(new URL("/api/v1/transcribe/batch", origin), { method: "POST" })).status).toBe(401);
  expect((await boundedFetch(new URL("/__voicetext_cross_head_unknown__", origin))).status).toBe(404);
}

async function assertExternalGatewayContract(configuration: ExternalConfiguration): Promise<void> {
  await assertHealthAndClosedBoundaries(configuration);
  const fixture = await readFile(configuration.fixturePath);
  expect(fixture.subarray(0, 4).toString("ascii"), "the supplied fixture must be Ogg").toBe("OggS");
  expect(fixture.includes(Buffer.from("OpusHead")), "the supplied fixture must contain Opus").toBe(true);

  const qualificationRuns = configuration.providerWire ? 2 : 1;
  const batchProfiles: readonly BatchProfile[] = [
    { contractVersion: 2, provider: "deepgram", model: "nova-3" },
    { contractVersion: 3, provider: "elevenlabs", model: "scribe_v2" },
  ];
  const liveProfiles: readonly LiveProfile[] = [
    { provider: "deepgram", model: "nova-3" },
    { provider: "elevenlabs", model: "scribe_v2_realtime" },
  ];

  for (let run = 0; run < qualificationRuns; run += 1) {
    for (const [index, profile] of batchProfiles.entries()) {
      await assertBatchProfile(configuration, profile, idempotencyKey(run, index));
    }
    for (const [index, profile] of liveProfiles.entries()) {
      await assertLiveProfile(configuration, profile, run * liveProfiles.length + index);
    }
  }
}

async function assertHealthAndClosedBoundaries(configuration: ExternalConfiguration): Promise<void> {
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

  const unknown = await boundedFetch(new URL("/__voicetext_cross_head_unknown__", configuration.httpOrigin));
  expect(unknown.status).toBe(404);
  await expectUnauthenticatedWebSocketRejection(streamEndpoint(configuration.wsOrigin));
}

async function assertBatchProfile(
  configuration: ExternalConfiguration,
  profile: BatchProfile,
  key: string,
): Promise<void> {
  const endpoint = new URL("/api/v1/transcribe/batch", configuration.httpOrigin);
  const submitted = await submitBatch(endpoint, configuration, profile, key);
  expect(submitted.status).toBe(202);
  const pending = await readJson(submitted);
  assertPendingBatch(pending, profile);
  const jobId = requiredString(pending, "job_id");
  expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  const completed = await pollBatch(configuration, profile, jobId);
  assertCompletedBatch(completed, profile, jobId);

  // A replay is safe only after the terminal response is known. Never retry an
  // uncertain submission; this second POST is the contract's deliberate replay.
  const replay = await submitBatch(endpoint, configuration, profile, key);
  expect(replay.status).toBe(200);
  expect(await readJson(replay)).toEqual(completed);
}

async function submitBatch(
  endpoint: URL,
  configuration: ExternalConfiguration,
  profile: BatchProfile,
  key: string,
): Promise<Response> {
  const form = new FormData();
  form.set("contract_version", String(profile.contractVersion));
  form.set("provider", profile.provider);
  form.set("model", profile.model);
  form.set("language", "multi");
  form.set("keyterms", '["Quanta"]');
  form.set(
    "file",
    new Blob([new Uint8Array(await readFile(configuration.fixturePath))], { type: "audio/ogg" }),
    "speaker-track.ogg",
  );
  return boundedFetch(endpoint, {
    body: form,
    headers: { authorization: `Bearer ${configuration.token}`, "x-idempotency-key": key },
    method: "POST",
  });
}

async function pollBatch(
  configuration: ExternalConfiguration,
  profile: BatchProfile,
  jobId: string,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(`/api/v1/transcribe/batch/${jobId}`, configuration.httpOrigin);
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const response = await boundedFetch(endpoint, { headers: { authorization: `Bearer ${configuration.token}` } });
    const body = await readJson(response);
    if (response.status === 200) {
      return body;
    }
    expect(response.status).toBe(202);
    assertPendingBatch(body, profile);
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("batch job did not reach a terminal state within the bounded poll window");
}

function assertPendingBatch(body: Record<string, unknown>, profile: BatchProfile): void {
  const base = ["job_id", "next_action", "retry_after_ms", "status", "success"];
  expectExactKeys(body, profile.contractVersion === 3 ? [...base, "contract_version", "provider", "model", "language"] : base);
  expect(body.success).toBe(true);
  expect(body.status).toBe("running");
  expect(body.next_action).toBe("poll");
  expect(body.retry_after_ms).toBe(1_000);
  if (profile.contractVersion === 3) {
    assertIdentity(body, profile);
  }
}

function assertCompletedBatch(body: Record<string, unknown>, profile: BatchProfile, jobId: string): void {
  const base = ["job_id", "result", "status", "success"];
  expectExactKeys(body, profile.contractVersion === 3 ? [...base, "contract_version", "provider", "model", "language"] : base);
  expect(body).toMatchObject({ job_id: jobId, status: "completed", success: true });
  if (profile.contractVersion === 3) {
    assertIdentity(body, profile);
  }
  const result = requiredObject(body, "result");
  expect(result).toMatchObject({ language: "multi", model: profile.model, provider: profile.provider, text: "synthetic speech" });
  if (profile.contractVersion === 2) {
    expectExactKeys(result, ["duration_seconds", "language", "model", "provider", "readable_segments", "text", "utterances"]);
    expectPositiveNumber(result.duration_seconds);
    assertV2Segments(
      requiredArray(result, "utterances"),
      ["confidence", "end", "start", "transcript"],
      "confidence",
    );
    assertV2Segments(
      requiredArray(result, "readable_segments"),
      ["end", "source_utterance_indices", "start", "transcript"],
      "source_utterance_indices",
    );
  } else {
    expectExactKeys(result, ["duration_ms", "language", "model", "provider", "provider_request", "result_id", "segments", "text"]);
    expect(result.result_id).toBe(jobId);
    expectPositiveNumber(result.duration_ms);
    const segments = requiredArray(result, "segments");
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expectExactKeys(asObject(segment), ["confidence", "end_ms", "index", "start_ms", "text"]);
      expect(asObject(segment)).toMatchObject({ index: 0, text: "synthetic speech" });
      expectTimestampPair(asObject(segment), "start_ms", "end_ms");
      expectNonNegativeNumber(asObject(segment).confidence);
    }
    const providerRequest = requiredObject(result, "provider_request");
    expectExactKeys(providerRequest, ["id"]);
    expect(requiredString(providerRequest, "id").length).toBeGreaterThan(0);
  }
}

function assertV2Segments(
  segments: unknown[],
  keys: string[],
  detail: "confidence" | "source_utterance_indices",
): void {
  expect(segments.length).toBeGreaterThan(0);
  for (const item of segments) {
    const segment = asObject(item);
    expectExactKeys(segment, keys);
    expect(segment.transcript).toBe("synthetic speech");
    expectTimestampPair(segment, "start", "end");
    if (detail === "confidence") {
      expectNonNegativeNumber(segment.confidence);
    } else {
      expect(segment.source_utterance_indices).toEqual([0]);
    }
  }
}

async function assertLiveProfile(
  configuration: ExternalConfiguration,
  profile: LiveProfile,
  sessionIndex: number,
): Promise<void> {
  const socket = await openWebSocket(streamEndpoint(configuration.wsOrigin), configuration.token);
  const messages = new SocketMessages(socket);
  try {
    await sendSocket(socket, JSON.stringify({
      type: "config",
      provider: profile.provider,
      model: profile.model,
      language: "multi",
      capabilities: ["finalize_ack"],
      channels: 1,
      protocol_v: 2,
      client_session_id: `123e4567-e89b-42d3-a456-${String(sessionIndex + 1).padStart(12, "0")}`,
      encoding: "opus",
      sample_rate: 48_000,
      keyterms: ["Quanta"],
    }));
    const ready = await messages.nextJson();
    expectExactKeys(ready, ["model", "provider", "session_id", "type"]);
    expect(ready).toMatchObject({ model: profile.model, provider: profile.provider, type: "ready" });
    expect(requiredString(ready, "session_id")).toMatch(/^[0-9a-f-]{36}$/i);

    // RFC 6716's three-byte Opus silence packet is a deterministic valid audio
    // representation. Four frames also exercise ElevenLabs' buffered live path.
    const audio = Buffer.from([0xf8, 0xff, 0xfe]);
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      await sendSocket(socket, audio);
    }

    let acknowledged = 0;
    let sawPartial = false;
    let sawFinal = false;
    while (acknowledged < 4) {
      const message = await messages.nextJson();
      if (message.type === "ack") {
        expectExactKeys(message, ["seq", "type"]);
        acknowledged += 1;
        expect(message.seq).toBe(acknowledged);
      } else {
        ({ sawPartial, sawFinal } = assertTranscript(message, sawPartial, sawFinal));
      }
    }

    await sendSocket(socket, '{"type":"finalize"}');
    let finalized = false;
    while (!finalized) {
      const message = await messages.nextJson();
      if (message.type === "finalize_complete") {
        expectExactKeys(message, ["saw_result", "status", "type"]);
        expect(message).toEqual({ saw_result: true, status: "flushed", type: "finalize_complete" });
        finalized = true;
      } else {
        ({ sawPartial, sawFinal } = assertTranscript(message, sawPartial, sawFinal));
      }
    }
    expect(sawFinal, "live profile must produce terminal transcript evidence").toBe(true);
    expect(sawPartial, "live profile must expose the partial transcript contract").toBe(true);
  } finally {
    messages.dispose();
    await closeSocket(socket);
  }
}

function assertTranscript(
  message: Record<string, unknown>,
  sawPartial: boolean,
  sawFinal: boolean,
): { sawPartial: boolean; sawFinal: boolean } {
  expect(["partial", "final"]).toContain(message.type);
  expectExactKeys(message, ["confidence", "duration_ms", "start_ms", "text", "type"]);
  expect(message).toMatchObject({ duration_ms: 40, start_ms: 20, text: "synthetic live speech" });
  expectNonNegativeNumber(message.confidence);
  return {
    sawPartial: sawPartial || message.type === "partial",
    sawFinal: sawFinal || message.type === "final",
  };
}

class SocketMessages {
  readonly #queue: Array<Record<string, unknown>> = [];
  readonly #waiters: Array<(message: Record<string, unknown>) => void> = [];
  readonly #socket: WebSocket;
  readonly #listener: (data: RawData, isBinary: boolean) => void;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    this.#listener = (data, isBinary) => {
      if (isBinary) {
        throw new Error("gateway sent an unexpected binary server frame");
      }
      const parsed = asObject(JSON.parse(data.toString()) as unknown);
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#queue.push(parsed);
      } else {
        waiter(parsed);
      }
    };
    socket.on("message", this.#listener);
  }

  async nextJson(): Promise<Record<string, unknown>> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    return new Promise((resolve, reject) => {
      const waiter = (message: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        reject(new Error("timed out waiting for a gateway WebSocket frame"));
      }, FRAME_TIMEOUT_MS);
      this.#waiters.push(waiter);
    });
  }

  dispose(): void {
    this.#socket.off("message", this.#listener);
  }
}

async function openWebSocket(endpoint: URL, token: string): Promise<WebSocket> {
  const socket = new WebSocket(endpoint, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: FRAME_TIMEOUT_MS });
  await once(socket, "open", { signal: AbortSignal.timeout(FRAME_TIMEOUT_MS) });
  return socket;
}

async function expectUnauthenticatedWebSocketRejection(endpoint: URL): Promise<void> {
  const socket = new WebSocket(endpoint, { handshakeTimeout: FRAME_TIMEOUT_MS });
  const status = await Promise.race([
    once(socket, "unexpected-response").then(([, response]) => {
      const incoming = response as IncomingMessage;
      incoming.resume();
      return incoming.statusCode ?? 0;
    }),
    once(socket, "open").then(() => {
      socket.terminate();
      throw new Error("unauthenticated WebSocket unexpectedly opened");
    }),
    timeoutResult(FRAME_TIMEOUT_MS).then(() => {
      socket.terminate();
      throw new Error("unauthenticated WebSocket did not fail boundedly");
    }),
  ]);
  expect(status).toBe(401);
}

async function sendSocket(socket: WebSocket, payload: string | Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(payload, (error) => {
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  socket.close(1000);
  const outcome = await Promise.race([
    new Promise<"closed">((resolve) => {
      socket.once("close", () => {
        resolve("closed");
      });
    }),
    new Promise<"error">((resolve) => {
      socket.once("error", () => {
        resolve("error");
      });
    }),
    timeoutResult(FRAME_TIMEOUT_MS).then(() => "timeout" as const),
  ]);
  if (outcome === "timeout") {
    socket.terminate();
  } else if (outcome === "error") {
    throw new Error("gateway WebSocket failed during orderly close");
  }
}

function loadExternalConfiguration(): ExternalConfiguration | undefined {
  const variables = {
    httpOrigin: process.env.VOICETEXT_GATEWAY_E2E_HTTP_ORIGIN,
    wsOrigin: process.env.VOICETEXT_GATEWAY_E2E_WS_ORIGIN,
    token: process.env.VOICETEXT_GATEWAY_E2E_TOKEN,
    fixturePath: process.env.VOICETEXT_GATEWAY_E2E_OGG_FIXTURE,
  };
  const requiredByScript = process.env.VOICETEXT_GATEWAY_BLACK_BOX_REQUIRE_ORIGIN === "1";
  const providerWireRaw = process.env.VOICETEXT_GATEWAY_E2E_PROVIDER_WIRE;
  if (Object.values(variables).every((value) => value === undefined) &&
      providerWireRaw === undefined && !requiredByScript) {
    return undefined;
  }
  for (const [name, value] of Object.entries(variables)) {
    if (value === undefined || value === "") {
      throw new Error(`all external gateway E2E variables are required; missing ${name}`);
    }
  }
  if (providerWireRaw !== undefined && providerWireRaw !== "true") {
    throw new Error("VOICETEXT_GATEWAY_E2E_PROVIDER_WIRE must be exactly true when supplied");
  }
  return {
    httpOrigin: parseOrigin(variables.httpOrigin as string, ["http:", "https:"]),
    wsOrigin: parseOrigin(variables.wsOrigin as string, ["ws:", "wss:"]),
    token: variables.token as string,
    fixturePath: variables.fixturePath as string,
    providerWire: providerWireRaw === "true",
  };
}

function parseOrigin(raw: string, protocols: readonly string[]): URL {
  const origin = new URL(raw);
  if (!protocols.includes(origin.protocol) || origin.pathname !== "/" || origin.search !== "" ||
      origin.hash !== "" || origin.username !== "" || origin.password !== "") {
    throw new Error(`gateway origin must be a credential-free ${protocols.join("/")} origin`);
  }
  return origin;
}

function requireExternalConfiguration(configuration: ExternalConfiguration | undefined): ExternalConfiguration {
  if (configuration === undefined) {
    throw new Error("external gateway configuration was not supplied");
  }
  return configuration;
}

function streamEndpoint(origin: URL): URL {
  return new URL("/api/v1/transcribe/stream", origin);
}

async function boundedFetch(input: URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toMatch(/^application\/json(?:;|$)/);
  return asObject(await response.json());
}

function assertIdentity(body: Record<string, unknown>, profile: BatchProfile): void {
  expect(body).toMatchObject({ contract_version: profile.contractVersion, language: "multi", model: profile.model, provider: profile.provider });
}

function expectExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  expect(Object.keys(value).toSorted()).toEqual(keys.toSorted());
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return asObject(value[key]);
}

function requiredArray(value: Record<string, unknown>, key: string): unknown[] {
  const member = value[key];
  if (!Array.isArray(member)) {
    throw new Error(`expected ${key} to be an array`);
  }
  return member;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const member = value[key];
  if (typeof member !== "string") {
    throw new Error(`expected ${key} to be a string`);
  }
  return member;
}

function expectTimestampPair(value: Record<string, unknown>, start: string, end: string): void {
  expectNonNegativeNumber(value[start]);
  expectPositiveNumber(value[end]);
  expect(value[end] as number).toBeGreaterThanOrEqual(value[start] as number);
}

function expectPositiveNumber(value: unknown): void {
  expect(typeof value).toBe("number");
  expect(value as number).toBeGreaterThan(0);
}

function expectNonNegativeNumber(value: unknown): void {
  expect(typeof value).toBe("number");
  expect(value as number).toBeGreaterThanOrEqual(0);
}

function idempotencyKey(run: number, profile: number): string {
  return `${run.toString(16)}${profile.toString(16)}`.padEnd(64, profile === 0 ? "a" : "b");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function timeoutResult(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds).unref();
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
