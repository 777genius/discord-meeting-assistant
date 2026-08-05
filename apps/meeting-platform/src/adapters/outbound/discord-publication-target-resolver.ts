import type {
  PublicationTargetResolverPort,
  RecordingSource,
} from "../../application/recording-ingress.js";

interface DiscordPublicationTargetRequest {
  readonly guildId: string;
  readonly voiceChannelId: string;
}

export class DiscordPublicationTargetResolver implements PublicationTargetResolverPort {
  public constructor(
    private readonly configured: {
      execute(request: DiscordPublicationTargetRequest): Promise<
        | { readonly publicationTargetId: string; readonly status: "configured" }
        | { readonly status: "not-configured" | "voice-channel-not-configured" }
      >;
    },
    private readonly legacy?: {
      readonly guildId: string;
      readonly publicationTargetId: string;
      readonly voiceChannelId: string;
    },
  ) {}

  public async resolve(source: RecordingSource): Promise<string | null> {
    const request = {
      guildId: source.scopeId,
      voiceChannelId: source.roomId,
    };
    const result = await this.configured.execute(request);
    if (result.status === "configured") {
      return result.publicationTargetId;
    }
    return this.legacy?.guildId === request.guildId &&
      this.legacy.voiceChannelId === request.voiceChannelId
      ? this.legacy.publicationTargetId
      : null;
  }
}
