import { isAbsolute } from "node:path";

import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, "Expected a Discord snowflake");
const correlationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);

const actorEnvironmentSchema = z.object({
  DISCORD_E2E_GUILD_ID: snowflakeSchema,
  DISCORD_E2E_VOICE_CHANNEL_ID: snowflakeSchema,
  DISCORD_E2E_SCENARIO: z.enum(["overlap", "sequential", "reconnect"]).default("overlap"),
  DISCORD_E2E_SPEAKER_A_FIXTURE: z.string().min(1).default("test/fixtures/speaker-a.ru-en.ogg"),
  DISCORD_E2E_SPEAKER_B_FIXTURE: z.string().min(1).default("test/fixtures/speaker-b.ru-en.ogg"),
  DISCORD_E2E_KEYCHAIN_SERVICE: z.string().min(1).default("discord-voice-bot-e2e"),
  DISCORD_E2E_SECRET_DIRECTORY: z.string().refine(isAbsolute).optional(),
  DISCORD_E2E_SPEAKER_A_ACCOUNT: z.string().min(1).default("speaker-a"),
  DISCORD_E2E_SPEAKER_B_ACCOUNT: z.string().min(1).default("speaker-b"),
  DISCORD_E2E_SPEAKER_B_CONNECT_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(0),
  DISCORD_E2E_SPEAKER_B_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(750),
  DISCORD_E2E_READY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  DISCORD_E2E_PLAYBACK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  DISCORD_E2E_PRE_PLAYBACK_HOLD_MS: z.coerce.number().int().min(0).max(600_000).default(0),
  DISCORD_E2E_POST_PLAYBACK_HOLD_MS: z.coerce.number().int().min(0).max(600_000).default(0),
  DISCORD_E2E_RECORDER_BOT_ID: snowflakeSchema.default("1533224474609057793"),
  DISCORD_E2E_ACTOR_RUN_OUTPUT: z.string().refine(isAbsolute).default("/tmp/discord-meeting-e2e-actor-run.json"),
  DISCORD_E2E_FIXTURE_MANIFEST: z.string().min(1).default("test/fixtures/manifest.v1.json"),
  DISCORD_E2E_RUN_ID: correlationIdSchema,
});

export interface ActorConfig {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly keychainService: string;
  readonly secretDirectory: string | undefined;
  readonly scenario: "overlap" | "sequential" | "reconnect";
  readonly speakerBConnectDelayMilliseconds: number;
  readonly speakerBDelayMilliseconds: number;
  readonly readyTimeoutMilliseconds: number;
  readonly playbackTimeoutMilliseconds: number;
  readonly prePlaybackHoldMilliseconds: number;
  readonly postPlaybackHoldMilliseconds: number;
  readonly recorderBotId: string;
  readonly actorRunOutputPath: string;
  readonly fixtureManifestPath: string;
  readonly runId: string;
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
    secretDirectory: parsed.DISCORD_E2E_SECRET_DIRECTORY,
    scenario: parsed.DISCORD_E2E_SCENARIO,
    speakerBConnectDelayMilliseconds: parsed.DISCORD_E2E_SPEAKER_B_CONNECT_DELAY_MS,
    speakerBDelayMilliseconds: parsed.DISCORD_E2E_SPEAKER_B_DELAY_MS,
    readyTimeoutMilliseconds: parsed.DISCORD_E2E_READY_TIMEOUT_MS,
    playbackTimeoutMilliseconds: parsed.DISCORD_E2E_PLAYBACK_TIMEOUT_MS,
    prePlaybackHoldMilliseconds: parsed.DISCORD_E2E_PRE_PLAYBACK_HOLD_MS,
    postPlaybackHoldMilliseconds: parsed.DISCORD_E2E_POST_PLAYBACK_HOLD_MS,
    recorderBotId: parsed.DISCORD_E2E_RECORDER_BOT_ID,
    actorRunOutputPath: parsed.DISCORD_E2E_ACTOR_RUN_OUTPUT,
    fixtureManifestPath: parsed.DISCORD_E2E_FIXTURE_MANIFEST,
    runId: parsed.DISCORD_E2E_RUN_ID,
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
