import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
} from "fastify";

import {
  assertBearerToken,
  createBearerTokenGuard,
} from "../http/fastify-bearer-auth.js";
import { sendJson } from "../http/http-response.js";

export interface PlatformHealthPort {
  metrics(): string;
  readiness(): Promise<{ readonly ready: boolean }>;
}

function sendMetrics(reply: FastifyReply, body: string): FastifyReply {
  return reply
    .code(200)
    .header("cache-control", "no-store")
    .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
    .header("x-content-type-options", "nosniff")
    .send(body);
}

export interface OperationsRoutesOptions {
  readonly bearerToken: string;
  readonly health: PlatformHealthPort;
  readonly historicalDeletion?: {
    requestMeetingDeletion(meetingId: string): Promise<void>;
  };
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

export function createOperationsRoutesPlugin(
  options: OperationsRoutesOptions,
): FastifyPluginCallback {
  assertBearerToken(options.bearerToken);
  return (app, _pluginOptions, done) => {
    registerOperationsRoutes(app, options);
    done();
  };
}

function registerOperationsRoutes(
  app: FastifyInstance,
  options: OperationsRoutesOptions,
): void {
  app.get("/livez", (_request, reply) => sendJson(reply, 200, { status: "live" }));
  app.get("/readyz", async (_request, reply) => {
    const readiness = await options.health.readiness();
    return sendJson(reply, readiness.ready ? 200 : 503, {
      status: readiness.ready ? "ready" : "not_ready",
    });
  });
  app.get(
    "/metrics",
    { onRequest: createBearerTokenGuard(options.bearerToken) },
    (_request, reply) => sendMetrics(reply, options.health.metrics()),
  );
  if (options.historicalDeletion !== undefined) {
    app.post<{ Params: { readonly meetingId: string } }>(
      "/internal/meeting-knowledge/history/deletions/:meetingId",
      { onRequest: createBearerTokenGuard(options.bearerToken) },
      async (request, reply) => {
        const meetingId = request.params.meetingId.normalize("NFKC").trim();
        if (
          meetingId.length < 1 ||
          meetingId.length > 1_024 ||
          containsControlCharacter(meetingId)
        ) {
          return sendJson(reply, 400, { code: "INVALID_MEETING_ID" });
        }
        await options.historicalDeletion?.requestMeetingDeletion(meetingId);
        return sendJson(reply, 202, { status: "accepted" });
      },
    );
  }
}
