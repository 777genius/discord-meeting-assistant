import { once } from "node:events";
import type { IncomingMessage } from "node:http";

import { WebSocket } from "ws";
import { expect } from "vitest";

const fetchTimeoutMs = 5_000;
const frameTimeoutMs = 5_000;

export async function expectUnauthenticatedWebSocketRejection(endpoint: URL): Promise<void> {
  const socket = new WebSocket(endpoint, { handshakeTimeout: frameTimeoutMs });
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
    timeoutResult(frameTimeoutMs).then(() => {
      socket.terminate();
      throw new Error("unauthenticated WebSocket did not fail boundedly");
    }),
  ]);
  expect(status).toBe(401);
}

export async function boundedFetch(input: URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(fetchTimeoutMs),
  });
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toMatch(/^application\/json(?:;|$)/);
  return asObject(await response.json());
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected JSON object");
  }
  return value as Record<string, unknown>;
}

async function timeoutResult(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}
