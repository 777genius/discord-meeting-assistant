import {
  EndBehaviorType,
  VoiceConnectionStatus, entersState, joinVoiceChannel,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ChannelType, Client, GatewayIntentBits,
  type Guild,
  type GuildBasedChannel,
  type VoiceChannel,
} from "discord.js";
import {
  loadConversationVoiceObserverConfig, type ConversationVoiceObserverCapture,
} from "./conversation-voice-observer-config.js";
import { conversationVoiceCampaignPreflight } from
  "./conversation-voice-campaign-contract.js";
import {
  writeCreateOnlyConversationVoiceCampaignProof, type ConversationVoiceCampaignProofV1,
} from "./conversation-voice-campaign-proof.js";
import { createConversationVoiceEvidence } from "./conversation-voice-evidence.js";
import { captureConversationVoiceFromOpenStream } from "./conversation-voice-stream-capture.js";
import {
  createDiscordJsOpusDecoder, type ConversationVoiceAudibilityDecoder,
} from "./conversation-voice-audibility-decoder.js";
import { waitForConversationVoiceCorrelationWhileGuardingAudio } from
  "./conversation-voice-turn-correlation-wait.js";
import {
  assertConversationAnswerHandshakeRootIsNew, waitForConversationAnswerPlaybackIntent,
  type ConversationAnswerPlaybackIntent,
} from "./conversation-voice-turn-id-source.js";
import {
  ConversationVoiceCaptureController, ConversationVoiceCaptureError,
  assertConversationVoiceEvidencePathIsNew,
  writeNewConversationVoiceEvidenceAtomically,
} from "./conversation-voice-observer.js";
import { publishConversationVoiceReadyProof } from "./conversation-voice-ready-proof.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";
import {
  publishAnswerFirstPacket, publishAnswerIntent, publishAnswerObserverReady,
  publishCaptureRetained, publishObserverSubscribed,
} from "./hosted-campaign-process-event-publisher.js";
import { publishConversationObserverCompletion } from
  "./hosted-finite-process-completion-publisher.js";

const systemClock = { now: () => ({
  epochMilliseconds: Date.now(),
  monotonicMilliseconds: Number(process.hrtime.bigint() / 1_000_000n),
}) };

async function main(): Promise<void> {
  const config = loadConversationVoiceObserverConfig(process.env);
  const captures = [
    config.purpose === "addressed-answer" ? {
      expectedDuration: {
        maximumMilliseconds:
          config.expectedDurationMilliseconds + config.expectedDurationToleranceMilliseconds,
        minimumMilliseconds: config.expectedDurationMilliseconds,
      },
      outputPath: config.outputPath,
      playbackHandshakeRoot: config.playbackHandshakeRoot!,
      purpose: config.purpose,
    } : {
      attemptId: config.attemptId,
      expectedDuration: {
        maximumMilliseconds:
          config.expectedDurationMilliseconds + config.expectedDurationToleranceMilliseconds,
        minimumMilliseconds: config.expectedDurationMilliseconds,
      },
      outputPath: config.outputPath,
      purpose: config.purpose,
      turnId: config.turnId,
    },
    ...config.additionalCaptures,
  ] as const;
  const handshakeRoots = config.additionalCaptures.flatMap((capture) =>
    capture.purpose === "addressed-answer" ? [capture.playbackHandshakeRoot] : []
  ).concat(config.playbackHandshakeRoot === undefined ? [] : [config.playbackHandshakeRoot]);
  await Promise.all(captures.map(({ outputPath }) =>
    assertConversationVoiceEvidencePathIsNew(outputPath)
  ));
  await Promise.all(handshakeRoots.map(assertConversationAnswerHandshakeRootIsNew));
  if (config.additionalCaptures.length > 0) {
    process.stdout.write(`${JSON.stringify(conversationVoiceCampaignPreflight(captures))}\n`);
  }
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
    sourceStream = connection.receiver.subscribe(config.craigBotId, { end: {
      behavior: EndBehaviorType.Manual,
    } });
    sourceStream.on("error", () => {});
    publishObserverSubscribed(config, authenticatedBotId);
    const campaignProof = await capturePlannedConversationVoice({
      authenticatedBotId,
      captures,
      config,
      decoder,
      handshakeNotBeforeEpochMilliseconds,
      sourceStream,
    });
    if (config.campaignProofOutputPath !== undefined) {
      if (campaignProof === undefined) {
        throw new Error("Campaign observer completed without an authenticated ready proof");
      }
      await writeCreateOnlyConversationVoiceCampaignProof(
        config.campaignProofOutputPath,
        campaignProof,
      );
    }
    publishConversationObserverCompletion(config, captures.map(({ outputPath }) => outputPath));
  } finally {
    sourceStream?.destroy();
    connection?.destroy();
    await client.destroy();
  }
}

async function capturePlannedConversationVoice(input: {
  readonly authenticatedBotId: string;
  readonly captures: readonly ConversationVoiceObserverCapture[];
  readonly config: ReturnType<typeof loadConversationVoiceObserverConfig>;
  readonly decoder: ConversationVoiceAudibilityDecoder;
  readonly handshakeNotBeforeEpochMilliseconds: number;
  readonly sourceStream: AudioReceiveStream;
}): Promise<ConversationVoiceCampaignProofV1 | undefined> {
  const { authenticatedBotId, captures, config, decoder,
    handshakeNotBeforeEpochMilliseconds, sourceStream } = input;
  let campaignProof: ConversationVoiceCampaignProofV1 | undefined;
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
      const intentObservedAt = playbackIntent === undefined ? undefined : new Date().toISOString();
      publishAnswerIntent(config, playbackIntent, intentObservedAt);
      const turnId = playbackIntent?.turnId ?? ("turnId" in plannedCapture
        ? plannedCapture.turnId : undefined);
      const attemptId = playbackIntent?.playbackAttemptId ?? ("attemptId" in plannedCapture
        ? plannedCapture.attemptId : undefined);
      if (turnId === undefined || attemptId === undefined) {
        throw new Error("Conversation voice capture is missing its correlated identifiers");
      }
      const capture = await captureConversationVoiceFromOpenStream({
        captureTimeoutMilliseconds: config.captureTimeoutMilliseconds,
        clock: systemClock,
        controller: new ConversationVoiceCaptureController({
          captureTimeoutMilliseconds: config.captureTimeoutMilliseconds,
          expectedDuration: plannedCapture.expectedDuration,
          maxPcmBytes: config.maxPcmBytes,
        }, decoder),
        firstPacketTimeoutMilliseconds: config.readyTimeoutMilliseconds,
        isPacketAudible: (packet) => decoder.isPacketAudible(packet),
        ...(playbackIntent === undefined ? {} : {
          onFirstPacket: (timing: { readonly epochMilliseconds: number }) => {
            publishAnswerFirstPacket(config, playbackIntent, intentObservedAt, timing.epochMilliseconds);
          },
        }),
        ...(playbackIntent === undefined
          ? {}
          : {
              publishReady: async () => {
                if (!("playbackHandshakeRoot" in plannedCapture)) {
                  throw new Error("Addressed answer capture is missing its handshake root");
                }
                campaignProof = await publishConversationVoiceReadyProof({
                  authenticatedObserverBotId: authenticatedBotId,
                  captures,
                  intent: playbackIntent,
                  intentObservedAt: intentObservedAt!,
                  root: plannedCapture.playbackHandshakeRoot,
                  target: {
                    craigBotId: config.craigBotId,
                    guildId: config.guildId,
                    observerApplicationId: config.observerApplicationId,
                    voiceChannelId: config.voiceChannelId,
                  },
                });
                publishAnswerObserverReady(config, campaignProof);
              },
            }),
        stream: sourceStream,
      });
      const playbackReceipt = playbackIntent === undefined
        ? undefined
        : {
            meetingId: playbackIntent.meetingId,
            playbackAttemptId: playbackIntent.playbackAttemptId,
            turnId: playbackIntent.turnId,
          };
      const evidence = createConversationVoiceEvidence({
        attemptId,
        authenticatedBotId,
        capture,
        captureTimeoutMilliseconds: config.captureTimeoutMilliseconds,
        craigBotId: config.craigBotId,
        expectedDuration: plannedCapture.expectedDuration,
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
      publishCaptureRetained(config, index + 1, plannedCapture.outputPath);
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
  return campaignProof;
}

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

function assertConnectableVoiceChannel(
  channel: GuildBasedChannel | null,
): asserts channel is VoiceChannel {
  if (channel === null || channel.type !== ChannelType.GuildVoice) {
    throw new Error("Configured Discord channel is not a guild voice channel");
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof ConversationVoiceCaptureError
    ? error.message
    : "Conversation voice observer failed"}\n`);
  process.exitCode = 1;
});
