import { MeetingSourceConfiguration } from "../domain/meeting-source-configuration.js";
import type { MeetingSourceConfigurationRepository } from "./ports.js";

export type ResolveMeetingPublicationTargetResult =
  | { readonly publicationTargetId: string; readonly status: "configured" }
  | { readonly status: "not-configured" | "room-not-configured" };

export class ResolveMeetingPublicationTarget {
  public constructor(
    private readonly repository: MeetingSourceConfigurationRepository,
  ) {}

  public async execute(input: {
    readonly roomId: string;
    readonly sourceId: string;
  }): Promise<ResolveMeetingPublicationTargetResult> {
    const stored = await this.repository.findBySourceId(input.sourceId);
    if (stored === null) {
      return { status: "not-configured" };
    }
    const configuration = MeetingSourceConfiguration.restore(stored);
    if (!configuration.matchesRoom(input.roomId)) {
      return { status: "room-not-configured" };
    }
    return {
      publicationTargetId: configuration.toSnapshot().publicationTargetId,
      status: "configured",
    };
  }
}
