import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";

import {
  attachCraigPlaybackWebSocketServer,
  CraigPlaybackGateway,
  type CraigPlaybackWebSocketServer,
} from "../src/index.js";

const token = "test-craig-playback-token";
const resources: { server: Server; playback: CraigPlaybackWebSocketServer }[] = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ playback, server }) => {
      await playback.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }),
  );
});

async function start() {
  const gateway = new CraigPlaybackGateway();
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const playback = attachCraigPlaybackWebSocketServer(server, {
    bearerToken: token,
    gateway,
  });
  resources.push({ playback, server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { gateway, url: `ws://127.0.0.1:${address.port}/v1/craig/playback` };
}

function connect(url: string, authorization?: string): WebSocket {
  return authorization === undefined
    ? new WebSocket(url)
    : new WebSocket(url, { headers: { authorization } });
}

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(rawDataToUtf8(data));
    });
  });
}

function waitForUnexpectedResponse(socket: WebSocket): Promise<IncomingMessage> {
  return new Promise((resolve) => {
    socket.once("unexpected-response", (_request, response) => {
      resolve(response);
    });
  });
}

function waitForCloseCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => {
      resolve(code);
    });
  });
}

function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

describe("Craig playback WebSocket server", () => {
  it("authenticates, registers session-ready, and carries strict commands/events", async () => {
    const context = await start();
    const socket = connect(context.url, `Bearer ${token}`);
    await once(socket, "open");
    socket.send(JSON.stringify({
      schemaVersion: 1,
      type: "session-ready",
      recordingId: "recording-1",
      guildId: "1533228590643155034",
      channelId: "1533228823045214398",
      gatewaySessionId: "gateway-session-1",
    }));
    await expect.poll(() => context.gateway.hasSession("recording-1")).toBe(true);

    const command = waitForMessage(socket);
    const opened = await context.gateway.open({
      attemptId: "attempt-1",
      meetingId: "meeting-1",
      recordingId: "recording-1",
      turnId: "turn-1",
    });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    const raw = await command;
    expect(JSON.parse(raw) as unknown).toMatchObject({ type: "playback-start" });
    socket.close();
  });

  it("rejects missing bearer and invalid first messages", async () => {
    const context = await start();
    const unauthorized = connect(context.url);
    unauthorized.on("error", () => {});
    const unauthorizedError = waitForUnexpectedResponse(unauthorized);
    const response = await unauthorizedError;
    expect(response.statusCode).toBe(401);

    const invalid = connect(context.url, `Bearer ${token}`);
    await once(invalid, "open");
    const closed = waitForCloseCode(invalid);
    invalid.send(JSON.stringify({ schemaVersion: 1, type: "unknown" }));
    const code = await closed;
    expect(code).toBe(1008);
  });
});
