import { isAbsolute } from "node:path";

import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, "Expected a Discord snowflake");
const accountSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);

const capacityEnvironmentSchema = z.object({
  DISCORD_E2E_CAPACITY_ACCOUNTS: z.string().min(1),
  DISCORD_E2E_CAPACITY_EVIDENCE_OUTPUT: z.string().refine(isAbsolute)
    .default("/tmp/discord-meeting-capacity-e2e.json"),
  DISCORD_E2E_CAPACITY_FIXTURE_A: z.string().min(1)
    .default("test/fixtures/speaker-a.ru-en.ogg"),
  DISCORD_E2E_CAPACITY_FIXTURE_B: z.string().min(1)
    .default("test/fixtures/speaker-b.ru-en.ogg"),
  DISCORD_E2E_GUILD_ID: snowflakeSchema,
  DISCORD_E2E_KEYCHAIN_SERVICE: z.string().min(1).default("discord-voice-bot-e2e"),
  DISCORD_E2E_PLAYBACK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000)
    .default(120_000),
  DISCORD_E2E_POST_PLAYBACK_HOLD_MS: z.coerce.number().int().min(0).max(600_000)
    .default(5_000),
  DISCORD_E2E_READY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000)
    .default(30_000),
  DISCORD_E2E_RECORDER_BOT_ID: snowflakeSchema.default("1533224474609057793"),
  DISCORD_E2E_SECRET_DIRECTORY: z.string().refine(isAbsolute).optional(),
  DISCORD_E2E_VOICE_CHANNEL_ID: snowflakeSchema,
});

interface CapacityActorConfig {
  readonly account: string;
  readonly fixturePath: string;
  readonly name: string;
}

export interface CapacityConfig {
  readonly actors: readonly CapacityActorConfig[];
  readonly evidenceOutputPath: string;
  readonly guildId: string;
  readonly keychainService: string;
  readonly playbackTimeoutMilliseconds: number;
  readonly postPlaybackHoldMilliseconds: number;
  readonly readyTimeoutMilliseconds: number;
  readonly recorderBotId: string;
  readonly secretDirectory: string | undefined;
  readonly voiceChannelId: string;
}

export function loadCapacityConfig(environment: NodeJS.ProcessEnv): CapacityConfig {
  const parsed = capacityEnvironmentSchema.parse(environment);
  const accounts = parsed.DISCORD_E2E_CAPACITY_ACCOUNTS
    .split(",")
    .map((account) => account.trim())
    .filter((account) => account.length > 0)
    .map((account) => accountSchema.parse(account));
  if (accounts.length < 2 || accounts.length > 10) {
    throw new Error("Capacity E2E requires between 2 and 10 actor accounts");
  }
  if (new Set(accounts).size !== accounts.length) {
    throw new Error("Capacity E2E actor accounts must be unique");
  }

  return {
    actors: Object.freeze(accounts.map((account, index) => ({
      account,
      fixturePath: index % 2 === 0
        ? parsed.DISCORD_E2E_CAPACITY_FIXTURE_A
        : parsed.DISCORD_E2E_CAPACITY_FIXTURE_B,
      name: `capacity-speaker-${index + 1}`,
    }))),
    evidenceOutputPath: parsed.DISCORD_E2E_CAPACITY_EVIDENCE_OUTPUT,
    guildId: parsed.DISCORD_E2E_GUILD_ID,
    keychainService: parsed.DISCORD_E2E_KEYCHAIN_SERVICE,
    playbackTimeoutMilliseconds: parsed.DISCORD_E2E_PLAYBACK_TIMEOUT_MS,
    postPlaybackHoldMilliseconds: parsed.DISCORD_E2E_POST_PLAYBACK_HOLD_MS,
    readyTimeoutMilliseconds: parsed.DISCORD_E2E_READY_TIMEOUT_MS,
    recorderBotId: parsed.DISCORD_E2E_RECORDER_BOT_ID,
    secretDirectory: parsed.DISCORD_E2E_SECRET_DIRECTORY,
    voiceChannelId: parsed.DISCORD_E2E_VOICE_CHANNEL_ID,
  };
}
