import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type AudioReceiveStream,
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
import { captureConversationVoiceFromOpenStream } from "./conversation-voice-stream-capture.js";
import { waitForConversationVoiceCorrelationWhileGuardingAudio } from
  "./conversation-voice-turn-correlation-wait.js";
import {
  assertConversationAnswerHandshakeRootIsNew,
  publishConversationAnswerObserverReady,
  waitForConversationAnswerPlaybackIntent,
  type ConversationAnswerPlaybackIntent,
} from "./conversation-voice-turn-id-source.js";
import {
  ConversationVoiceCaptureController,
  ConversationVoiceCaptureError,
  PCM_S16LE_CHANNELS,
  PCM_S16LE_SAMPLE_RATE_HERTZ,
  assertConversationVoiceEvidencePathIsNew,
  writeNewConversationVoiceEvidenceAtomically,
  type ConversationVoiceOpusDecoder,
} from "./conversation-voice-observer.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";

const systemClock = {
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

interface ConversationVoiceAudibilityDecoder extends ConversationVoiceOpusDecoder {
  isPacketAudible(opusPacket: Uint8Array): boolean;
}

class ProbedConversationVoiceOpusDecoder implements ConversationVoiceAudibilityDecoder {
  readonly #delegate: ConversationVoiceOpusDecoder;
  #probe: { readonly opusPacket: Uint8Array; readonly pcm: Uint8Array } | undefined;

  public constructor(delegate: ConversationVoiceOpusDecoder) {
    this.#delegate = delegate;
  }

  public decode(opusPacket: Uint8Array): Uint8Array {
    const probe = this.#probe;
    if (probe !== undefined && probe.opusPacket === opusPacket) {
      this.#probe = undefined;
      return probe.pcm;
    }
    this.#probe = undefined;
    return this.#delegate.decode(opusPacket);
  }

  public isPacketAudible(opusPacket: Uint8Array): boolean {
    const pcm = this.#delegate.decode(opusPacket);
    this.#probe = { opusPacket, pcm };
    return decodedPcmIsAudible(pcm);
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
  const handshakeRoots = config.additionalCaptures.flatMap((capture) =>
    capture.purpose === "addressed-answer" ? [capture.playbackHandshakeRoot] : []
  );
  await Promise.all(captures.map(({ outputPath }) =>
    assertConversationVoiceEvidencePathIsNew(outputPath)
  ));
  await Promise.all(handshakeRoots.map(assertConversationAnswerHandshakeRootIsNew));
  const decoder = await createDiscordJsOpusDecoder();

  const secretReader = config.secretDirectory === undefined
    ? new MacOsKeychainSecretReader(config.keychainService)
    : new FileSecretReader(config.secretDirectory);
  const token = await secretReader.read(config.observerAccount);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  let connection: VoiceConnection | undefined;
  let sourceStream: AudioReceiveStream | undefined;
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
    const handshakeNotBeforeEpochMilliseconds = Date.now();
    await Promise.all(handshakeRoots.map(assertConversationAnswerHandshakeRootIsNew));
    await assertConfiguredCraigBotIsInVoiceChannel(
      client,
      guild,
      config.craigBotId,
      channel.id,
      config.readyTimeoutMilliseconds,
    );
    sourceStream = connection.receiver.subscribe(config.craigBotId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    sourceStream.on("error", ignoreStreamError);
    for (const [index, plannedCapture] of captures.entries()) {
      const playbackIntent: ConversationAnswerPlaybackIntent | undefined =
        plannedCapture.purpose === "addressed-answer"
          ? await waitForConversationVoiceCorrelationWhileGuardingAudio({
          isPacketAudible: (packet) => decoder.isPacketAudible(packet),
          resolveCorrelation: async (signal) => waitForConversationAnswerPlaybackIntent({
            meetingId: config.meetingId,
            notBeforeEpochMilliseconds: handshakeNotBeforeEpochMilliseconds,
            root: plannedCapture.playbackHandshakeRoot,
            runId: config.runId,
            signal,
            timeoutMilliseconds: config.readyTimeoutMilliseconds,
          }),
          stream: sourceStream,
        })
          : undefined;
      const turnId = playbackIntent?.turnId ?? plannedCapture.turnId;
      const attemptId = playbackIntent?.playbackAttemptId ?? plannedCapture.attemptId;
      const capture = await captureConversationVoiceFromOpenStream({
        captureTimeoutMilliseconds: config.captureTimeoutMilliseconds,
        clock: systemClock,
        controller: new ConversationVoiceCaptureController({
          captureTimeoutMilliseconds: config.captureTimeoutMilliseconds,
          expectedDuration: {
            maximumMilliseconds:
              config.expectedDurationMilliseconds + config.expectedDurationToleranceMilliseconds,
            minimumMilliseconds: config.expectedDurationMilliseconds,
          },
          maxPcmBytes: config.maxPcmBytes,
        }, decoder),
        firstPacketTimeoutMilliseconds: config.readyTimeoutMilliseconds,
        isPacketAudible: (packet) => decoder.isPacketAudible(packet),
        ...(playbackIntent === undefined
          ? {}
          : {
              publishReady: async () => publishConversationAnswerObserverReady({
                intent: playbackIntent,
                root: plannedCapture.playbackHandshakeRoot,
              }),
            }),
        stream: sourceStream,
      });
      const playbackReceipt = playbackIntent === undefined
        ? undefined
        : {
            meetingId: playbackIntent.meetingId,
            playbackAttemptId: playbackIntent.playbackAttemptId,
            startedAt: capture.firstPacketAt,
            turnId: playbackIntent.turnId,
          };
      const evidence = createConversationVoiceEvidence({
        attemptId,
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
        ...(playbackReceipt === undefined ? {} : { playbackReceipt }),
        recordingId: config.recordingId,
        runId: config.runId,
        turnId,
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
        await waitForConfiguredCraigAudioSilence(
          decoder,
          sourceStream,
          config.readyTimeoutMilliseconds,
        );
      }
    }
  } finally {
    sourceStream?.destroy();
    connection?.destroy();
    await client.destroy();
    sourceStream?.off("error", ignoreStreamError);
  }
}

function ignoreStreamError(): void {}

async function waitForConfiguredCraigAudioSilence(
  decoder: ConversationVoiceAudibilityDecoder,
  stream: AudioReceiveStream,
  timeoutMilliseconds: number,
): Promise<void> {
  const audioSilenceMilliseconds = 300;
  if (stream.destroyed || stream.readableEnded) {
    throw new Error("Configured Craig audio stream closed before the capture sequence completed");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let silence: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (deadline !== undefined) {
        clearTimeout(deadline);
      }
      if (silence !== undefined) {
        clearTimeout(silence);
      }
      stream.pause();
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const succeed = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: unknown): void => {
      try {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("Configured Craig audio stream emitted a non-binary packet");
        }
        if (!decoder.isPacketAudible(chunk)) {
          return;
        }
        if (silence !== undefined) {
          clearTimeout(silence);
        }
        silence = setTimeout(succeed, audioSilenceMilliseconds);
      } catch (error: unknown) {
        fail(new Error(
          "Configured Craig audio stream could not be decoded while waiting for silence",
          { cause: error },
        ));
      }
    };
    const onEnd = (): void => {
      fail(new Error("Configured Craig audio stream ended before the capture sequence completed"));
    };
    const onError = (error: unknown): void => {
      fail(new Error(
        "Configured Craig audio stream failed before the capture sequence completed",
        { cause: error },
      ));
    };
    stream.pause();
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.on("data", onData);
    deadline = setTimeout(() => {
      fail(new Error("Configured Craig audio did not become silent before timeout"));
    }, timeoutMilliseconds);
    silence = setTimeout(succeed, audioSilenceMilliseconds);
    stream.resume();
  });
}

function decodedPcmIsAudible(pcm: Uint8Array): boolean {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error("Configured Craig audio decoder returned invalid PCM");
  }
  const data = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sampleCount = 0;
  let sampleSquareSum = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    const sample = data.getInt16(offset, true);
    sampleCount += 1;
    sampleSquareSum += sample * sample;
  }
  return Math.sqrt(sampleSquareSum / sampleCount) / 32_768 >= 0.01;
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

async function createDiscordJsOpusDecoder(): Promise<ConversationVoiceAudibilityDecoder> {
  try {
    const opus = (await import("@discordjs/opus")).default;
    const decoder = new opus.OpusEncoder(
      PCM_S16LE_SAMPLE_RATE_HERTZ,
      PCM_S16LE_CHANNELS,
    );
    return new ProbedConversationVoiceOpusDecoder({
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
