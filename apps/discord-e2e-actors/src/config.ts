import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, "Expected a Discord snowflake");

const actorEnvironmentSchema = z.object({
  DISCORD_E2E_GUILD_ID: snowflakeSchema,
  DISCORD_E2E_VOICE_CHANNEL_ID: snowflakeSchema,
  DISCORD_E2E_SCENARIO: z.enum(["overlap", "sequential", "reconnect"]).default("overlap"),
  DISCORD_E2E_SPEAKER_A_FIXTURE: z.string().min(1).default("test/fixtures/speaker-a.ogg"),
  DISCORD_E2E_SPEAKER_B_FIXTURE: z.string().min(1).default("test/fixtures/speaker-b.ogg"),
  DISCORD_E2E_KEYCHAIN_SERVICE: z.string().min(1).default("discord-voice-bot-e2e"),
  DISCORD_E2E_SPEAKER_A_ACCOUNT: z.string().min(1).default("speaker-a"),
  DISCORD_E2E_SPEAKER_B_ACCOUNT: z.string().min(1).default("speaker-b"),
  DISCORD_E2E_SPEAKER_B_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(750),
  DISCORD_E2E_READY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  DISCORD_E2E_PLAYBACK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
});

export interface ActorConfig {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly keychainService: string;
  readonly scenario: "overlap" | "sequential" | "reconnect";
  readonly speakerBDelayMilliseconds: number;
  readonly readyTimeoutMilliseconds: number;
  readonly playbackTimeoutMilliseconds: number;
  readonly speakers: readonly [
    { readonly name: "speaker-a"; readonly account: string; readonly fixturePath: string },
    { readonly name: "speaker-b"; readonly account: string; readonly fixturePath: string },
  ];
}

export function loadActorConfig(environment: NodeJS.ProcessEnv): ActorConfig {
  const parsed = actorEnvironmentSchema.parse(environment);
  return {
    guildId: parsed.DISCORD_E2E_GUILD_ID,
    voiceChannelId: parsed.DISCORD_E2E_VOICE_CHANNEL_ID,
    keychainService: parsed.DISCORD_E2E_KEYCHAIN_SERVICE,
    scenario: parsed.DISCORD_E2E_SCENARIO,
    speakerBDelayMilliseconds: parsed.DISCORD_E2E_SPEAKER_B_DELAY_MS,
    readyTimeoutMilliseconds: parsed.DISCORD_E2E_READY_TIMEOUT_MS,
    playbackTimeoutMilliseconds: parsed.DISCORD_E2E_PLAYBACK_TIMEOUT_MS,
    speakers: [
      {
        name: "speaker-a",
        account: parsed.DISCORD_E2E_SPEAKER_A_ACCOUNT,
        fixturePath: parsed.DISCORD_E2E_SPEAKER_A_FIXTURE,
      },
      {
        name: "speaker-b",
        account: parsed.DISCORD_E2E_SPEAKER_B_ACCOUNT,
        fixturePath: parsed.DISCORD_E2E_SPEAKER_B_FIXTURE,
      },
    ],
  };
}
