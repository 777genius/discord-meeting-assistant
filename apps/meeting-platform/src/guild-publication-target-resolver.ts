export interface GuildPublicationTargetRequest {
  readonly guildId: string;
  readonly voiceChannelId: string;
}

interface GuildPublicationTargetResolverPort {
  resolve(request: GuildPublicationTargetRequest): Promise<string | null>;
}

export class GuildPublicationTargetResolver implements GuildPublicationTargetResolverPort {
  public constructor(
    private readonly configured: {
      execute(request: GuildPublicationTargetRequest): Promise<
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

  public async resolve(request: GuildPublicationTargetRequest): Promise<string | null> {
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
