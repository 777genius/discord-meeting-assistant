import type {
  PublicationTargetResolverPort,
  RecordingSource,
} from "../../application/recording-ingress.js";

interface DiscordPublicationTargetRequest {
  readonly roomId: string;
  readonly sourceId: string;
}

export class DiscordPublicationTargetResolver implements PublicationTargetResolverPort {
  public constructor(
    private readonly configured: {
      execute(request: DiscordPublicationTargetRequest): Promise<
        | { readonly publicationTargetId: string; readonly status: "configured" }
        | { readonly status: "not-configured" | "room-not-configured" }
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
      roomId: source.roomId,
      sourceId: source.scopeId,
    };
    const result = await this.configured.execute(request);
    if (result.status === "configured") {
      return result.publicationTargetId;
    }
    return this.legacy?.guildId === request.sourceId &&
      this.legacy.voiceChannelId === request.roomId
      ? this.legacy.publicationTargetId
      : null;
  }
}
