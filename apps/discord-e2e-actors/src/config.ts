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
  DISCORD_E2E_SPEAKER_B_CONNECT_DELAY_MS: z.coerce.number().int().min(0).max(120_000).default(0),
  DISCORD_E2E_SPEAKER_B_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(750),
  DISCORD_E2E_READY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  DISCORD_E2E_PLAYBACK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  DISCORD_E2E_PRE_PLAYBACK_HOLD_MS: z.coerce.number().int().min(0).max(600_000).default(0),
  DISCORD_E2E_POST_PLAYBACK_HOLD_MS: z.coerce.number().int().min(0).max(600_000).default(0),
  DISCORD_E2E_RECORDER_BOT_ID: snowflakeSchema.default("1533224474609057793"),
  DISCORD_E2E_ACTOR_RUN_OUTPUT: z.string().refine(isAbsolute).default("/tmp/discord-meeting-e2e-actor-run.json"),
  DISCORD_E2E_FIXTURE_MANIFEST: z.string().min(1).default("test/fixtures/manifest.v1.json"),
  DISCORD_E2E_RUN_ID: correlationIdSchema,
  DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: z.string().refine(isAbsolute).optional(),
  DISCORD_E2E_HOSTED_RELEASE_GATE_ARMED_PATH: z.string().refine(isAbsolute).optional(),
  DISCORD_E2E_HOSTED_PLAYBACK_GATE_PATH: z.string().refine(isAbsolute).optional(),
  DISCORD_E2E_HOSTED_PLAYBACK_GATE_ARMED_PATH: z.string().refine(isAbsolute).optional(),
  DISCORD_E2E_HOSTED_END_GATE_PATH: z.string().refine(isAbsolute).optional(),
  DISCORD_E2E_HOSTED_END_GATE_ARMED_PATH: z.string().refine(isAbsolute).optional(),
  DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: correlationIdSchema.optional(),
  DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).optional(),
}).superRefine((value, context) => {
  const releaseGateValues = [
    value.DISCORD_E2E_HOSTED_RELEASE_GATE_PATH,
    value.DISCORD_E2E_HOSTED_RELEASE_GATE_ARMED_PATH,
    value.DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID,
    value.DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS,
  ];
  const configuredValues = releaseGateValues.filter((entry) => entry !== undefined).length;
  if (configuredValues !== 0 && configuredValues !== releaseGateValues.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Hosted release gate path, campaign ID, and timeout must be configured together",
      path: ["DISCORD_E2E_HOSTED_RELEASE_GATE_PATH"],
    });
  }
  for (const [name, pair] of [
    ["playback", [value.DISCORD_E2E_HOSTED_PLAYBACK_GATE_PATH, value.DISCORD_E2E_HOSTED_PLAYBACK_GATE_ARMED_PATH]],
    ["end", [value.DISCORD_E2E_HOSTED_END_GATE_PATH, value.DISCORD_E2E_HOSTED_END_GATE_ARMED_PATH]],
  ] as const) {
    if (pair.filter((entry) => entry !== undefined).length === 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Hosted ${name} gate path and armed path must be configured together` });
    }
  }
  const stagedGateCount = [value.DISCORD_E2E_HOSTED_PLAYBACK_GATE_PATH, value.DISCORD_E2E_HOSTED_END_GATE_PATH]
    .filter((entry) => entry !== undefined).length;
  if (stagedGateCount !== 0 && (configuredValues !== releaseGateValues.length || stagedGateCount !== 2)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Hosted connection, playback, and end gates must form one complete lifecycle" });
  }
});

export interface ActorReleaseGateConfig {
  readonly armedPath: string;
  readonly campaignId: string;
  readonly path: string;
  readonly runId: string;
  readonly timeoutMilliseconds: number;
}

export interface ActorStagedGateConfig {
  readonly armedPath: string;
  readonly path: string;
}

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
  readonly releaseGate: ActorReleaseGateConfig | undefined;
  readonly playbackGate: ActorStagedGateConfig | undefined;
  readonly endGate: ActorStagedGateConfig | undefined;
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
    releaseGate: parsed.DISCORD_E2E_HOSTED_RELEASE_GATE_PATH === undefined ? undefined : {
      armedPath: parsed.DISCORD_E2E_HOSTED_RELEASE_GATE_ARMED_PATH!,
      campaignId: parsed.DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID!,
      path: parsed.DISCORD_E2E_HOSTED_RELEASE_GATE_PATH,
      runId: parsed.DISCORD_E2E_RUN_ID,
      timeoutMilliseconds: parsed.DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS!,
    },
    playbackGate: parsed.DISCORD_E2E_HOSTED_PLAYBACK_GATE_PATH === undefined ? undefined : {
      armedPath: parsed.DISCORD_E2E_HOSTED_PLAYBACK_GATE_ARMED_PATH!,
      path: parsed.DISCORD_E2E_HOSTED_PLAYBACK_GATE_PATH,
    },
    endGate: parsed.DISCORD_E2E_HOSTED_END_GATE_PATH === undefined ? undefined : {
      armedPath: parsed.DISCORD_E2E_HOSTED_END_GATE_ARMED_PATH!,
      path: parsed.DISCORD_E2E_HOSTED_END_GATE_PATH,
    },
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
