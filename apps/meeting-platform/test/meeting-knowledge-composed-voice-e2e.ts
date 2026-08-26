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
  type GroundedKnowledgeAnswerPort,
} from "@discord-meeting/meeting-core/conversation";
import { GrpcPipecatConversationRuntime } from "@discord-meeting/pipecat-runtime-adapter";
import { expect } from "vitest";
import { WebSocket } from "ws";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sidecarRoot = join(workspaceRoot, "apps/pipecat-runtime");
const serviceToken = "composed-grounded-voice-e2e-token";
const sidecarBindTimeoutMs = 360_000;
const sidecarHealthTimeoutMs = 30_000;
const authorizedTurnId = "grounded-authorized";
const bargeInTurnId = "grounded-barge-in";

export async function proveComposedGroundedVoice(input: {
  readonly validatedAnswerCount: () => number;
  readonly groundedAnswers: GroundedKnowledgeAnswerPort;
  readonly meetingId: string;
  readonly participantId: string;
  readonly question: string;
  readonly roomId: string;
}): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "meeting-composed-voice-e2e-"));
  const tokenFile = join(temporaryRoot, "runtime-token");
  await writeFile(tokenFile, `${serviceToken}\n`, { mode: 0o600 });
  let sidecar: ChildProcessWithoutNullStreams | undefined;
  let sidecarOutput = "";
  let runtime: GrpcPipecatConversationRuntime | undefined;
  let playback: CraigPlaybackGateway | undefined;
  let playbackClockMs = 1_000;
  let playbackServer: Awaited<ReturnType<typeof attachCraigPlaybackWebSocketServer>> | undefined;
  let coordinator: ConversationCoordinator | undefined;
  const httpServer = createHttpServer((_request, response) => {
    response.writeHead(404).end();
  });
  let socket: WebSocket | undefined;
  try {
    const sidecarPort = await reserveLoopbackPort();
    sidecar = spawn("uv", ["run", "--frozen", "pipecat-runtime"], {
      cwd: sidecarRoot,
      env: {
        ...process.env,
        PIPECAT_RUNTIME_BEARER_TOKEN_FILE: tokenFile,
        PIPECAT_RUNTIME_BIND_HOST: "127.0.0.1",
        PIPECAT_RUNTIME_BIND_PORT: String(sidecarPort),
        PIPECAT_RUNTIME_DETERMINISTIC_AUDIO_DELAY_MS: "1100",
        PIPECAT_RUNTIME_DETERMINISTIC_TEXT_DELAY_MS: "25",
        PIPECAT_RUNTIME_ENVIRONMENT: "test",
        PIPECAT_RUNTIME_PROFILE: "deterministic-e2e",
        PIPECAT_RUNTIME_PROFILE_ID: "deterministic-e2e",
      },
      stdio: "pipe",
    });
    const recordSidecarOutput = (chunk: Buffer): void => {
      sidecarOutput = `${sidecarOutput}${chunk.toString("utf8")}`.slice(-32_768);
    };
    sidecar.stdout.on("data", recordSidecarOutput);
    sidecar.stderr.on("data", recordSidecarOutput);
    sidecar.on("error", (error) => {
      sidecarOutput = `${sidecarOutput}\n${error.message}`.slice(-32_768);
    });
    await waitUntilTcpListening(sidecarPort, sidecar, () => sidecarOutput);
    runtime = new GrpcPipecatConversationRuntime({
      address: `127.0.0.1:${sidecarPort}`,
      serviceToken,
    });
    await waitUntilServing(runtime, sidecar, () => sidecarOutput);

    playback = new CraigPlaybackGateway(() => playbackClockMs);
    playbackServer = attachCraigPlaybackWebSocketServer(httpServer, {
      bearerToken: serviceToken,
      gateway: playback,
    });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("composed Craig playback server did not expose a TCP address");
    }
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/craig/playback`, {
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    const commands: CraigPlaybackCommand[] = [];
    const startedAttempts = new Set<string>();
    let unauthorizedPcmObserved = false;
    socket.addEventListener("message", (event) => {
      const message = typeof event.data === "string"
        ? event.data
        : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      const command = JSON.parse(message) as CraigPlaybackCommand;
      commands.push(command);
      if (command.type === "audio-chunk") {
        const expectedAnswers = command.turnId ===
            bargeInTurnId
          ? 2
          : 1;
        unauthorizedPcmObserved ||= input.validatedAnswerCount() < expectedAnswers;
        if (!startedAttempts.has(command.attemptId)) {
          startedAttempts.add(command.attemptId);
          socket?.send(JSON.stringify({
            attemptId: command.attemptId,
            recordingId: command.recordingId,
            schemaVersion: 1,
            startedAtMs: playbackClockMs,
            turnId: command.turnId,
            type: "playback-started",
          }));
        }
      }
      if (command.type === "playback-finish") {
        socket?.send(JSON.stringify({
          attemptId: command.attemptId,
          finishedAtMs: Date.now(),
          recordingId: command.recordingId,
          schemaVersion: 1,
          turnId: command.turnId,
          type: "playback-finished",
        }));
      }
      if (command.type === "playback-cancel") {
        socket?.send(JSON.stringify({
          attemptId: command.attemptId,
          finishedAtMs: Date.now(),
          recordingId: command.recordingId,
          schemaVersion: 1,
          turnId: command.turnId,
          type: "playback-finished",
        }));
      }
    });
    await waitForSocketOpen(socket);
    const recordingId = `recording-${input.meetingId}`;
    socket.send(JSON.stringify({
      channelId: input.roomId,
      gatewaySessionId: "gateway-composed-grounded-voice-e2e",
      guildId: "333333333333333333",
      recordingId,
      schemaVersion: 3,
      type: "session-ready",
      playbackCapabilities: {
        attestsDiscordVoiceSend: true,
        deduplicatesCommandIds: true,
        deduplicationRetentionSeconds: 300,
        replaysOriginalStartedAtMs: true,
      },
    }));
    await waitForCondition(() => playback?.hasSession(recordingId) === true);

    coordinator = new ConversationCoordinator({
      groundedAnswers: input.groundedAnswers,
      playback,
      runtime,
    });
    const firstTurnId = authorizedTurnId;
    const firstWakeAtMs = playbackClockMs;
    await expect(coordinator.handleFinalizedTurn({
      locale: "en-US",
      meetingId: input.meetingId,
      nowMs: firstWakeAtMs,
      recordingId,
      roomId: input.roomId,
      speakerId: input.participantId,
      systemPrompt: "Speak only the complete validated grounded answer.",
      text: `Botik, ${input.question}`,
      thinkingCueLocale: "en-US",
      transcriptEndMs: firstWakeAtMs - 100,
      transcriptStartMs: firstWakeAtMs - 600,
      turnId: firstTurnId,
      voiceProfileId: "deterministic-e2e",
    })).resolves.toMatchObject({ status: "active" });
    await coordinator.whenIdle(input.meetingId);
    expect(input.validatedAnswerCount()).toBe(1);
    await expect(coordinator.whenTurnPlaybackSettled(input.meetingId, firstTurnId))
      .resolves.toBe("played");
    await waitForCondition(() => commands.some((command) =>
      command.turnId === firstTurnId && command.type === "playback-finish"
    ));
    expect(commands.filter((command) =>
      command.turnId === firstTurnId && command.type === "audio-chunk"
    )).toHaveLength(5);
    expect(unauthorizedPcmObserved).toBe(false);

    const interruptedTurnId = bargeInTurnId;
    playbackClockMs = 2_000;
    await expect(coordinator.handleFinalizedTurn({
      locale: "en-US",
      meetingId: input.meetingId,
      nowMs: playbackClockMs,
      recordingId,
      roomId: input.roomId,
      speakerId: input.participantId,
      systemPrompt: "Speak only the complete validated grounded answer.",
      text: `Botik, ${input.question}`,
      thinkingCueLocale: "en-US",
      transcriptEndMs: 2_000,
      transcriptStartMs: 1_500,
      turnId: interruptedTurnId,
      voiceProfileId: "deterministic-e2e",
    })).resolves.toMatchObject({ status: "active" });
    await waitForCondition(() => commands.some((command) =>
      command.turnId === interruptedTurnId && command.type === "audio-chunk"
    ));
    await expect(coordinator.whenTurnPlaybackStarted(
      input.meetingId,
      interruptedTurnId,
    )).resolves.toEqual({
      startedAtMs: playbackClockMs,
      status: "started",
    });
    const cancellation = await coordinator.speechStarted(
      input.meetingId,
      playbackClockMs + 4_100,
    );
    expect(cancellation).toMatchObject({ status: "cancel-requested" });
    await waitForCondition(() => commands.some((command) =>
      command.turnId === interruptedTurnId && command.type === "playback-cancel"
    ));
    const pcmCountAfterCancellation = commands.filter((command) =>
      command.turnId === interruptedTurnId && command.type === "audio-chunk"
    ).length;
    await coordinator.whenIdle(input.meetingId);
    await wait(1_250);
    expect(commands.filter((command) =>
      command.turnId === interruptedTurnId && command.type === "audio-chunk"
    )).toHaveLength(pcmCountAfterCancellation);
    expect(commands.some((command) =>
      command.turnId === interruptedTurnId && command.type === "playback-finish"
    )).toBe(false);
    expect(unauthorizedPcmObserved).toBe(false);
    await coordinator.closeMeeting(input.meetingId, playbackClockMs + 4_100);
  } finally {
    await coordinator?.close(Date.now());
    socket?.terminate();
    playback?.close();
    await playbackServer?.close();
    if (httpServer.listening) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
      });
    }
    runtime?.close();
    await stopProcess(sidecar);
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function waitUntilServing(
  runtime: GrpcPipecatConversationRuntime,
  sidecar: ChildProcessWithoutNullStreams,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + sidecarHealthTimeoutMs;
  while (Date.now() < deadline) {
    assertSidecarRunning(sidecar, diagnostics);
    try {
      if ((await runtime.checkHealth()).status === "serving") {
        return;
      }
    } catch {
      // The listener is still starting.
    }
    await wait(50);
  }
  throw new Error(`Pipecat sidecar did not become ready:\n${diagnostics()}`);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve a loopback port for composed voice E2E");
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

async function waitUntilTcpListening(
  port: number,
  sidecar: ChildProcessWithoutNullStreams,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + sidecarBindTimeoutMs;
  while (Date.now() < deadline) {
    assertSidecarRunning(sidecar, diagnostics);
    if (await canConnectToLoopback(port)) {
      return;
    }
    await wait(50);
  }
  throw new Error(`Pipecat sidecar did not bind its listener:\n${diagnostics()}`);
}

function assertSidecarRunning(
  sidecar: ChildProcessWithoutNullStreams,
  diagnostics: () => string,
): void {
  if (
    sidecar.pid === undefined ||
    sidecar.exitCode !== null ||
    sidecar.signalCode !== null
  ) {
    throw new Error(`Pipecat sidecar exited before readiness:\n${diagnostics()}`);
  }
}

async function canConnectToLoopback(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const connection = createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean): void => {
      connection.destroy();
      resolve(connected);
    };
    connection.setTimeout(250);
    connection.once("connect", () => {
      finish(true);
    });
    connection.once("error", () => {
      finish(false);
    });
    connection.once("timeout", () => {
      finish(false);
    });
  });
}

async function stopProcess(
  sidecar: ChildProcessWithoutNullStreams | undefined,
): Promise<void> {
  if (sidecar === undefined || sidecar.exitCode !== null || sidecar.signalCode !== null) {
    return;
  }
  sidecar.kill("SIGTERM");
  if (await waitForProcessExit(sidecar, 5_000)) {
    return;
  }
  sidecar.kill("SIGKILL");
  if (!await waitForProcessExit(sidecar, 5_000)) {
    throw new Error("Pipecat sidecar did not exit after SIGKILL");
  }
}

async function waitForProcessExit(
  sidecar: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (sidecar.exitCode !== null || sidecar.signalCode !== null) {
    return true;
  }
  return await Promise.race([
    once(sidecar, "exit").then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      timer.unref();
    }),
  ]);
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      reject(new Error("Craig socket failed"));
    }, {
      once: true,
    });
  });
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await wait(10);
  }
  throw new Error("composed voice condition did not become true before timeout");
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
