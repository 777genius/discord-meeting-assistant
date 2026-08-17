import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";

import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
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

import type {
  ReconnectableVoiceActor,
  VoicePlaybackLifecycleObserver,
} from "./run-actor-scenario.js";

export interface DiscordVoiceActorInput {
  readonly name: string;
  readonly token: string;
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly fixturePath: string;
  readonly readyTimeoutMilliseconds: number;
  readonly playbackTimeoutMilliseconds: number;
  readonly expectedApplicationId?: string;
}

export interface RecorderAwareVoiceActor extends ReconnectableVoiceActor {
  readonly authenticatedApplicationId: string;
  waitForVoiceMember(memberId: string, timeoutMilliseconds: number): Promise<void>;
}

interface ConnectedDiscordVoiceActorOptions {
  readonly client: Client;
  readonly connect: () => Promise<VoiceConnection>;
  readonly fixturePath: string;
  readonly guild: Guild;
  readonly initialConnection: VoiceConnection;
  readonly authenticatedApplicationId: string;
  readonly playbackTimeoutMilliseconds: number;
  readonly voiceChannelId: string;
}

class ConnectedDiscordVoiceActor implements RecorderAwareVoiceActor {
  public readonly authenticatedApplicationId: string;
  private connection: VoiceConnection | undefined;

  constructor(private readonly options: ConnectedDiscordVoiceActorOptions) {
    this.authenticatedApplicationId = options.authenticatedApplicationId;
    this.connection = options.initialConnection;
  }

  async waitForVoiceMember(memberId: string, timeoutMilliseconds: number): Promise<void> {
    if (this.options.guild.voiceStates.cache.get(memberId)?.channelId === this.options.voiceChannelId) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Recorder bot ${memberId} did not join the E2E voice channel`));
      }, timeoutMilliseconds);
      const onVoiceStateUpdate = (): void => {
        if (this.options.guild.voiceStates.cache.get(memberId)?.channelId === this.options.voiceChannelId) {
          cleanup();
          resolve();
        }
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.options.client.off("voiceStateUpdate", onVoiceStateUpdate);
      };
      this.options.client.on("voiceStateUpdate", onVoiceStateUpdate);
    });
  }

  async play(lifecycle: VoicePlaybackLifecycleObserver): Promise<void> {
    const connection = this.connection;
    if (connection === undefined) {
      throw new Error("Discord voice actor is not connected");
    }
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    const subscription = connection.subscribe(player);
    if (subscription === undefined) {
      throw new Error("Discord voice connection rejected the audio subscription");
    }

    try {
      player.play(createOggOpusAudioResource(this.options.fixturePath));
      // Playing excludes local resource buffering; the first Discord voice dispatch follows on
      // the next player tick. It is a sender-side boundary, not a remote Craig receive ack.
      await entersState(player, AudioPlayerStatus.Playing, this.options.playbackTimeoutMilliseconds);
      lifecycle.onPlaying();
      await entersState(player, AudioPlayerStatus.Idle, this.options.playbackTimeoutMilliseconds);
      lifecycle.onIdle();
    } finally {
      player.stop(true);
      subscription.unsubscribe();
    }
  }

  async reconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    connection?.destroy();
    this.connection = await this.options.connect();
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    connection?.destroy();
    await this.options.client.destroy();
  }
}

export function createOggOpusAudioResource(path: string) {
  return createAudioResource(createReadStream(path), { inputType: StreamType.OggOpus });
}

export async function connectDiscordVoiceActor(
  input: DiscordVoiceActorInput,
): Promise<RecorderAwareVoiceActor> {
  await access(input.fixturePath);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  let connection: VoiceConnection | undefined;

  try {
    await client.login(input.token);
    const authenticatedApplicationId = assertExpectedOfficialBotApplication(
      client.user,
      input.expectedApplicationId,
    );
    const guild = await client.guilds.fetch(input.guildId);
    const channel = await guild.channels.fetch(input.voiceChannelId);
    assertConnectableVoiceChannel(channel);

    const connect = async (): Promise<VoiceConnection> => {
      const nextConnection = joinVoiceChannel({
        adapterCreator: guild.voiceAdapterCreator,
        channelId: channel.id,
        guildId: guild.id,
        group: input.name,
        selfDeaf: true,
        selfMute: false,
      });
      try {
        await entersState(
          nextConnection,
          VoiceConnectionStatus.Ready,
          input.readyTimeoutMilliseconds,
        );
        return nextConnection;
      } catch (error: unknown) {
        nextConnection.destroy();
        throw error;
      }
    };
    connection = await connect();

    return new ConnectedDiscordVoiceActor({
      client,
      connect,
      authenticatedApplicationId,
      fixturePath: input.fixturePath,
      guild,
      initialConnection: connection,
      playbackTimeoutMilliseconds: input.playbackTimeoutMilliseconds,
      voiceChannelId: channel.id,
    });
  } catch (error: unknown) {
    connection?.destroy();
    await client.destroy();
    throw error;
  }
}

export function assertExpectedOfficialBotApplication(
  authenticatedUser: { readonly bot: boolean; readonly id: string } | null,
  expectedApplicationId?: string,
): string {
  if (authenticatedUser === null || !authenticatedUser.bot) {
    throw new Error("Discord voice actor must authenticate as an official bot application");
  }
  if (expectedApplicationId !== undefined && authenticatedUser.id !== expectedApplicationId) {
    throw new Error("Discord voice actor application ID does not match its authenticated bot");
  }
  return authenticatedUser.id;
}

function assertConnectableVoiceChannel(
  channel: GuildBasedChannel | null,
): asserts channel is VoiceChannel {
  if (channel === null || channel.type !== ChannelType.GuildVoice) {
    throw new Error("Configured Discord channel is not a guild voice channel");
  }
}
