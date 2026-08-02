import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  parseAuthoritativeTrackUploadMetadata,
  parseCraigLifecycleEvent,
  parseVoicePacketBatch,
  type CraigLifecycleEvent,
  type AuthoritativeTrackUploadMetadata,
  type VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
import { RecordingIngressError } from "@discord-meeting/recording-ingress-adapter";
import { ZodError } from "zod";

const maximumBodyBytes = 4 * 1_024 * 1_024;

interface CraigIngressPort {
  ingestAuthoritativeTrack(
    metadata: AuthoritativeTrackUploadMetadata,
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ readonly replayed: boolean }>;
  ingestLifecycle(event: CraigLifecycleEvent): Promise<void>;
  ingestVoiceBatch(batch: VoicePacketBatch): Promise<void>;
}

interface PlatformHealthPort {
  metrics(): string;
  readiness(): Promise<{ readonly ready: boolean }>;
}

export interface CraigHttpServerOptions {
  readonly bearerToken: string;
  readonly health: PlatformHealthPort;
  readonly ingress: CraigIngressPort;
  readonly onInternalError?: (error: unknown) => void;
}

export function createCraigHttpServer(options: CraigHttpServerOptions): Server {
  if (options.bearerToken.length < 16) {
    throw new Error("Craig integration bearer token is too short");
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response, options).catch((error: unknown) => {
      options.onInternalError?.(error);
      sendJson(response, 500, { code: "INTERNAL_ERROR" });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 300_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CraigHttpServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://meeting-platform.internal");
  if (request.method === "GET" && url.pathname === "/livez") {
    sendJson(response, 200, { status: "live" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    const readiness = await options.health.readiness();
    sendJson(response, readiness.ready ? 200 : 503, {
      status: readiness.ready ? "ready" : "not_ready",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    if (!isAuthorized(request.headers.authorization, options.bearerToken)) {
      sendJson(response, 401, { code: "UNAUTHORIZED" });
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.end(options.health.metrics());
    return;
  }

  if (request.method !== "POST" || !isCraigPath(url.pathname)) {
    sendJson(response, 404, { code: "NOT_FOUND" });
    return;
  }
  if (!isAuthorized(request.headers.authorization, options.bearerToken)) {
    sendJson(response, 401, { code: "UNAUTHORIZED" });
    return;
  }
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  const authoritativeTrack = url.pathname === "/v1/craig/authoritative-tracks";
  if (contentType !== (authoritativeTrack ? "audio/ogg" : "application/json")) {
    sendJson(response, 415, { code: "CONTENT_TYPE_REQUIRED" });
    return;
  }

  try {
    if (authoritativeTrack) {
      const metadata = parseAuthoritativeTrackMetadataHeader(
        request.headers["x-craig-authoritative-track-metadata"],
      );
      const declaredLength = Number(request.headers["content-length"]);
      if (!Number.isSafeInteger(declaredLength) || declaredLength !== metadata.sizeBytes) {
        sendJson(response, 400, { code: "INVALID_CONTENT_LENGTH" });
        request.resume();
        return;
      }
      const result = await options.ingress.ingestAuthoritativeTrack(metadata, request);
      sendJson(response, result.replayed ? 200 : 201, {
        status: result.replayed ? "reused" : "accepted",
      });
      return;
    }
    const body = await readJsonBody(request);
    if (url.pathname === "/v1/craig/events") {
      await options.ingress.ingestLifecycle(parseCraigLifecycleEvent(body));
    } else {
      await options.ingress.ingestVoiceBatch(parseVoicePacketBatch(body));
    }
    sendJson(response, 202, { status: "accepted" });
  } catch (error: unknown) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, { code: "BODY_TOO_LARGE" });
    } else if (error instanceof SyntaxError || error instanceof ZodError) {
      sendJson(response, 400, { code: "INVALID_REQUEST" });
    } else if (error instanceof RecordingIngressError) {
      const status = recordingIngressStatus(error);
      if (status === undefined) {
        throw error;
      }
      sendJson(response, status, {
        code: status === 409 ? "INGRESS_CONFLICT" :
          status === 413 ? "INGRESS_LIMIT_EXCEEDED" : "INVALID_INGRESS_STATE",
      });
    } else {
      throw error;
    }
  }
}

function recordingIngressStatus(error: RecordingIngressError): 400 | 409 | 413 | undefined {
  switch (error.failure) {
    case "invalid-input":
    case "path-policy":
    case "unsupported-event":
      return 400;
    case "conflicting-duplicate":
    case "invalid-state":
      return 409;
    case "limit-exceeded":
      return 413;
    case "aborted":
    case "artifact-write-mismatch":
    case "corrupt-spool":
      return undefined;
  }
}

function isCraigPath(pathname: string): boolean {
  return (
    pathname === "/v1/craig/events" ||
    pathname === "/v1/craig/voice-packets" ||
    pathname === "/v1/craig/authoritative-tracks"
  );
}

function parseAuthoritativeTrackMetadataHeader(
  value: string | readonly string[] | undefined,
): AuthoritativeTrackUploadMetadata {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new SyntaxError("invalid authoritative track metadata header");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new SyntaxError("non-canonical authoritative track metadata header");
  }
  return parseAuthoritativeTrackUploadMetadata(
    JSON.parse(decoded.toString("utf8")) as unknown,
  );
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected);
}

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
    request.resume();
    throw new RequestBodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    received += chunk.byteLength;
    if (received > maximumBodyBytes) {
      request.destroy();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
