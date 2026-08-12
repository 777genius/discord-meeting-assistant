import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const revisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const maximumDiscordBodyBytes = 16_384;
const maximumTokenBytes = 4_096;

interface ProbeOptions {
  readonly applicationId: string;
  readonly containerId: string;
  readonly guildId: string;
  readonly imageDigestSha256: string;
  readonly publicationChannelId: string;
  readonly sourceRevision: string;
  readonly tokenFile: string;
  readonly tokenOwnerUid: number;
  readonly voiceChannelId: string;
}

export interface HostedDiscordIdentityProbeDependencies {
  readonly fetchResponse: typeof globalThis.fetch;
  readonly openFile: typeof open;
}

const defaultDependencies: HostedDiscordIdentityProbeDependencies = {
  fetchResponse: globalThis.fetch,
  openFile: open,
};

export async function runHostedDiscordIdentityProbe(
  argv: readonly string[],
  dependencies: HostedDiscordIdentityProbeDependencies = defaultDependencies,
): Promise<unknown> {
  const options = parseOptions(argv);
  const before = await readToken(options, dependencies.openFile);
  const [user, guild, voice, publication] = await Promise.all([
    getDiscordJson("/users/@me", before.secret, dependencies.fetchResponse),
    getDiscordJson(`/guilds/${options.guildId}`, before.secret, dependencies.fetchResponse),
    getDiscordJson(`/channels/${options.voiceChannelId}`, before.secret, dependencies.fetchResponse),
    getDiscordJson(`/channels/${options.publicationChannelId}`, before.secret, dependencies.fetchResponse),
  ]);
  assertDiscordIdentity(user, guild, voice, publication, options);
  const after = await readToken(options, dependencies.openFile);
  if (before.generationId !== after.generationId || !sameSecret(before.secret, after.secret)) {
    throw new Error("Discord token changed during the container-internal identity probe");
  }
  return Object.freeze({
    authenticatedUserId: options.applicationId,
    binding: {
      containerId: options.containerId,
      imageDigestSha256: options.imageDigestSha256,
      sourceRevision: options.sourceRevision,
    },
    bot: true,
    kind: "hosted-remote-discord-identity-probe-result",
    schemaVersion: 1,
    target: {
      guildId: options.guildId,
      publicationChannelId: options.publicationChannelId,
      voiceChannelId: options.voiceChannelId,
    },
    tokenCustody: {
      generationId: after.generationId,
      mode: 0o600,
      ownerUid: after.ownerUid,
      path: options.tokenFile,
    },
  });
}

interface TokenSnapshot {
  readonly generationId: string;
  readonly ownerUid: number;
  readonly secret: string;
}

async function readToken(
  options: ProbeOptions,
  openFile: typeof open,
): Promise<TokenSnapshot> {
  let file: FileHandle | undefined;
  try {
    file = await openFile(options.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== options.tokenOwnerUid
      || (metadata.mode & 0o777) !== 0o600 || metadata.size < 50 || metadata.size > maximumTokenBytes) {
      throw new Error("unsafe token custody");
    }
    const bytes = Buffer.alloc(maximumTokenBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximumTokenBytes) {throw new Error("token exceeds its limit");}
    const secret = bytes.toString("utf8", 0, bytesRead).trim();
    if (secret.length < 50 || /[\r\n]/u.test(secret)) {throw new Error("invalid token envelope");}
    return {
      generationId: `file-${createHash("sha256").update([
        metadata.dev, metadata.ino, metadata.size, metadata.ctimeMs,
      ].join(":"), "utf8").digest("hex")}`,
      ownerUid: metadata.uid,
      secret,
    };
  } catch (error) {
    throw new Error("Missing or unsafe remote Discord token file", { cause: error });
  } finally {
    await file?.close().catch(() => null);
  }
}

async function getDiscordJson(
  path: string,
  token: string,
  fetchResponse: typeof globalThis.fetch,
): Promise<unknown> {
  const response = await fetchResponse(`https://discord.com/api/v10${path}`, {
    headers: { accept: "application/json", authorization: `Bot ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    throw new Error(`Discord identity request failed with status ${response.status}`);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedBody(response.body),
  )) as unknown;
}

async function readBoundedBody(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (stream === null) {throw new Error("Discord identity response body is missing");}
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {break;}
      total += value.byteLength;
      if (total > maximumDiscordBodyBytes) {throw new Error("Discord identity response exceeds its limit");}
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => null);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {body.set(chunk, offset); offset += chunk.byteLength;}
  return body;
}

function assertDiscordIdentity(
  userValue: unknown,
  guildValue: unknown,
  voiceValue: unknown,
  publicationValue: unknown,
  options: ProbeOptions,
): void {
  const user = z.object({ bot: z.literal(true), id: snowflakeSchema }).passthrough().parse(userValue);
  const guild = z.object({ id: snowflakeSchema }).passthrough().parse(guildValue);
  const channel = z.object({ guild_id: snowflakeSchema, id: snowflakeSchema, type: z.number().int() }).passthrough();
  const voice = channel.parse(voiceValue);
  const publication = channel.parse(publicationValue);
  if (user.id !== options.applicationId || guild.id !== options.guildId
    || voice.id !== options.voiceChannelId || publication.id !== options.publicationChannelId
    || voice.guild_id !== options.guildId || publication.guild_id !== options.guildId
    || ![2, 13].includes(voice.type) || ![0, 5].includes(publication.type)) {
    throw new Error("Discord token does not own the exact official bot and private campaign target");
  }
}

function parseOptions(argv: readonly string[]): ProbeOptions {
  if (argv.length !== 19 || argv.at(-1) !== "--json") {
    throw new Error("Hosted Discord identity probe requires the fixed argument contract");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length - 1; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || values.has(key)) {
      throw new Error("Hosted Discord identity probe received invalid arguments");
    }
    values.set(key, value);
  }
  const get = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) {throw new Error(`Hosted Discord identity probe is missing ${key}`);}
    return value;
  };
  if (values.size !== 9) {throw new Error("Hosted Discord identity probe received unknown arguments");}
  return {
    applicationId: snowflakeSchema.parse(get("--application-id")),
    containerId: identifierSchema.parse(get("--container-id")),
    guildId: snowflakeSchema.parse(get("--guild-id")),
    imageDigestSha256: sha256Schema.parse(get("--image-digest-sha256")),
    publicationChannelId: snowflakeSchema.parse(get("--publication-channel-id")),
    sourceRevision: revisionSchema.parse(get("--source-revision")),
    tokenFile: z.string().startsWith("/").max(4_096).parse(get("--token-file")),
    tokenOwnerUid: z.coerce.number().int().nonnegative().parse(get("--token-owner-uid")),
    voiceChannelId: snowflakeSchema.parse(get("--voice-channel-id")),
  };
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

async function main(): Promise<void> {
  const result = await runHostedDiscordIdentityProbe(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Hosted Discord identity probe failed"}\n`);
    process.exitCode = 1;
  });
}
