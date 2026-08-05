import { timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { sendJson } from "./http-response.js";

export function createBearerTokenGuard(token: string) {
  assertBearerToken(token);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isBearerTokenAuthorized(request.headers.authorization, token)) {
      sendJson(reply, 401, { code: "UNAUTHORIZED" });
    }
  };
}

export function isBearerTokenAuthorized(
  header: string | undefined,
  token: string,
): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return (
    provided.byteLength === expected.byteLength &&
    timingSafeEqual(provided, expected)
  );
}

export function assertBearerToken(token: string): void {
  if (token.length < 16) {
    throw new Error("HTTP bearer token is too short");
  }
}
