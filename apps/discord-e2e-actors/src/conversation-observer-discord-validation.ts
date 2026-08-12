import { ChannelType, type Client, type Guild, type GuildBasedChannel, type VoiceChannel } from
  "discord.js";

export function requiredAuthenticatedBotId(client: Client): string {
  const authenticatedUser = client.user;
  if (authenticatedUser === null) {
    throw new Error("Conversation voice observer did not receive an authenticated bot user");
  }
  if (!authenticatedUser.bot) {
    throw new Error("Conversation voice observer must authenticate as an official bot application");
  }
  return authenticatedUser.id;
}

export async function assertConfiguredCraigBotIsInVoiceChannel(
  client: Client,
  guild: Guild,
  craigBotId: string,
  voiceChannelId: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const member = await guild.members.fetch(craigBotId);
  if (!member.user.bot) { throw new Error("Configured Craig identity is not a Discord bot"); }
  if (guild.voiceStates.cache.get(craigBotId)?.channelId === voiceChannelId) { return; }
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

export function assertConnectableVoiceChannel(
  channel: GuildBasedChannel | null,
): asserts channel is VoiceChannel {
  if (channel === null || channel.type !== ChannelType.GuildVoice) {
    throw new Error("Configured Discord channel is not a guild voice channel");
  }
}
