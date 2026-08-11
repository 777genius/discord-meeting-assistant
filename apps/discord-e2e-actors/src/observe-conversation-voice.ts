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
  const captures = [
    {
      attemptId: config.attemptId,
      outputPath: config.outputPath,
      purpose: config.purpose,
      turnId: config.turnId,
    },
    ...config.additionalCaptures,
  ] as const;
  await Promise.all(captures.map(({ outputPath }) =>
    assertConversationVoiceEvidencePathIsNew(outputPath)
  ));
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
    connection = joinVoiceChannel({
      adapterCreator: guild.voiceAdapterCreator,
      channelId: channel.id,
      guildId: guild.id,
      group: `conversation-voice-observer:${config.runId}:${process.pid}`,
      selfDeaf: false,
      selfMute: true,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, config.readyTimeoutMilliseconds);
    await assertConfiguredCraigBotIsInVoiceChannel(
      client,
      guild,
      config.craigBotId,
      channel.id,
      config.readyTimeoutMilliseconds,
    );
    for (const [index, plannedCapture] of captures.entries()) {
      const capture = await captureConfiguredCraigVoice({
        captureTimeoutMilliseconds: config.captureTimeoutMilliseconds,
        connection,
        controller: new ConversationVoiceCaptureController({
          captureTimeoutMilliseconds: config.captureTimeoutMilliseconds,
          expectedDuration: {
            maximumMilliseconds:
              config.expectedDurationMilliseconds + config.expectedDurationToleranceMilliseconds,
            minimumMilliseconds: config.expectedDurationMilliseconds,
          },
          maxPcmBytes: config.maxPcmBytes,
        }, decoder),
        craigBotId: config.craigBotId,
        firstPacketTimeoutMilliseconds: config.readyTimeoutMilliseconds,
      });
      const evidence = createConversationVoiceEvidence({
        attemptId: plannedCapture.attemptId,
        authenticatedBotId,
        capture,
        captureTimeoutMilliseconds: config.captureTimeoutMilliseconds,
        craigBotId: config.craigBotId,
        expectedDuration: {
          maximumMilliseconds:
            config.expectedDurationMilliseconds + config.expectedDurationToleranceMilliseconds,
          minimumMilliseconds: config.expectedDurationMilliseconds,
        },
        guildId: config.guildId,
        maxPcmBytes: config.maxPcmBytes,
        observerApplicationId: config.observerApplicationId,
        privateTestGuildConfirmed: config.privateTestGuildConfirmed,
        purpose: plannedCapture.purpose,
        recordingId: config.recordingId,
        runId: config.runId,
        turnId: plannedCapture.turnId,
        voiceChannelId: config.voiceChannelId,
      });
      await writeNewConversationVoiceEvidenceAtomically(plannedCapture.outputPath, evidence);
      process.stdout.write(`${JSON.stringify({
        acceptedDurationMilliseconds: capture.acceptedDurationMilliseconds,
        acceptedPacketCount: capture.acceptedPacketCount,
        outputPath: plannedCapture.outputPath,
        runId: config.runId,
        status: "captured",
      })}\n`);
      if (index < captures.length - 1) {
        await waitForConfiguredCraigSilence(
          connection,
          config.craigBotId,
          config.readyTimeoutMilliseconds,
        );
      }
    }
  } finally {
    connection?.destroy();
    await client.destroy();
  }
}

async function waitForConfiguredCraigSilence(
  connection: VoiceConnection,
  craigBotId: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const speaking = connection.receiver.speaking;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      speaking.off("end", onEnd);
    };
    const succeed = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const onEnd = (userId: string): void => {
      if (userId === craigBotId) {
        succeed();
      }
    };
    speaking.on("end", onEnd);
    if (!speaking.users.has(craigBotId)) {
      succeed();
      return;
    }
    timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error("Configured Craig audio did not become silent before timeout"));
    }, timeoutMilliseconds);
  });
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
  readonly captureTimeoutMilliseconds: number;
  readonly connection: VoiceConnection;
  readonly controller: ConversationVoiceCaptureController;
  readonly craigBotId: string;
  readonly firstPacketTimeoutMilliseconds: number;
  readonly clock?: ConversationVoiceCaptureClock;
}): Promise<ConversationVoiceCaptureSummary> {
  const clock = input.clock ?? systemClock;
  const stream = input.connection.receiver.subscribe(input.craigBotId, {
    end: { behavior: EndBehaviorType.Manual },
  });
  return new Promise<ConversationVoiceCaptureSummary>((resolve, reject) => {
    let captureTimeout: ReturnType<typeof setTimeout> | undefined;
    let sequence = 0;
    let settled = false;
    const firstPacketTimeout = setTimeout(() => {
      fail(new ConversationVoiceCaptureError(
        "no-audio",
        "Conversation voice capture received no Craig audio before the readiness timeout",
      ));
    }, input.firstPacketTimeoutMilliseconds);
    const cleanup = (): void => {
      clearTimeout(firstPacketTimeout);
      if (captureTimeout !== undefined) {
        clearTimeout(captureTimeout);
      }
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
      stream.once("close", () => {
        resolve(capture);
      });
      stream.destroy();
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      stream.once("close", () => {
        reject(error);
      });
      stream.destroy();
    };
    const onData = (opusPacket: Uint8Array): void => {
      try {
        const timing = clock.now();
        if (sequence === 0) {
          clearTimeout(firstPacketTimeout);
          input.controller.start(timing);
          captureTimeout = setTimeout(() => {
            try {
              succeed(input.controller.complete(clock.now()));
            } catch (error) {
              fail(error);
            }
          }, input.captureTimeoutMilliseconds);
        }
        const result = input.controller.acceptPacket({
          opusPacket,
          sequence: sequence + 1,
          timing,
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
      if (sequence === 0) {
        fail(new ConversationVoiceCaptureError(
          "no-audio",
          "Conversation voice receiver ended before the first Craig audio packet",
        ));
        return;
      }
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
