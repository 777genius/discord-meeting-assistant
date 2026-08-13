import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runHostedDiscordIdentityProbe } from "../src/run-hosted-discord-identity-probe.js";

const applicationId = "1534231284467896512";
const guildId = "1533228590643155034";
const voiceChannelId = "1533228823045214398";
const publicationChannelId = "1533228891827736657";
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true }))));

describe("container-internal hosted Discord identity probe", () => {
  it("uses the token only for exact Discord requests and emits non-secret custody metadata", async () => {
    const { path, token } = await tokenFixture();
    const fetchResponse = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.headers).toMatchObject({ authorization: `Bot ${token}` });
      return discordResponse(new URL(requestUrl(input)).pathname.replace("/api/v10", ""));
    });
    const result = await runHostedDiscordIdentityProbe(argv(path), { fetchResponse, openFile: open });

    expect(fetchResponse).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result).toMatchObject({
      authenticatedUserId: applicationId, bot: true,
      target: { guildId, publicationChannelId, voiceChannelId },
      tokenCustody: { mode: 0o400, ownerUid: process.getuid?.() ?? 0, path },
    });
  });

  it.each([
    ["wrong user", "/users/@me", { bot: true, id: "1534231284467896513" }],
    ["human user", "/users/@me", { bot: false, id: applicationId }],
    ["wrong guild", `/guilds/${guildId}`, { id: "1533228590643155035" }],
    ["wrong voice type", `/channels/${voiceChannelId}`, { guild_id: guildId, id: voiceChannelId, type: 0 }],
  ])("fails closed for %s", async (_label, replacedPath, replacedBody) => {
    const { path } = await tokenFixture();
    const fetchResponse = vi.fn<typeof fetch>(async (input) => {
      const requestPath = new URL(requestUrl(input)).pathname.replace("/api/v10", "");
      return response(requestPath === replacedPath ? replacedBody : discordBody(requestPath));
    });
    await expect(runHostedDiscordIdentityProbe(argv(path), { fetchResponse, openFile: open }))
      .rejects.toThrow();
  });

  it("rejects an unsafe token mode before contacting Discord", async () => {
    const { path } = await tokenFixture(0o640);
    const fetchResponse = vi.fn<typeof fetch>();
    await expect(runHostedDiscordIdentityProbe(argv(path), { fetchResponse, openFile: open }))
      .rejects.toThrow("unsafe");
    expect(fetchResponse).not.toHaveBeenCalled();
  });

  it("rejects token replacement during Discord verification", async () => {
    const { path } = await tokenFixture();
    let replaced = false;
    const fetchResponse = vi.fn<typeof fetch>(async (input) => {
      if (!replaced) {
        replaced = true;
        await chmod(path, 0o600);
        await writeFile(path, `replacement.${"y".repeat(80)}`, { mode: 0o400 });
        await chmod(path, 0o400);
      }
      return discordResponse(new URL(requestUrl(input)).pathname.replace("/api/v10", ""));
    });
    await expect(runHostedDiscordIdentityProbe(argv(path), { fetchResponse, openFile: open }))
      .rejects.toThrow("changed during");
  });
});

async function tokenFixture(mode = 0o400): Promise<{ path: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "discord-identity-probe-"));
  roots.push(root);
  const path = join(root, "botik-token");
  const token = `synthetic.${"x".repeat(80)}`;
  await writeFile(path, token, { mode: 0o400 });
  await chmod(path, mode);
  return { path, token };
}

function argv(tokenFile: string): readonly string[] {
  return [
    "--application-id", applicationId,
    "--token-file", tokenFile,
    "--token-owner-uid", String(process.getuid?.() ?? 0),
    "--guild-id", guildId,
    "--voice-channel-id", voiceChannelId,
    "--publication-channel-id", publicationChannelId,
    "--container-id", "platform-container-1",
    "--image-digest-sha256", "a".repeat(64),
    "--source-revision", "b".repeat(40),
    "--json",
  ];
}

function discordResponse(path: string): Response {return response(discordBody(path));}

function discordBody(path: string): unknown {
  if (path === "/users/@me") {return { bot: true, id: applicationId };}
  if (path === `/guilds/${guildId}`) {return { id: guildId };}
  if (path === `/channels/${voiceChannelId}`) {return { guild_id: guildId, id: voiceChannelId, type: 2 };}
  return { guild_id: guildId, id: publicationChannelId, type: 0 };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status: 200 });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}
