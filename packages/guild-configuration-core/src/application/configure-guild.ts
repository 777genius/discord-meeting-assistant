import {
  GuildConfiguration,
  type GuildConfigurationSnapshot,
} from "../domain/guild-configuration.js";
import type {
  GuildConfigurationRepository,
  GuildConfigurationVerificationPort,
  GuildSetupFailure,
  GuildSetupPublisher,
} from "./ports.js";

export interface ConfigureGuildInput {
  readonly configuredByUserId: string;
  readonly guildId: string;
  readonly resultsChannelId: string;
  readonly voiceChannelId: string;
}

export type ConfigureGuildResult =
  | {
      readonly configuration: GuildConfigurationSnapshot;
      readonly idempotencyKey: string;
      readonly status: "configured" | "reused";
    }
  | { readonly actualRevision: number; readonly status: "conflict" }
  | { readonly failure: GuildSetupFailure; readonly status: "rejected" };

export class ConfigureGuild {
  public constructor(
    private readonly repository: GuildConfigurationRepository,
    private readonly verifier: GuildConfigurationVerificationPort,
    private readonly publisher: GuildSetupPublisher,
  ) {}

  public async execute(input: ConfigureGuildInput): Promise<ConfigureGuildResult> {
    const stored = await this.repository.findByGuildId(input.guildId);
    const current = stored === null ? null : GuildConfiguration.restore(stored);
    const verification = await this.verifier.verify(input);
    if (!verification.ok) {
      return { failure: verification.failure, status: "rejected" };
    }
    if (
      current !== null &&
      current.matchesChannels(input.voiceChannelId, input.resultsChannelId)
    ) {
      const configuration = current.toSnapshot();
      return {
        configuration,
        idempotencyKey: setupIdempotencyKey(configuration),
        status: "reused",
      };
    }
    const next = current === null
      ? GuildConfiguration.configure(input)
      : current.reconfigure(input);
    const configuration = next.toSnapshot();
    const idempotencyKey = setupIdempotencyKey(configuration);
    const publication = await this.publisher.publish({
      ...input,
      configurationRevision: configuration.revision,
      idempotencyKey,
    });
    if (!publication.ok) {
      return { failure: publication.failure, status: "rejected" };
    }
    const saved = await this.repository.save(configuration, current?.revision ?? null);
    if (saved.status === "conflict") {
      return saved;
    }
    return { configuration, idempotencyKey, status: "configured" };
  }
}

function setupIdempotencyKey(configuration: GuildConfigurationSnapshot): string {
  return `guild-setup:v1|${configuration.guildId}|${configuration.revision}|${configuration.voiceChannelId}|${configuration.resultsChannelId}`;
}
