import type { FastifyReply } from "fastify";

export function sendJson(
  reply: FastifyReply,
  statusCode: number,
  body: unknown,
): FastifyReply {
  return reply
    .code(statusCode)
    .header("cache-control", "no-store")
    .header("content-type", "application/json; charset=utf-8")
    .header("x-content-type-options", "nosniff")
    .send(body);
}
