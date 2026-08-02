import { isAbsolute } from "node:path";

import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, "Expected a Discord snowflake");
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const absoluteOutputPathSchema = z.string()
  .min(1)
  .refine((value) => isAbsolute(value) && value !== "/", "Expected an absolute output file path");
const absoluteDirectorySchema = z.string()
  .min(1)
  .refine(isAbsolute, "Expected an absolute directory path");

const environmentSchema = z.object({
  DISCORD_E2E_LIVE_DURATION_MS: z.coerce.number().int().min(1_000).max(600_000),
  DISCORD_E2E_LIVE_KEYCHAIN_SERVICE: z.string().trim().min(1).default("discord-voice-bot-e2e"),
  DISCORD_E2E_LIVE_OUTPUT: absoluteOutputPathSchema,
  DISCORD_E2E_LIVE_POLL_INTERVAL_MS: z.coerce.number().int().min(2_000).max(5_000),
  DISCORD_E2E_LIVE_RESULT_CHANNEL_ID: snowflakeSchema,
  DISCORD_E2E_LIVE_RUN_ID: runIdSchema,
  DISCORD_E2E_LIVE_SECRET_DIRECTORY: absoluteDirectorySchema.optional(),
  DISCORD_E2E_LIVE_SUT_ACCOUNT: z.string().trim().min(1).max(64).default("sut"),
  DISCORD_E2E_LIVE_SUT_APPLICATION_ID: snowflakeSchema,
});

export interface LiveDiscordObserverConfig {
  readonly durationMilliseconds: number;
  readonly keychainService: string;
  readonly outputPath: string;
  readonly pollIntervalMilliseconds: number;
  readonly resultChannelId: string;
  readonly runId: string;
  readonly secretDirectory: string | undefined;
  readonly sutAccount: string;
  readonly sutApplicationId: string;
}

export function loadLiveDiscordObserverConfig(
  environment: NodeJS.ProcessEnv,
): LiveDiscordObserverConfig {
  const parsed = environmentSchema.parse(environment);
  return Object.freeze({
    durationMilliseconds: parsed.DISCORD_E2E_LIVE_DURATION_MS,
    keychainService: parsed.DISCORD_E2E_LIVE_KEYCHAIN_SERVICE,
    outputPath: parsed.DISCORD_E2E_LIVE_OUTPUT,
    pollIntervalMilliseconds: parsed.DISCORD_E2E_LIVE_POLL_INTERVAL_MS,
    resultChannelId: parsed.DISCORD_E2E_LIVE_RESULT_CHANNEL_ID,
    runId: parsed.DISCORD_E2E_LIVE_RUN_ID,
    secretDirectory: parsed.DISCORD_E2E_LIVE_SECRET_DIRECTORY,
    sutAccount: parsed.DISCORD_E2E_LIVE_SUT_ACCOUNT,
    sutApplicationId: parsed.DISCORD_E2E_LIVE_SUT_APPLICATION_ID,
  });
}
