import { once } from "node:events";
import type { IncomingMessage } from "node:http";

import { WebSocket, type RawData } from "ws";
import { expect } from "vitest";

const fetchTimeoutMs = 5_000;
const frameTimeoutMs = 5_000;

export class SocketMessages {
  readonly #queue: Array<Record<string, unknown>> = [];
  readonly #waiters: Array<(message: Record<string, unknown>) => void> = [];
  readonly #socket: WebSocket;
  readonly #listener: (data: RawData, isBinary: boolean) => void;

  public constructor(socket: WebSocket) {
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

  public async nextJson(): Promise<Record<string, unknown>> {
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
      }, frameTimeoutMs);
      this.#waiters.push(waiter);
    });
  }

  public dispose(): void {
    this.#socket.off("message", this.#listener);
  }
}

export async function openWebSocket(endpoint: URL, token: string): Promise<WebSocket> {
  const socket = new WebSocket(endpoint, {
    handshakeTimeout: frameTimeoutMs,
    headers: { authorization: `Bearer ${token}` },
  });
  await once(socket, "open", { signal: AbortSignal.timeout(frameTimeoutMs) });
  return socket;
}

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

export async function sendSocket(socket: WebSocket, payload: string | Buffer): Promise<void> {
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

export async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  socket.close(1_000);
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
    timeoutResult(frameTimeoutMs).then(() => "timeout" as const),
  ]);
  if (outcome === "timeout") {
    socket.terminate();
  } else if (outcome === "error") {
    throw new Error("gateway WebSocket failed during orderly close");
  }
}

export async function expectBoundedSocketRejection(socket: WebSocket): Promise<void> {
  const outcome = await Promise.race([
    once(socket, "message", { signal: AbortSignal.timeout(frameTimeoutMs) })
      .then(([data, isBinary]) => ({ data: data as RawData, isBinary: Boolean(isBinary), type: "message" as const })),
    once(socket, "close", { signal: AbortSignal.timeout(frameTimeoutMs) })
      .then(() => ({ type: "close" as const })),
  ]);
  if (outcome.type === "message") {
    expect(outcome.isBinary).toBe(false);
    const message = asObject(JSON.parse(outcome.data.toString()) as unknown);
    expect(message).toEqual({
      code: "TRANSPORT_CLOSED",
      message: "Live transport closed",
      type: "error",
    });
    await once(socket, "close", { signal: AbortSignal.timeout(frameTimeoutMs) });
  }
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

export function expectExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  expect(Object.keys(value).toSorted()).toEqual(keys.toSorted());
}

export function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected JSON object");
  }
  return value as Record<string, unknown>;
}

export function requiredObject(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return asObject(value[key]);
}

export function requiredArray(value: Record<string, unknown>, key: string): unknown[] {
  const member = value[key];
  if (!Array.isArray(member)) {
    throw new Error(`expected ${key} to be an array`);
  }
  return member;
}

export function requiredString(value: Record<string, unknown>, key: string): string {
  const member = value[key];
  if (typeof member !== "string") {
    throw new Error(`expected ${key} to be a string`);
  }
  return member;
}

export function expectTimestampPair(
  value: Record<string, unknown>,
  start: string,
  end: string,
): void {
  expectNonNegativeNumber(value[start]);
  expectPositiveNumber(value[end]);
  expect(value[end] as number).toBeGreaterThanOrEqual(value[start] as number);
}

export function expectPositiveNumber(value: unknown): void {
  expect(typeof value).toBe("number");
  expect(value as number).toBeGreaterThan(0);
}

export function expectNonNegativeNumber(value: unknown): void {
  expect(typeof value).toBe("number");
  expect(value as number).toBeGreaterThanOrEqual(0);
}

async function timeoutResult(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}
