const discordSnowflake = /^\d{17,20}$/u;

export type GuildConfigurationStatus = "active";

export interface GuildConfigurationSnapshot {
  readonly configuredByUserId: string;
  readonly guildId: string;
  readonly resultsChannelId: string;
  readonly revision: number;
  readonly status: GuildConfigurationStatus;
  readonly voiceChannelId: string;
}

export interface ConfigureGuildChannels {
  readonly configuredByUserId: string;
  readonly guildId: string;
  readonly resultsChannelId: string;
  readonly voiceChannelId: string;
}

export class InvalidGuildConfigurationError extends Error {
  public override readonly name = "InvalidGuildConfigurationError";
}

function requireSnowflake(value: string, field: string): string {
  if (typeof value !== "string" || !discordSnowflake.test(value)) {
    throw new InvalidGuildConfigurationError(`${field} must be a Discord snowflake`);
  }
  return value;
}

function requireRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidGuildConfigurationError("revision must be a non-negative safe integer");
  }
  return value;
}

function normalize(input: GuildConfigurationSnapshot): GuildConfigurationSnapshot {
  const rawStatus: unknown = input.status;
  if (rawStatus !== "active") {
    throw new InvalidGuildConfigurationError("status must be active");
  }
  return Object.freeze({
    configuredByUserId: requireSnowflake(input.configuredByUserId, "configuredByUserId"),
    guildId: requireSnowflake(input.guildId, "guildId"),
    resultsChannelId: requireSnowflake(input.resultsChannelId, "resultsChannelId"),
    revision: requireRevision(input.revision),
    status: rawStatus,
    voiceChannelId: requireSnowflake(input.voiceChannelId, "voiceChannelId"),
  });
}

export class GuildConfiguration {
  private constructor(private readonly snapshot: GuildConfigurationSnapshot) {}

  public static configure(input: ConfigureGuildChannels): GuildConfiguration {
    return new GuildConfiguration(normalize({ ...input, revision: 0, status: "active" }));
  }

  public static restore(snapshot: GuildConfigurationSnapshot): GuildConfiguration {
    return new GuildConfiguration(normalize(snapshot));
  }

  public get guildId(): string {
    return this.snapshot.guildId;
  }

  public get revision(): number {
    return this.snapshot.revision;
  }

  public matchesChannels(voiceChannelId: string, resultsChannelId: string): boolean {
    return this.snapshot.voiceChannelId === voiceChannelId &&
      this.snapshot.resultsChannelId === resultsChannelId;
  }

  public matchesVoiceChannel(voiceChannelId: string): boolean {
    return this.snapshot.voiceChannelId === voiceChannelId;
  }

  public reconfigure(input: ConfigureGuildChannels): GuildConfiguration {
    if (input.guildId !== this.snapshot.guildId) {
      throw new InvalidGuildConfigurationError("guild identity cannot change");
    }
    requireSnowflake(input.configuredByUserId, "configuredByUserId");
    requireSnowflake(input.voiceChannelId, "voiceChannelId");
    requireSnowflake(input.resultsChannelId, "resultsChannelId");
    if (this.matchesChannels(input.voiceChannelId, input.resultsChannelId)) {
      return this;
    }
    if (this.snapshot.revision === Number.MAX_SAFE_INTEGER) {
      throw new InvalidGuildConfigurationError("revision cannot be incremented safely");
    }
    return new GuildConfiguration(normalize({
      ...input,
      revision: this.snapshot.revision + 1,
      status: "active",
    }));
  }

  public toSnapshot(): GuildConfigurationSnapshot {
    return this.snapshot;
  }
}
