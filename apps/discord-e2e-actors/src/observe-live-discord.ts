import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type AnyThreadChannel,
  type Channel,
  type Message,
  type NewsChannel,
  type TextChannel,
  type TextThreadChannel,
} from "discord.js";

import { loadLiveDiscordObserverConfig } from "./live-discord-observer-config.js";
import {
  observeLiveDiscord,
  type LiveDiscordMessageInput,
  type LiveDiscordProjectionReader,
  type LiveDiscordThreadInput,
  type LiveDiscordProjectionMessages,
} from "./live-discord-observer.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";

class DiscordJsLiveDiscordProjectionReader implements LiveDiscordProjectionReader {
  readonly #client = new Client({ intents: [GatewayIntentBits.Guilds] });

  public async connect(token: string): Promise<void> {
    await this.#client.login(token);
  }

  public authenticatedUserId(): string {
    const userId = this.#client.user?.id;
    if (userId === undefined) {
      throw new Error("Discord live observer did not receive an authenticated bot user");
    }
    return userId;
  }

  public async poll(input: {
    readonly createdSinceMilliseconds: number;
    readonly resultChannelId: string;
  }): Promise<readonly LiveDiscordProjectionMessages[]> {
    const parent = await this.#client.channels.fetch(input.resultChannelId);
    if (!isResultsTextChannel(parent)) {
      throw new Error("Discord live observer results channel must be a guild text or announcement channel");
    }
    const threads = await publicThreadsFor(parent, input.createdSinceMilliseconds);
    const threadProjections = await Promise.all(threads.map(async (thread) => ({
      messages: await recentMessagesSince(thread, input.createdSinceMilliseconds),
      container: { kind: "thread" as const, ...toThreadInput(thread) },
    })));
    return [{
      messages: await recentMessagesSince(parent, input.createdSinceMilliseconds),
      container: { kind: "channel-message", parentChannelId: parent.id },
    }, ...threadProjections];
  }

  public async close(): Promise<void> {
    await this.#client.destroy();
  }
}

async function main(): Promise<void> {
  const config = loadLiveDiscordObserverConfig(process.env);
  await assertOutputDoesNotExist(config.outputPath);

  const secretReader = config.secretDirectory === undefined
    ? new MacOsKeychainSecretReader(config.keychainService)
    : new FileSecretReader(config.secretDirectory);
  const token = await secretReader.read(config.sutAccount);
  const discord = new DiscordJsLiveDiscordProjectionReader();
  try {
    await discord.connect(token);
    if (discord.authenticatedUserId() !== config.sutApplicationId) {
      throw new Error("Discord live observer SUT application ID does not match its authenticated bot");
    }
    const trace = await observeLiveDiscord(config, discord);
    await writeNewTraceAtomically(config.outputPath, trace);
    process.stdout.write(`${JSON.stringify({
      outputPath: config.outputPath,
      runId: config.runId,
      snapshots: trace.snapshots.length,
      status: "captured",
    })}\n`);
  } finally {
    await discord.close();
  }
}

function isResultsTextChannel(channel: Channel | null): channel is TextChannel | NewsChannel {
  return channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement;
}

async function publicThreadsFor(
  parent: TextChannel | NewsChannel,
  createdSinceMilliseconds: number,
): Promise<readonly TextThreadChannel[]> {
  const [active, archived] = await Promise.all([
    parent.threads.fetchActive(false),
    parent.threads.fetchArchived({ fetchAll: true, type: "public" }, false),
  ]);
  const threads = new Map<string, TextThreadChannel>();
  for (const thread of [...active.threads.values(), ...archived.threads.values()]) {
    if (isPublicTextThread(thread) && thread.parentId === parent.id) {
      threads.set(thread.id, thread);
    }
  }
  return [...threads.values()]
    .filter((thread) =>
      thread.createdTimestamp !== null && thread.createdTimestamp >= createdSinceMilliseconds
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function isPublicTextThread(thread: AnyThreadChannel): thread is TextThreadChannel {
  return thread.parent?.type === ChannelType.GuildText ||
    thread.parent?.type === ChannelType.GuildAnnouncement;
}

async function recentMessagesSince(
  channel: TextChannel | NewsChannel | TextThreadChannel,
  createdSinceMilliseconds: number,
): Promise<readonly LiveDiscordMessageInput[]> {
  const messages = new Map<string, LiveDiscordMessageInput>();
  let before: string | undefined;
  do {
    const page = await channel.messages.fetch({
      limit: 100,
      ...(before === undefined ? {} : { before }),
    });
    let oldestMessageId: string | undefined;
    for (const message of page.values()) {
      messages.set(message.id, toMessageInput(message));
      oldestMessageId = message.id;
    }
    const oldestTimestamp = Math.min(
      ...[...page.values()].map(({ createdTimestamp }) => createdTimestamp),
    );
    before = page.size === 100 && oldestTimestamp >= createdSinceMilliseconds
      ? oldestMessageId
      : undefined;
  } while (before !== undefined);
  return [...messages.values()];
}

function toThreadInput(thread: TextThreadChannel): LiveDiscordThreadInput {
  if (thread.parentId === null) {
    throw new Error("Discord live observer found a thread without its parent channel");
  }
  return {
    id: thread.id,
    name: thread.name,
    parentId: thread.parentId,
  };
}

function toMessageInput(message: Message): LiveDiscordMessageInput {
  return {
    authorId: message.author.id,
    content: message.content,
    createdAtMilliseconds: message.createdTimestamp,
    editedAtMilliseconds: message.editedTimestamp,
    embeds: message.embeds.map((embed) => ({
      description: embed.description,
      fields: embed.fields.map((field) => ({
        inline: field.inline,
        name: field.name,
        value: field.value,
      })),
      title: embed.title,
    })),
    id: message.id,
  };
}

async function assertOutputDoesNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  throw new Error("Discord live observer output already exists and will not be replaced");
}

async function writeNewTraceAtomically(path: string, trace: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let temporaryHandle: FileHandle | undefined;
  let published = false;
  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(trace, undefined, 2)}\n`, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await chmod(temporaryPath, 0o600);
    await link(temporaryPath, path);
    published = true;
    await unlink(temporaryPath).catch(() => {});
  } catch (error) {
    await temporaryHandle?.close();
    if (!published) {
      await unlink(temporaryPath).catch(() => {});
    }
    if (isOutputCollisionError(error)) {
      throw new Error("Discord live observer output already exists and will not be replaced", {
        cause: error,
      });
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

function isOutputCollisionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "EEXIST";
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown Discord live observer failure";
  process.stderr.write(`Discord live observer failed: ${message}\n`);
  process.exitCode = 1;
});
