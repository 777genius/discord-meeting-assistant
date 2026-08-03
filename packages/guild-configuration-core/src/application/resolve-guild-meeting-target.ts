import { GuildConfiguration } from "../domain/guild-configuration.js";
import type { GuildConfigurationRepository } from "./ports.js";

export type ResolveGuildMeetingTargetResult =
  | { readonly publicationTargetId: string; readonly status: "configured" }
  | { readonly status: "not-configured" | "voice-channel-not-configured" };

export class ResolveGuildMeetingTarget {
  public constructor(private readonly repository: GuildConfigurationRepository) {}

  public async execute(input: {
    readonly guildId: string;
    readonly voiceChannelId: string;
  }): Promise<ResolveGuildMeetingTargetResult> {
    const stored = await this.repository.findByGuildId(input.guildId);
    if (stored === null) {
      return { status: "not-configured" };
    }
    const configuration = GuildConfiguration.restore(stored);
    if (!configuration.matchesVoiceChannel(input.voiceChannelId)) {
      return { status: "voice-channel-not-configured" };
    }
    return {
      publicationTargetId: configuration.toSnapshot().resultsChannelId,
      status: "configured",
    };
  }
}
