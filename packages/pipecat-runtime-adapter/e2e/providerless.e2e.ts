import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CraigPlaybackCommand } from "@discord-meeting/craig-gateway-contracts";
import {
  attachCraigPlaybackWebSocketServer,
  CraigPlaybackGateway,
} from "@discord-meeting/craig-playback-adapter";
import {
  ConversationCoordinator,
  type ConversationRuntime,
  type ConversationRuntimeEvent,
} from "@discord-meeting/meeting-core/conversation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";

import { GrpcPipecatConversationRuntime } from "../src/index.js";
import { proveGroundedConversationTransport } from "./providerless-grounded-transport-proof.js";

const serviceToken = "providerless-e2e-token-123";
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sidecarRoot = join(workspaceRoot, "apps/pipecat-runtime");
const sidecarBindTimeoutMilliseconds = 360_000;
const sidecarHealthTimeoutMilliseconds = 30_000;

const request = {
  idempotencyKey: "providerless-e2e:meeting-1:turn-1",
  locale: "ru-RU",
  meetingId: "meeting-1",
  prompt: "Скажи, что ты слушаешь.",
  recordingId: "recording-1",
  speakerId: "speaker-1",
  systemPrompt: "Answer briefly in the participant's language.",
  turnId: "turn-1",
  voiceProfileId: "deterministic-e2e",
} as const;

let runtime: GrpcPipecatConversationRuntime | undefined;
let sidecar: ChildProcessWithoutNullStreams | undefined;
let temporaryRoot: string | undefined;
let stderr = "";
let stdout = "";

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "pipecat-providerless-e2e-"));
  const tokenFile = join(temporaryRoot, "runtime-token");
  await writeFile(tokenFile, `${serviceToken}\n`, { mode: 0o600 });
  const port = await reserveLoopbackPort();
  sidecar = spawn("uv", ["run", "pipecat-runtime"], {
    cwd: sidecarRoot,
    env: {
      ...process.env,
      PIPECAT_RUNTIME_BEARER_TOKEN_FILE: tokenFile,
      PIPECAT_RUNTIME_BIND_HOST: "127.0.0.1",
      PIPECAT_RUNTIME_BIND_PORT: String(port),
      PIPECAT_RUNTIME_DETERMINISTIC_AUDIO_DELAY_MS: "50",
      PIPECAT_RUNTIME_DETERMINISTIC_TEXT_DELAY_MS: "250",
      PIPECAT_RUNTIME_ENVIRONMENT: "test",
      PIPECAT_RUNTIME_PROFILE: "deterministic-e2e",
      PIPECAT_RUNTIME_PROFILE_ID: "deterministic-e2e",
    },
    stdio: "pipe",
  });
  sidecar.stderr.setEncoding("utf8");
  sidecar.stdout.setEncoding("utf8");
  sidecar.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  sidecar.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  await waitUntilTcpListening(port, sidecar, () => `${stdout}\n${stderr}`);
  runtime = new GrpcPipecatConversationRuntime({
    address: `127.0.0.1:${port}`,
    serviceToken,
  });
  await waitUntilServing(runtime, sidecar, () => `${stdout}\n${stderr}`);
}, sidecarBindTimeoutMilliseconds + sidecarHealthTimeoutMilliseconds + 15_000);

afterAll(async () => {
  if (runtime !== undefined) {
    runtime.close();
  }
  await stopProcess(sidecar);
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

describe("Node to Python providerless conversation E2E", () => {

  it("streams normalized PCM through a real Pipecat PipelineTask", async () => {
    const activeRuntime = requireRuntime(runtime);
    const wakeDetectedAtUnixMs = Date.now();
    const started = await activeRuntime.startTurn({
      ...request,
      latency: {
        turnEndedAtUnixMs: wakeDetectedAtUnixMs - 25,
        wakeDetectedAtUnixMs,
      },
    });
    if (!started.ok) {
      throw new Error(`Conversation runtime rejected E2E turn: ${started.failure.code}`);
    }

    const events = await collectWithTimeout(started.value.events);
    const eventTypes = events.map(({ type }) => type);
    expect(eventTypes[0]).toBe("accepted");
    expect(eventTypes.filter((type) => type === "text-delta")).toHaveLength(2);
    expect(eventTypes.at(-1)).toBe("completed");
    const audioChunks = events.filter(
      (event): event is Extract<ConversationRuntimeEvent, { type: "audio-chunk" }> =>
        event.type === "audio-chunk",
    );
    expect(audioChunks.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(audioChunks.every(({ bytes }) => bytes.byteLength > 0)).toBe(true);
    expect(audioChunks.every(({ bytes }) => bytes.byteLength <= 19_200)).toBe(true);
    const audioStartIndex = eventTypes.indexOf("audio-start");
    const firstAudioChunkIndex = eventTypes.indexOf("audio-chunk");
    const lastAudioChunkIndex = eventTypes.lastIndexOf("audio-chunk");
    const lastTextDeltaIndex = eventTypes.lastIndexOf("text-delta");
    const audioEndIndex = eventTypes.indexOf("audio-end");
    const usageIndex = eventTypes.indexOf("usage");
    expect(audioStartIndex).toBeGreaterThan(0);
    expect(firstAudioChunkIndex).toBeGreaterThan(audioStartIndex);
    expect(firstAudioChunkIndex).toBeLessThan(lastTextDeltaIndex);
    expect(audioEndIndex).toBeGreaterThan(lastAudioChunkIndex);
    expect(usageIndex).toBeGreaterThan(audioEndIndex);
    expect(eventTypes.length - 1).toBeGreaterThan(usageIndex);
    const latency = events.find(
      (event): event is Extract<ConversationRuntimeEvent, { type: "latency" }> =>
        event.type === "latency",
    );
    expect(latency).toBeDefined();
    expect(latency?.endTurnToWakeMs).toBe(25);
    expect(latency?.wakeToFirstLlmTokenMs).toBeGreaterThanOrEqual(200);
    expect(latency?.wakeToFirstLlmTokenMs).toBeLessThan(1_000);
    expect(latency?.firstLlmTokenToAudioMs).toBeLessThan(500);
    expect(latency?.totalToFirstAudioMs).toBeLessThan(1_500);
    expect(latency?.totalToFirstAudioMs).toBe(
      (latency?.endTurnToWakeMs ?? 0) +
        (latency?.wakeToFirstLlmTokenMs ?? 0) +
        (latency?.firstLlmTokenToAudioMs ?? 0),
    );
  }, 15_000);

  it("propagates cancellation into an active Pipecat task", async () => {
    const activeRuntime = requireRuntime(runtime);
    const started = await activeRuntime.startTurn({
      ...request,
      idempotencyKey: "providerless-e2e:meeting-1:turn-2",
      turnId: "turn-2",
    });
    if (!started.ok) {
      throw new Error(`Conversation runtime rejected cancellation turn: ${started.failure.code}`);
    }

    const iterator = started.value.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "accepted" },
    });
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        throw new Error("providerless cancellation turn ended before first PCM");
      }
      if (next.value.type === "audio-chunk") {
        break;
      }
    }
    await started.value.cancel("barge-in");
    const remaining = await collectIteratorWithTimeout(iterator);
    expect(remaining.at(-1)).toMatchObject({
      type: "cancelled",
      reason: "barge-in",
    });
    expect(remaining.some(({ type }) => type === "audio-chunk")).toBe(false);
    expect(remaining.some(({ type }) => type === "completed")).toBe(false);

    const queued = await activeRuntime.startTurn({
      ...request,
      idempotencyKey: "providerless-e2e:meeting-1:turn-3",
      turnId: "turn-3",
    });
    if (!queued.ok) {
      throw new Error(`Conversation runtime rejected queued turn: ${queued.failure.code}`);
    }
    const queuedEvents = await collectWithTimeout(queued.value.events);
    expect(queuedEvents[0]).toMatchObject({ type: "accepted" });
    expect(queuedEvents.at(-1)).toMatchObject({ type: "completed" });
  }, 15_000);

  it("bridges an addressed turn through Pipecat and the real Craig WebSocket adapter", async () => {
    const activeRuntime = requireRuntime(runtime);
    const playback = new CraigPlaybackGateway();
    const httpServer = createHttpServer((_request, response) => {
      response.writeHead(404).end();
    });
    const playbackServer = attachCraigPlaybackWebSocketServer(httpServer, {
      bearerToken: serviceToken,
      gateway: playback,
    });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Craig E2E WebSocket server did not expose a TCP address");
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/craig/playback`, {
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    const commands: CraigPlaybackCommand[] = [];
    const playedPcmChunks: Uint8Array[] = [];
    let firstAudioAtMilliseconds: number | undefined;
    socket.on("message", (raw) => {
      const command = JSON.parse(webSocketText(raw)) as CraigPlaybackCommand;
      commands.push(command);
      if (command.type === "audio-chunk") {
        playedPcmChunks.push(Buffer.from(command.pcmBase64, "base64"));
        if (firstAudioAtMilliseconds === undefined) {
          firstAudioAtMilliseconds = performance.now();
          socket.send(JSON.stringify({
            schemaVersion: 1,
            type: "playback-started",
            recordingId: command.recordingId,
            turnId: command.turnId,
            attemptId: command.attemptId,
            startedAtMs: Date.now(),
          }));
        }
      }
      if (command.type === "playback-finish") {
        socket.send(JSON.stringify({
          schemaVersion: 1,
          type: "playback-finished",
          recordingId: command.recordingId,
          turnId: command.turnId,
          attemptId: command.attemptId,
          finishedAtMs: Date.now(),
        }));
      }
    });

    try {
      await once(socket, "open");
      socket.send(JSON.stringify({
        schemaVersion: 1,
        type: "session-ready",
        recordingId: "recording-e2e",
        guildId: "1533228590643155034",
        channelId: "1533228823045214398",
        gatewaySessionId: "gateway-e2e",
      }));
      await waitForCondition(() => playback.hasSession("recording-e2e"));
      const coordinator = new ConversationCoordinator({ playback, runtime: activeRuntime });
      const startedAtMilliseconds = performance.now();
      await expect(coordinator.handleFinalizedTurn({
        locale: "ru-RU",
        meetingId: "meeting-e2e",
        nowMs: 1,
        recordingId: "recording-e2e",
        roomId: "room-e2e",
        speakerId: "speaker-e2e",
        systemPrompt: request.systemPrompt,
        text: "Ботик, скажи, что ты слушаешь.",
        thinkingCueLocale: "ru-RU",
        transcriptEndMs: 1_000,
        transcriptStartMs: 0,
        turnId: "turn-e2e",
        voiceProfileId: request.voiceProfileId,
      })).resolves.toMatchObject({
        status: "active",
        prompt: "скажи, что ты слушаешь.",
      });
      await coordinator.whenIdle("meeting-e2e");
      await expect(coordinator.whenTurnPlaybackSettled("meeting-e2e", "turn-e2e"))
        .resolves.toBe("played");
      await waitForCondition(() =>
        commands.some((command) => command.type === "playback-finish"),
      );

      expect(commands[0]?.type).toBe("playback-start");
      const audioCommands = commands.filter(
        (command): command is Extract<CraigPlaybackCommand, { type: "audio-chunk" }> =>
          command.type === "audio-chunk",
      );
      expect(audioCommands.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]);
      expect(commands.at(-1)?.type).toBe("playback-finish");
      expect(playedPcmChunks.every(({ byteLength }) => byteLength > 0)).toBe(true);
      expect(firstAudioAtMilliseconds).toBeDefined();
      expect(firstAudioAtMilliseconds! - startedAtMilliseconds).toBeLessThan(1_500);
      await coordinator.closeMeeting("meeting-e2e", Math.floor(performance.now()));
    } finally {
      socket.terminate();
      playback.close();
      await playbackServer.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
  }, 15_000);

  it("bridges a deterministic grounded answer through real gRPC, Pipecat, WebSocket and PCM",
    () => proveGroundedConversationTransport({
      openPlaybackHarness,
      runtime: requireRuntime(runtime),
      voiceProfileId: request.voiceProfileId,
      waitForCondition,
    }), 15_000);
});

describe("Providerless greeting and farewell playback E2E", () => {
  it.each([
    {
      locale: "ru",
      participantId: "1533224474609057795",
      prompt: "Привет, Саша!",
      recordingId: "grNamedRu001",
      scenario: "named-ru",
    },
    {
      locale: "en",
      participantId: "2533224474609057795",
      prompt: "Hi, Alex!",
      recordingId: "grNamedEn001",
      scenario: "named-en",
    },
    {
      locale: "ru",
      participantId: "3533224474609057795",
      prompt: "Привет!",
      recordingId: "grAnonRu0001",
      scenario: "anonymous-ru",
    },
    {
      locale: "en",
      participantId: "4533224474609057795",
      prompt: "Hi!",
      recordingId: "grAnonEn0001",
      scenario: "anonymous-en",
    },
  ])("bridges a $scenario proactive greeting through Pipecat and real Craig playback", async ({
    locale,
    participantId,
    prompt,
    recordingId,
  }) => {
    const activeRuntime = requireRuntime(runtime);
    const meetingId = recordingId;
    const turnId = `participant-greeting:${participantId}`;
    const harness = await openPlaybackHarness(recordingId);
    const coordinator = new ConversationCoordinator({
      playback: harness.playback,
      runtime: activeRuntime,
    });
    const startedAtMilliseconds = performance.now();

    try {
      await expect(coordinator.handleProactiveTurn({
        interruptible: false,
        locale,
        literalSpeech: prompt,
        meetingId,
        nowMs: 1,
        prompt,
        recordingId,
        speakerId: participantId,
        systemPrompt: [
          "Speak exactly the greeting provided by the user.",
          "Do not add, remove, translate, explain, or quote anything.",
          "Return only the greeting itself.",
        ].join(" "),
        turnId,
        voiceProfileId: request.voiceProfileId,
      })).resolves.toMatchObject({
        prompt,
        status: "active",
      });
      await coordinator.whenIdle(meetingId);
      await expect(coordinator.whenTurnPlaybackSettled(meetingId, turnId))
        .resolves.toBe("played");
      try {
        await waitForCondition(() =>
          harness.commands.some((command) => command.type === "playback-finish"),
        );
      } catch (error) {
        throw new Error(
          [
            `Greeting playback did not finish; commands=${JSON.stringify(
              harness.commands.map((command) =>
                command.type === "audio-chunk"
                  ? {
                      attemptId: command.attemptId,
                      pcmBase64Length: command.pcmBase64.length,
                      recordingId: command.recordingId,
                      sequence: command.sequence,
                      turnId: command.turnId,
                      type: command.type,
                    }
                  : command
              ),
            )}`,
            `sidecar=${`${stdout}\n${stderr}`.slice(-4_000)}`,
          ].join("\n"),
          { cause: error },
        );
      }

      expect(harness.commands[0]).toMatchObject({
        recordingId,
        turnId,
        type: "playback-start",
      });
      const audioCommands = harness.commands.filter(
        (command): command is Extract<CraigPlaybackCommand, { type: "audio-chunk" }> =>
          command.type === "audio-chunk",
      );
      expect(audioCommands.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]);
      expect(audioCommands.every(({ pcmBase64 }) => pcmBase64.length > 0)).toBe(true);
      expect(harness.commands.at(-1)).toMatchObject({
        recordingId,
        turnId,
        type: "playback-finish",
      });
      expect(harness.firstAudioAtMilliseconds()).toBeDefined();
      expect(
        harness.firstAudioAtMilliseconds()! - startedAtMilliseconds,
      ).toBeLessThan(1_500);
      await coordinator.closeMeeting(meetingId, Math.floor(performance.now()));
    } finally {
      await harness.close();
    }
  }, 15_000);

  it.each(["ru", "en"] as const)(
    "streams the shipped %s farewell PCM through real Craig playback without invoking the runtime",
    async (locale) => {
      const recordingId = `recording-farewell-${locale}`;
      const meetingId = `meeting-farewell-${locale}`;
      const turnId = "meeting-farewell:v1";
      const playbackAttemptId = `farewell-e2e-${locale}`;
      const asset = await loadFarewellAsset(locale);
      const harness = await openPlaybackHarness(recordingId);
      let runtimeStartCalls = 0;
      const forbiddenRuntime: ConversationRuntime = {
        startTurn: () => {
          runtimeStartCalls += 1;
          return Promise.reject(new Error("Prepared farewell unexpectedly invoked the runtime"));
        },
      };
      const coordinator = new ConversationCoordinator({
        playback: harness.playback,
        runtime: forbiddenRuntime,
      });

      try {
        await expect(coordinator.playPreparedCue({
          cueId: asset.cueId,
          locale,
          meetingId,
          nowMs: 1,
          pcmChunks: splitPcmChunks(asset.bytes),
          playbackAttemptId,
          recordingId,
          speakerId: "farewell-system",
          turnId,
          voiceProfileId: "elevenlabs-multilingual",
        })).resolves.toMatchObject({ status: "active" });
        await coordinator.whenIdle(meetingId);
        await expect(coordinator.whenTurnPlaybackSettled(meetingId, turnId))
          .resolves.toBe("played");
        await waitForCondition(() =>
          harness.commands.some((command) => command.type === "playback-finish"),
        );

        expect(runtimeStartCalls).toBe(0);
        expect(harness.commands[0]).toMatchObject({
          attemptId: playbackAttemptId,
          recordingId,
          turnId,
          type: "playback-start",
        });
        const audioCommands = harness.commands.filter(
          (command): command is Extract<CraigPlaybackCommand, { type: "audio-chunk" }> =>
            command.type === "audio-chunk",
        );
        expect(audioCommands.map(({ sequence }) => sequence)).toEqual(
          Array.from({ length: audioCommands.length }, (_, index) => index),
        );
        const playedPcm = Buffer.concat(
          audioCommands.map(({ pcmBase64 }) => Buffer.from(pcmBase64, "base64")),
        );
        expect(playedPcm).toEqual(Buffer.from(asset.bytes));
        expect(createHash("sha256").update(playedPcm).digest("hex")).toBe(
          asset.sha256,
        );
        expect(harness.commands.at(-1)).toMatchObject({
          attemptId: playbackAttemptId,
          recordingId,
          turnId,
          type: "playback-finish",
        });
        await coordinator.closeMeeting(meetingId, Math.floor(performance.now()));
      } finally {
        await harness.close();
      }
    },
    15_000,
  );
});

interface PlaybackHarness {
  readonly commands: CraigPlaybackCommand[];
  close(): Promise<void>;
  firstAudioAtMilliseconds(): number | undefined;
  readonly playback: CraigPlaybackGateway;
}

async function openPlaybackHarness(recordingId: string): Promise<PlaybackHarness> {
  const playback = new CraigPlaybackGateway();
  const httpServer = createHttpServer((_request, response) => {
    response.writeHead(404).end();
  });
  const playbackServer = attachCraigPlaybackWebSocketServer(httpServer, {
    bearerToken: serviceToken,
    gateway: playback,
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Craig E2E WebSocket server did not expose a TCP address");
  }
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/craig/playback`, {
    headers: { authorization: `Bearer ${serviceToken}` },
  });
  const commands: CraigPlaybackCommand[] = [];
  let firstAudioAt: number | undefined;
  socket.on("message", (raw) => {
    const command = JSON.parse(webSocketText(raw)) as CraigPlaybackCommand;
    commands.push(command);
    if (command.type === "audio-chunk" && firstAudioAt === undefined) {
      firstAudioAt = performance.now();
      socket.send(JSON.stringify({
        schemaVersion: 1,
        type: "playback-started",
        recordingId: command.recordingId,
        turnId: command.turnId,
        attemptId: command.attemptId,
        startedAtMs: Date.now(),
      }));
    }
    if (command.type === "playback-finish") {
      socket.send(JSON.stringify({
        schemaVersion: 1,
        type: "playback-finished",
        recordingId: command.recordingId,
        turnId: command.turnId,
        attemptId: command.attemptId,
        finishedAtMs: Date.now(),
      }));
    }
  });
  await once(socket, "open");
  socket.send(JSON.stringify({
    schemaVersion: 1,
    type: "session-ready",
    recordingId,
    guildId: "1533228590643155034",
    channelId: "1533228823045214398",
    gatewaySessionId: `gateway-${recordingId}`,
  }));
  await waitForCondition(() => playback.hasSession(recordingId));

  return {
    commands,
    close: async () => {
      socket.terminate();
      playback.close();
      await playbackServer.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
    firstAudioAtMilliseconds: () => firstAudioAt,
    playback,
  };
}

interface FarewellAsset {
  readonly bytes: Uint8Array;
  readonly cueId: string;
  readonly sha256: string;
}

async function loadFarewellAsset(locale: "en" | "ru"): Promise<FarewellAsset> {
  const root = join(workspaceRoot, "apps/meeting-platform/assets/farewell-cues");
  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const descriptor = manifest[locale];
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    !("cueId" in descriptor) ||
    !("pcmFile" in descriptor) ||
    !("sha256" in descriptor) ||
    typeof descriptor.cueId !== "string" ||
    typeof descriptor.pcmFile !== "string" ||
    typeof descriptor.sha256 !== "string"
  ) {
    throw new Error(`Farewell E2E manifest entry ${locale} is invalid`);
  }
  const bytes = new Uint8Array(await readFile(join(root, descriptor.pcmFile)));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== descriptor.sha256) {
    throw new Error(`Farewell E2E asset ${locale} checksum does not match`);
  }
  return {
    bytes,
    cueId: descriptor.cueId,
    sha256: descriptor.sha256,
  };
}

function splitPcmChunks(bytes: Uint8Array): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 3_840) {
    chunks.push(bytes.slice(offset, offset + 3_840));
  }
  return chunks;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve a loopback port for Pipecat E2E");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  return port;
}

function requireRuntime(
  runtimeCandidate: GrpcPipecatConversationRuntime | undefined,
): GrpcPipecatConversationRuntime {
  if (runtimeCandidate === undefined) {
    throw new Error("Pipecat E2E runtime is not initialized");
  }
  return runtimeCandidate;
}

function webSocketText(raw: RawData): string {
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("E2E condition did not become true before timeout");
}

async function waitUntilServing(
  runtimeCandidate: GrpcPipecatConversationRuntime,
  processHandle: ChildProcessWithoutNullStreams,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + sidecarHealthTimeoutMilliseconds;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Pipecat sidecar exited before readiness:\n${diagnostics()}`);
    }
    try {
      const health = await runtimeCandidate.checkHealth();
      if (health.status === "serving") {
        return;
      }
    } catch {
      // The gRPC listener is still starting.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`Pipecat sidecar did not become ready:\n${diagnostics()}`);
}

async function waitUntilTcpListening(
  port: number,
  processHandle: ChildProcessWithoutNullStreams,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + sidecarBindTimeoutMilliseconds;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Pipecat sidecar exited before binding:\n${diagnostics()}`);
    }
    if (await canConnectToLoopback(port)) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`Pipecat sidecar did not bind its listener:\n${diagnostics()}`);
}

async function canConnectToLoopback(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean): void => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(250);
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
    socket.once("timeout", () => {
      finish(false);
    });
  });
}

async function collectWithTimeout(
  events: AsyncIterable<ConversationRuntimeEvent>,
): Promise<ConversationRuntimeEvent[]> {
  return await collectIteratorWithTimeout(events[Symbol.asyncIterator]());
}

async function collectIteratorWithTimeout(
  iterator: AsyncIterator<ConversationRuntimeEvent>,
): Promise<ConversationRuntimeEvent[]> {
  return await Promise.race([
    (async () => {
      const events: ConversationRuntimeEvent[] = [];
      for (;;) {
        const result = await iterator.next();
        if (result.done === true) {
          return events;
        }
        events.push(result.value);
      }
    })(),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Conversation event stream timed out"));
      }, 10_000);
      timer.unref();
    }),
  ]);
}

async function stopProcess(processHandle: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (processHandle === undefined || processHandle.exitCode !== null) {
    return;
  }
  const exited = once(processHandle, "exit");
  processHandle.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        processHandle.kill("SIGKILL");
        resolve();
      }, 5_000);
      timer.unref();
    }),
  ]);
}
