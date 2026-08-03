import type { GuildConfigurationSnapshot } from "../domain/guild-configuration.js";

export type GuildConfigurationSaveResult =
  | { readonly status: "saved" }
  | { readonly actualRevision: number; readonly status: "conflict" };

export interface GuildConfigurationRepository {
  findByGuildId(guildId: string): Promise<GuildConfigurationSnapshot | null>;
  save(
    snapshot: GuildConfigurationSnapshot,
    expectedRevision: number | null,
  ): Promise<GuildConfigurationSaveResult>;
}

export type GuildSetupFailureCode =
  | "actor-not-authorized"
  | "craig-not-installed"
  | "craig-voice-permission-missing"
  | "platform-results-permission-missing"
  | "results-channel-invalid"
  | "setup-publication-failed"
  | "voice-channel-invalid";

export interface GuildSetupFailure {
  readonly code: GuildSetupFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface GuildConfigurationVerificationRequest {
  readonly configuredByUserId: string;
  readonly guildId: string;
  readonly resultsChannelId: string;
  readonly voiceChannelId: string;
}

export interface GuildConfigurationVerificationPort {
  verify(
    request: GuildConfigurationVerificationRequest,
  ): Promise<{ readonly ok: true } | { readonly failure: GuildSetupFailure; readonly ok: false }>;
}

export interface GuildSetupPublicationRequest {
  readonly configuredByUserId: string;
  readonly configurationRevision: number;
  readonly guildId: string;
  readonly idempotencyKey: string;
  readonly resultsChannelId: string;
  readonly voiceChannelId: string;
}

export interface GuildSetupPublisher {
  publish(
    request: GuildSetupPublicationRequest,
  ): Promise<{ readonly ok: true } | { readonly failure: GuildSetupFailure; readonly ok: false }>;
}
