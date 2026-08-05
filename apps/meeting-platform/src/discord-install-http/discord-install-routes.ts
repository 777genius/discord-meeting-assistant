import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
} from "fastify";

import { sendJson } from "../http/http-response.js";

interface DiscordInstallUrls {
  readonly craig: string;
  readonly meetingPlatform: string;
}

export interface DiscordInstallRoutesOptions {
  readonly installUrls?: DiscordInstallUrls;
}

export function createDiscordInstallRoutesPlugin(
  options: DiscordInstallRoutesOptions,
): FastifyPluginCallback {
  return (app, _pluginOptions, done) => {
    registerDiscordInstallRoutes(app, options);
    done();
  };
}

function registerDiscordInstallRoutes(
  app: FastifyInstance,
  options: DiscordInstallRoutesOptions,
): void {
  app.get("/discord/install", (_request, reply) => {
    if (options.installUrls === undefined) {
      return sendJson(reply, 404, { code: "NOT_FOUND" });
    }
    return redirectToDiscord(reply, options.installUrls.meetingPlatform);
  });
  app.get("/discord/install/craig", (_request, reply) => {
    if (options.installUrls === undefined) {
      return sendJson(reply, 404, { code: "NOT_FOUND" });
    }
    return redirectToDiscord(reply, options.installUrls.craig);
  });
}

function redirectToDiscord(reply: FastifyReply, location: string) {
  const target = new URL(location);
  if (target.protocol !== "https:" || target.hostname !== "discord.com") {
    throw new Error("Discord install redirect must use https://discord.com");
  }
  return sendRedirect(reply, target.toString());
}

function sendRedirect(reply: FastifyReply, location: string): FastifyReply {
  return reply
    .code(302)
    .header("cache-control", "no-store")
    .header("location", location)
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .send();
}
