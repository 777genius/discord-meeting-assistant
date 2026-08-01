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
  type GuildBasedChannel,
  type VoiceChannel,
} from "discord.js";

import type { VoiceActor } from "./run-actor-scenario.js";

export interface DiscordVoiceActorInput {
  readonly name: string;
  readonly token: string;
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly fixturePath: string;
  readonly readyTimeoutMilliseconds: number;
  readonly playbackTimeoutMilliseconds: number;
}

class ConnectedDiscordVoiceActor implements VoiceActor {
  constructor(
    private readonly client: Client,
    private readonly connection: VoiceConnection,
    private readonly fixturePath: string,
    private readonly playbackTimeoutMilliseconds: number,
  ) {}

  async play(): Promise<void> {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    const subscription = this.connection.subscribe(player);
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

  async close(): Promise<void> {
    this.connection.destroy();
    await this.client.destroy();
  }
}

export async function connectDiscordVoiceActor(
  input: DiscordVoiceActorInput,
): Promise<VoiceActor> {
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

    connection = joinVoiceChannel({
      adapterCreator: guild.voiceAdapterCreator,
      channelId: channel.id,
      guildId: guild.id,
      group: input.name,
      selfDeaf: true,
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, input.readyTimeoutMilliseconds);

    return new ConnectedDiscordVoiceActor(
      client,
      connection,
      input.fixturePath,
      input.playbackTimeoutMilliseconds,
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
