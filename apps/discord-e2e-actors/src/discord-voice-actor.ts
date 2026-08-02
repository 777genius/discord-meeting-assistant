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

import type { ReconnectableVoiceActor } from "./run-actor-scenario.js";

export interface DiscordVoiceActorInput {
  readonly name: string;
  readonly token: string;
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly fixturePath: string;
  readonly readyTimeoutMilliseconds: number;
  readonly playbackTimeoutMilliseconds: number;
}

export interface RecorderAwareVoiceActor extends ReconnectableVoiceActor {
  waitForVoiceMember(memberId: string, timeoutMilliseconds: number): Promise<void>;
}

class ConnectedDiscordVoiceActor implements RecorderAwareVoiceActor {
  constructor(
    private readonly client: Client,
    private connection: VoiceConnection | undefined,
    private readonly connect: () => Promise<VoiceConnection>,
    private readonly fixturePath: string,
    private readonly playbackTimeoutMilliseconds: number,
    private readonly guild: Guild,
    private readonly voiceChannelId: string,
  ) {}

  async waitForVoiceMember(memberId: string, timeoutMilliseconds: number): Promise<void> {
    if (this.guild.voiceStates.cache.get(memberId)?.channelId === this.voiceChannelId) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Recorder bot ${memberId} did not join the E2E voice channel`));
      }, timeoutMilliseconds);
      const onVoiceStateUpdate = (): void => {
        if (this.guild.voiceStates.cache.get(memberId)?.channelId === this.voiceChannelId) {
          cleanup();
          resolve();
        }
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.client.off("voiceStateUpdate", onVoiceStateUpdate);
      };
      this.client.on("voiceStateUpdate", onVoiceStateUpdate);
    });
  }

  async play(): Promise<void> {
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
      player.play(createAudioResource(this.fixturePath, { inputType: StreamType.OggOpus }));
      await entersState(player, AudioPlayerStatus.Idle, this.playbackTimeoutMilliseconds);
    } finally {
      player.stop(true);
      subscription.unsubscribe();
    }
  }

  async reconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    connection?.destroy();
    this.connection = await this.connect();
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    connection?.destroy();
    await this.client.destroy();
  }
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

    return new ConnectedDiscordVoiceActor(
      client,
      connection,
      connect,
      input.fixturePath,
      input.playbackTimeoutMilliseconds,
      guild,
      channel.id,
    );
  } catch (error: unknown) {
    connection?.destroy();
    await client.destroy();
    throw error;
  }
}

function assertConnectableVoiceChannel(
  channel: GuildBasedChannel | null,
): asserts channel is VoiceChannel {
  if (channel === null || channel.type !== ChannelType.GuildVoice) {
    throw new Error("Configured Discord channel is not a guild voice channel");
  }
}
