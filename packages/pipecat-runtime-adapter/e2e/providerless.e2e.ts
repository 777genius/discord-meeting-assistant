import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type ConversationRuntimeEvent,
} from "@discord-meeting/meeting-core/conversation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";

import { GrpcPipecatConversationRuntime } from "../src/index.js";

const serviceToken = "providerless-e2e-token-123";
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sidecarRoot = join(workspaceRoot, "apps/pipecat-runtime");

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

describe("Node to Python providerless conversation E2E", () => {
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
  }, 180_000);

  afterAll(async () => {
    if (runtime !== undefined) {
      runtime.close();
    }
    await stopProcess(sidecar);
    if (temporaryRoot !== undefined) {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

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
    await started.value.cancel("barge-in");
    const remaining = await collectIteratorWithTimeout(iterator);
    expect(remaining.at(-1)).toMatchObject({
      type: "cancelled",
      reason: "barge-in",
    });
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
    const pcmChunks: Uint8Array[] = [];
    let firstAudioAtMilliseconds: number | undefined;
    socket.on("message", (raw) => {
      const command = JSON.parse(webSocketText(raw)) as CraigPlaybackCommand;
      commands.push(command);
      if (command.type === "audio-chunk") {
        pcmChunks.push(Buffer.from(command.pcmBase64, "base64"));
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
      expect(pcmChunks.every(({ byteLength }) => byteLength > 0)).toBe(true);
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
});

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
  runtime: GrpcPipecatConversationRuntime | undefined,
): GrpcPipecatConversationRuntime {
  if (runtime === undefined) {
    throw new Error("Pipecat E2E runtime is not initialized");
  }
  return runtime;
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
  runtime: GrpcPipecatConversationRuntime,
  processHandle: ChildProcessWithoutNullStreams,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Pipecat sidecar exited before readiness:\n${diagnostics()}`);
    }
    try {
      const health = await runtime.checkHealth();
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
  const deadline = Date.now() + 150_000;
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
