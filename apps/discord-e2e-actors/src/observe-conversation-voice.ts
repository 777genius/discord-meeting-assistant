import {
  EndBehaviorType,
  VoiceConnectionStatus, entersState, joinVoiceChannel,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";
import { Client, GatewayIntentBits } from "discord.js";
import { loadConversationVoiceObserverConfig, type ConversationVoiceObserverCapture } from
  "./conversation-voice-observer-config.js";
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
  armInitialConversationObserver,
  publishGreetingObserverReady,
} from "./conversation-greeting-ready.js";
import {
  assertConfiguredCraigBotIsInVoiceChannel,
  assertConnectableVoiceChannel,
  requiredAuthenticatedBotId,
} from "./conversation-observer-discord-validation.js";
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
const systemClock = { now: () => ({ epochMilliseconds: Date.now(),
  monotonicMilliseconds: Number(process.hrtime.bigint() / 1_000_000n) }) };
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
    const greetingIntentNotBeforeEpochMilliseconds = Date.now();
    connection = joinVoiceChannel({
      adapterCreator: guild.voiceAdapterCreator,
      channelId: channel.id,
      guildId: guild.id,
      group: `conversation-voice-observer:${config.runId}:${process.pid}`,
      selfDeaf: false,
      selfMute: true,
    });
    // The observer's own join can trigger immediate greeting playback. Subscribe synchronously
    // after constructing the connection so no await boundary can lose those first packets.
    sourceStream = connection.receiver.subscribe(config.craigBotId, { end: {
      behavior: EndBehaviorType.Manual,
    } });
    sourceStream.on("error", () => {});
    await entersState(connection, VoiceConnectionStatus.Ready, config.readyTimeoutMilliseconds);
    const handshakeNotBeforeEpochMilliseconds = Date.now();
    await Promise.all(handshakeRoots.map(assertConversationAnswerHandshakeRootIsNew));
    await armInitialConversationObserver({
      publishObserverSubscribed: () => publishObserverSubscribed(config, authenticatedBotId),
      waitForCraigBot: () => assertConfiguredCraigBotIsInVoiceChannel(
        client,
        guild,
        config.craigBotId,
        channel.id,
        config.readyTimeoutMilliseconds,
      ),
    });
    const campaignProof = await capturePlannedConversationVoice({
      authenticatedBotId,
      captures,
      config,
      decoder,
      greetingIntentNotBeforeEpochMilliseconds,
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
  readonly greetingIntentNotBeforeEpochMilliseconds: number;
  readonly handshakeNotBeforeEpochMilliseconds: number;
  readonly sourceStream: AudioReceiveStream;
}): Promise<ConversationVoiceCampaignProofV1 | undefined> {
  const { authenticatedBotId, captures, config, decoder,
    greetingIntentNotBeforeEpochMilliseconds, handshakeNotBeforeEpochMilliseconds,
    sourceStream } = input;
  let campaignProof: ConversationVoiceCampaignProofV1 | undefined;
  for (const [index, plannedCapture] of captures.entries()) {
      const playbackIntent: ConversationAnswerPlaybackIntent | undefined =
        plannedCapture.purpose === "addressed-answer"
          ? await waitForConversationVoiceCorrelationWhileGuardingAudio({
          isPacketAudible: (packet) => decoder.isPacketAudible(packet),
          resolveCorrelation: async (signal) => waitForConversationAnswerPlaybackIntent({
            ...(config.meetingId === undefined ? {} : { meetingId: config.meetingId }),
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
        ...readyPublisher({
          authenticatedBotId,
          captures,
          config,
          greetingIntentNotBeforeEpochMilliseconds,
          plannedCapture,
          playbackIntent,
          playbackIntentObservedAt: intentObservedAt,
          publishCampaignProof: (proof) => { campaignProof = proof; },
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
function readyPublisher(input: {
  readonly authenticatedBotId: string; readonly captures: readonly ConversationVoiceObserverCapture[];
  readonly config: ReturnType<typeof loadConversationVoiceObserverConfig>;
  readonly greetingIntentNotBeforeEpochMilliseconds: number;
  readonly plannedCapture: ConversationVoiceObserverCapture;
  readonly playbackIntent: ConversationAnswerPlaybackIntent | undefined;
  readonly playbackIntentObservedAt: string | undefined;
  readonly publishCampaignProof: (proof: ConversationVoiceCampaignProofV1) => void;
}): { readonly publishReady?: () => Promise<void> } {
  const playbackIntent = input.playbackIntent;
  if (playbackIntent !== undefined) {
    return { publishReady: async () => {
      if (!("playbackHandshakeRoot" in input.plannedCapture) ||
        input.playbackIntentObservedAt === undefined) {
        throw new Error("Addressed answer capture is missing its handshake correlation");
      }
      const proof = await publishConversationVoiceReadyProof({
        authenticatedObserverBotId: input.authenticatedBotId,
        captures: input.captures,
        intent: playbackIntent,
        intentObservedAt: input.playbackIntentObservedAt,
        root: input.plannedCapture.playbackHandshakeRoot,
        target: {
          craigBotId: input.config.craigBotId, guildId: input.config.guildId,
          observerApplicationId: input.config.observerApplicationId,
          voiceChannelId: input.config.voiceChannelId,
        },
      });
      input.publishCampaignProof(proof);
      publishAnswerObserverReady(input.config, proof);
    } };
  }
  if (input.plannedCapture.purpose !== "greeting" || input.config.greetingHandshakeRoot === undefined) {
    return {};
  }
  const participantId = greetingParticipantId(input.plannedCapture.turnId);
  return { publishReady: () => publishGreetingObserverReady({
    authenticatedBotId: input.authenticatedBotId,
    config: input.config,
    handshakeNotBeforeEpochMilliseconds: input.greetingIntentNotBeforeEpochMilliseconds,
    participantId,
  }) };
}

function greetingParticipantId(turnId: string): string {
  const prefix = "participant-greeting:";
  const participantId = turnId.startsWith(prefix) ? turnId.slice(prefix.length) : "";
  if (!/^\d{17,20}$/u.test(participantId)) { throw new Error(
    "Greeting capture turn ID does not contain a Discord participant ID",
  ); }
  return participantId;
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
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof ConversationVoiceCaptureError
    ? error.message
    : "Conversation voice observer failed"}\n`);
  process.exitCode = 1;
});
