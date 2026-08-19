import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  DiscordIdentityProbeTarget,
  DiscordRoleIdentityExpectation,
  DiscordRoleIdentityProbe,
} from "./hosted-discord-identity-producer.js";
import type {
  BoundedRemoteContainerProcessPort,
  BoundedRemoteContainerProcessResult,
  HostedRemoteDiscordProbeBinding,
} from "./hosted-remote-discord-identity-probe.js";

const maximumOutputBytes = 16_384;
const defaultTimeoutMs = 10_000;
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const discordIdSchema = z.string().regex(/^\d{17,20}$/u);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const secretPath = "/run/secrets/discord_bot_token";
const discordIdentityProofScript = String.raw`
import { lstat, readFile } from "node:fs/promises";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error("Missing pinned identity proof input");
  return value;
};
if (required("CRAIG_E2E_TEST_ONLY") !== "true") throw new Error("Identity proof is test-only");
const tokenPath = required("DISCORD_BOT_TOKEN_FILE");
const applicationId = required("DISCORD_APPLICATION_ID");
const guildId = required("CRAIG_E2E_DISCORD_GUILD_ID");
const channelIds = required("CRAIG_E2E_DISCORD_CHANNEL_IDS").split(",");
if (tokenPath !== "/run/secrets/discord_bot_token" || channelIds.length !== 2) {
  throw new Error("Identity proof target is not pinned");
}
const before = await lstat(tokenPath);
if (!before.isFile() || before.isSymbolicLink() || before.uid !== 10001 || before.gid !== 10001
  || (before.mode & 0o777) !== 0o400) throw new Error("Craig token custody is invalid");
const token = (await readFile(tokenPath, "utf8")).trim();
const get = async (path) => {
  const response = await fetch("https://discord.com/api/v10" + path, {
    headers: { authorization: "Bot " + token },
  });
  if (!response.ok) throw new Error("Discord identity request failed");
  return response.json();
};
const [bot, guild, ...channels] = await Promise.all([
  get("/users/@me"), get("/guilds/" + guildId), ...channelIds.map((id) => get("/channels/" + id)),
]);
if (bot.id !== applicationId || bot.bot !== true || guild.id !== guildId
  || channels.some((channel, index) => channel.id !== channelIds[index] || channel.guild_id !== guildId)) {
  throw new Error("Discord identity proof does not match the pinned target");
}
const after = await lstat(tokenPath);
const tokenAfter = (await readFile(tokenPath, "utf8")).trim();
const stable = before.dev === after.dev && before.ino === after.ino && before.size === after.size
  && before.mtimeMs === after.mtimeMs && token === tokenAfter;
console.log(JSON.stringify({
  bot: { bot: true, id: bot.id }, ok: true, schemaVersion: 1,
  secret: { gid: after.gid, mode: "0400", path: tokenPath, stable, uid: after.uid },
  target: { channelIds, guildId, testOnly: true },
}));
`;

const outputSchema = z.object({
  bot: z.object({ bot: z.literal(true), id: discordIdSchema }).strict(),
  ok: z.literal(true),
  schemaVersion: z.literal(1),
  secret: z.object({
    gid: z.literal(10_001),
    mode: z.literal("0400"),
    path: z.literal(secretPath),
    stable: z.literal(true),
    uid: z.literal(10_001),
  }).strict(),
  target: z.object({
    channelIds: z.array(discordIdSchema).min(1).max(16),
    guildId: discordIdSchema,
    testOnly: z.literal(true),
  }).strict(),
}).strict();

export class HostedRemoteCraigIdentityProbe implements DiscordRoleIdentityProbe {
  readonly #binding: HostedRemoteDiscordProbeBinding;

  public constructor(
    private readonly process: BoundedRemoteContainerProcessPort,
    binding: HostedRemoteDiscordProbeBinding,
    private readonly timeoutMs = defaultTimeoutMs,
  ) {
    this.#binding = Object.freeze(z.object({
      containerId: identifierSchema,
      host: identifierSchema,
      imageDigestSha256: sha256Schema,
      sourceRevision: sourceRevisionSchema,
    }).strict().parse(binding));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Remote Craig identity probe timeout must be a positive safe integer");
    }
  }

  public async probe(
    expectation: DiscordRoleIdentityExpectation,
    target: DiscordIdentityProbeTarget,
    signal?: AbortSignal,
  ): Promise<{
    readonly applicationId: string;
    readonly authenticatedUserId: string;
    readonly bot: true;
    readonly tokenFile: Readonly<{
      account: "botik-playback";
      generationId: string;
      mode: 0o400;
      ownerUid: number;
      path: string;
      scope: "remote-deployment-secret";
    }>;
    readonly verificationSource: "discord-current-application-and-user";
  }> {
    assertExpectation(expectation);
    signal?.throwIfAborted();
    const result = await this.process.execute({
      args: buildArgs(expectation, target),
      binding: this.#binding,
      maximumOutputBytes,
      ...(signal === undefined ? {} : { signal }),
      target: {
        composeProject: "craig-meeting-e2e",
        composeService: "bot",
        workingDirectory: "/app/apps/bot",
      },
      timeoutMs: this.timeoutMs,
    });
    assertSuccessfulProcess(result);
    const output = outputSchema.parse(parseCanonicalJsonLine(result.stdout));
    const channelIds = [target.voiceChannelId, target.publicationChannelId];
    if (output.bot.id !== expectation.applicationId
      || output.target.guildId !== target.guildId
      || JSON.stringify(output.target.channelIds) !== JSON.stringify(channelIds)) {
      throw new Error("Remote Craig identity result does not match the pinned application or target");
    }
    return Object.freeze({
      applicationId: expectation.applicationId,
      authenticatedUserId: output.bot.id,
      bot: true as const,
      tokenFile: {
        account: "botik-playback" as const,
        generationId: generationId(this.#binding, output),
        mode: 0o400 as const,
        ownerUid: expectation.tokenFile.ownerUid,
        path: expectation.tokenFile.path,
        scope: "remote-deployment-secret" as const,
      },
      verificationSource: "discord-current-application-and-user" as const,
    });
  }
}

function buildArgs(
  expectation: DiscordRoleIdentityExpectation,
  target: DiscordIdentityProbeTarget,
): readonly string[] {
  return Object.freeze([
    "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin",
    "CRAIG_E2E_TEST_ONLY=true",
    `DISCORD_APPLICATION_ID=${expectation.applicationId}`,
    `CRAIG_E2E_DISCORD_GUILD_ID=${target.guildId}`,
    `CRAIG_E2E_DISCORD_CHANNEL_IDS=${target.voiceChannelId},${target.publicationChannelId}`,
    `DISCORD_BOT_TOKEN_FILE=${secretPath}`,
    "/usr/local/bin/node", "--input-type=module", "--eval", discordIdentityProofScript,
  ]);
}

function assertExpectation(expectation: DiscordRoleIdentityExpectation): void {
  if (expectation.tokenFile.account !== "botik-playback"
    || expectation.tokenFile.scope !== "remote-deployment-secret"
    || expectation.tokenFile.path !== secretPath
    || expectation.tokenFile.ownerUid !== 10_001) {
    throw new Error("Remote Craig identity probe requires the pinned Craig token custody");
  }
}

function assertSuccessfulProcess(result: BoundedRemoteContainerProcessResult): void {
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maximumOutputBytes) {
    throw new Error("Remote Craig identity probe output exceeded 16 KiB");
  }
  if (result.timedOut || result.signal !== null || result.exitCode !== 0 || result.stderr.length !== 0) {
    throw new Error("Remote Craig identity probe process failed");
  }
}

function parseCanonicalJsonLine(stdout: string): unknown {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") {lines.pop();}
  if (lines.length !== 1 || lines[0] === undefined || lines[0].length === 0
    || lines[0].startsWith("\uFEFF")) {
    throw new Error("Remote Craig identity probe returned a non-canonical output envelope");
  }
  try {
    return JSON.parse(lines[0]) as unknown;
  } catch (error) {
    throw new Error("Remote Craig identity probe returned invalid JSON", { cause: error });
  }
}

function generationId(
  binding: HostedRemoteDiscordProbeBinding,
  output: z.infer<typeof outputSchema>,
): string {
  return `craig-${createHash("sha256").update(JSON.stringify({ binding, output })).digest("hex")}`;
}
