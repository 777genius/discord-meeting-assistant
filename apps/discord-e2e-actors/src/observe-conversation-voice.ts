import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type Guild,
  type GuildBasedChannel,
  type VoiceChannel,
} from "discord.js";

import { loadConversationVoiceObserverConfig } from "./conversation-voice-observer-config.js";
import { createConversationVoiceEvidence } from "./conversation-voice-evidence.js";
import {
  ConversationVoiceCaptureController,
  ConversationVoiceCaptureError,
  PCM_S16LE_CHANNELS,
  PCM_S16LE_SAMPLE_RATE_HERTZ,
  assertConversationVoiceEvidencePathIsNew,
  writeNewConversationVoiceEvidenceAtomically,
  type ConversationVoiceCaptureSummary,
  type ConversationVoiceCaptureTimestamp,
  type ConversationVoiceOpusDecoder,
} from "./conversation-voice-observer.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";

interface ConversationVoiceCaptureClock {
  now(): ConversationVoiceCaptureTimestamp;
}

const systemClock: ConversationVoiceCaptureClock = {
  now: () => ({
    epochMilliseconds: Date.now(),
    monotonicMilliseconds: Number(process.hrtime.bigint() / 1_000_000n),
  }),
};

class ConversationVoiceObserverError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConversationVoiceObserverError";
  }
}

async function main(): Promise<void> {
  const config = loadConversationVoiceObserverConfig(process.env);
  await assertConversationVoiceEvidencePathIsNew(config.outputPath);
  const decoder = await createDiscordJsOpusDecoder();

  const secretReader = config.secretDirectory === undefined
    ? new MacOsKeychainSecretReader(config.keychainService)
    : new FileSecretReader(config.secretDirectory);
  const token = await secretReader.read(config.observerAccount);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  let connection: VoiceConnection | undefined;
  try {
    await client.login(token);
    const authenticatedBotId = requiredAuthenticatedBotId(client);
    if (authenticatedBotId !== config.observerApplicationId) {
      throw new Error("Conversation voice observer application ID does not match its authenticated bot");
    }
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await guild.channels.fetch(config.voiceChannelId);
    assertConnectableVoiceChannel(channel);
    await assertConfiguredCraigBotIsInVoiceChannel(
      client,
      guild,
      config.craigBotId,
      channel.id,
      config.captureTimeoutMilliseconds,
    );

    connection = joinVoiceChannel({
      adapterCreator: guild.voiceAdapterCreator,
      channelId: channel.id,
      guildId: guild.id,
      group: `conversation-voice-observer:${config.runId}:${process.pid}`,
      selfDeaf: false,
      selfMute: true,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, config.captureTimeoutMilliseconds);
    const capture = await captureConfiguredCraigVoice({
      connection,
      controller: new ConversationVoiceCaptureController({
        captureTimeoutMilliseconds: config.captureTimeoutMilliseconds,
        expectedDuration: {
          maximumMilliseconds: config.expectedDurationMilliseconds + config.expectedDurationToleranceMilliseconds,
          minimumMilliseconds: config.expectedDurationMilliseconds,
        },
        maxPcmBytes: config.maxPcmBytes,
      }, decoder),
      craigBotId: config.craigBotId,
      timeoutMilliseconds: config.captureTimeoutMilliseconds,
    });
    const evidence = createConversationVoiceEvidence({
      attemptId: config.attemptId,
      authenticatedBotId,
      capture,
      captureTimeoutMilliseconds: config.captureTimeoutMilliseconds,
      craigBotId: config.craigBotId,
      expectedDuration: {
        maximumMilliseconds: config.expectedDurationMilliseconds + config.expectedDurationToleranceMilliseconds,
        minimumMilliseconds: config.expectedDurationMilliseconds,
      },
      guildId: config.guildId,
      maxPcmBytes: config.maxPcmBytes,
      observerApplicationId: config.observerApplicationId,
      privateTestGuildConfirmed: config.privateTestGuildConfirmed,
      purpose: config.purpose,
      recordingId: config.recordingId,
      runId: config.runId,
      turnId: config.turnId,
      voiceChannelId: config.voiceChannelId,
    });
    await writeNewConversationVoiceEvidenceAtomically(config.outputPath, evidence);
    process.stdout.write(`${JSON.stringify({
      acceptedDurationMilliseconds: capture.acceptedDurationMilliseconds,
      acceptedPacketCount: capture.acceptedPacketCount,
      outputPath: config.outputPath,
      runId: config.runId,
      status: "captured",
    })}\n`);
  } finally {
    connection?.destroy();
    await client.destroy();
  }
}

function requiredAuthenticatedBotId(client: Client): string {
  const authenticatedUser = client.user;
  if (authenticatedUser === null) {
    throw new Error("Conversation voice observer did not receive an authenticated bot user");
  }
  if (!authenticatedUser.bot) {
    throw new Error("Conversation voice observer must authenticate as an official bot application");
  }
  return authenticatedUser.id;
}

async function assertConfiguredCraigBotIsInVoiceChannel(
  client: Client,
  guild: Guild,
  craigBotId: string,
  voiceChannelId: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const member = await guild.members.fetch(craigBotId);
  if (!member.user.bot) {
    throw new Error("Configured Craig identity is not a Discord bot");
  }
  if (guild.voiceStates.cache.get(craigBotId)?.channelId === voiceChannelId) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Configured Craig bot did not join the private test voice channel before timeout"));
    }, timeoutMilliseconds);
    const onVoiceStateUpdate = (): void => {
      if (guild.voiceStates.cache.get(craigBotId)?.channelId === voiceChannelId) {
        cleanup();
        resolve();
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      client.off("voiceStateUpdate", onVoiceStateUpdate);
    };
    client.on("voiceStateUpdate", onVoiceStateUpdate);
  });
}

async function captureConfiguredCraigVoice(input: {
  readonly connection: VoiceConnection;
  readonly controller: ConversationVoiceCaptureController;
  readonly craigBotId: string;
  readonly timeoutMilliseconds: number;
  readonly clock?: ConversationVoiceCaptureClock;
}): Promise<ConversationVoiceCaptureSummary> {
  const clock = input.clock ?? systemClock;
  input.controller.start(clock.now());
  const stream = input.connection.receiver.subscribe(input.craigBotId, {
    end: { behavior: EndBehaviorType.Manual },
  });
  return new Promise<ConversationVoiceCaptureSummary>((resolve, reject) => {
    let sequence = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      try {
        succeed(input.controller.complete(clock.now()));
      } catch (error) {
        fail(error);
      }
    }, input.timeoutMilliseconds);
    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const succeed = (capture: ConversationVoiceCaptureSummary): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      stream.destroy();
      resolve(capture);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      stream.destroy();
      reject(error);
    };
    const onData = (opusPacket: Uint8Array): void => {
      try {
        const result = input.controller.acceptPacket({
          opusPacket,
          sequence: sequence + 1,
          timing: clock.now(),
        });
        sequence += 1;
        if (result.kind === "accepted" && result.captureComplete) {
          succeed(input.controller.complete(clock.now()));
        }
      } catch (error) {
        fail(error);
      }
    };
    const onEnd = (): void => {
      try {
        succeed(input.controller.complete(clock.now()));
      } catch (error) {
        fail(error);
      }
    };
    const onError = (): void => {
      fail(new Error("Conversation voice receiver stream failed"));
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

async function createDiscordJsOpusDecoder(): Promise<ConversationVoiceOpusDecoder> {
  try {
    const opus = (await import("@discordjs/opus")).default;
    const decoder = new opus.OpusEncoder(
      PCM_S16LE_SAMPLE_RATE_HERTZ,
      PCM_S16LE_CHANNELS,
    );
    return Object.freeze({
      decode: (opusPacket: Uint8Array) => decoder.decode(Buffer.from(opusPacket)),
    });
  } catch {
    throw new ConversationVoiceObserverError(
      "Conversation voice observer could not load the native @discordjs/opus 0.10.0 decoder",
    );
  }
}

function assertConnectableVoiceChannel(
  channel: GuildBasedChannel | null,
): asserts channel is VoiceChannel {
  if (channel === null || channel.type !== ChannelType.GuildVoice) {
    throw new Error("Configured Discord channel is not a guild voice channel");
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ConversationVoiceCaptureError || error instanceof ConversationVoiceObserverError) {
    return error.message;
  }
  return "Conversation voice observer failed";
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
