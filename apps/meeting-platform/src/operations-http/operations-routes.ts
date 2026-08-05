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
}
