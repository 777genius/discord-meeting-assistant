import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { inspectOggOpus } from "./fixture-integrity.js";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, "Expected a Discord snowflake");
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u, "Expected a lowercase SHA-256");
const secretAccountSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);

const environmentSchema = z.object({
  DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT: z.string().refine(
    (value) => isAbsolute(value) && value !== "/",
    "Expected an absolute evidence output path",
  ),
  DISCORD_E2E_SUPPLEMENTAL_KEYCHAIN_ACCOUNT: secretAccountSchema.default("speaker-d"),
  DISCORD_E2E_SUPPLEMENTAL_KEYCHAIN_SERVICE: z.string().trim().min(1)
    .default("discord-voice-bot-e2e"),
  DISCORD_E2E_SUPPLEMENTAL_MANIFEST: z.string().refine(
    (value) => isAbsolute(value) && value !== "/",
    "Expected an absolute supplemental manifest path",
  ),
  DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_TIMEOUT_MS: z.coerce.number().int()
    .min(1_000).max(120_000).default(60_000),
  DISCORD_E2E_SUPPLEMENTAL_POST_HOLD_MS: z.coerce.number().int()
    .min(0).max(60_000).default(5_000),
  DISCORD_E2E_SUPPLEMENTAL_PRE_HOLD_MS: z.coerce.number().int()
    .min(0).max(60_000).default(0),
  DISCORD_E2E_SUPPLEMENTAL_PRIVATE_TEST_GUILD: z.literal("private-test-guild"),
  DISCORD_E2E_SUPPLEMENTAL_READY_TIMEOUT_MS: z.coerce.number().int()
    .min(1_000).max(120_000).default(30_000),
  DISCORD_E2E_SUPPLEMENTAL_RUN_ID: runIdSchema,
  DISCORD_E2E_SUPPLEMENTAL_SECRET_DIRECTORY: z.string().refine(isAbsolute).optional(),
});

const supplementalManifestSchema = z.object({
  applicationId: snowflakeSchema,
  fixture: z.object({
    durationMs: z.number().int().positive().max(60_000),
    path: z.string().trim().min(1),
    purpose: z.literal("speaker-d-botik-question-and-later-group-farewell"),
    sha256: sha256Schema,
  }).strict(),
  guildId: snowflakeSchema,
  privateTestGuildAcknowledgement: z.literal("private-test-guild"),
  schemaVersion: z.literal(1),
  voiceChannelId: snowflakeSchema,
}).strict();

export interface SupplementalVoicePlaybackConfig {
  readonly evidenceOutputPath: string;
  readonly keychainAccount: string;
  readonly keychainService: string;
  readonly manifestPath: string;
  readonly playbackTimeoutMilliseconds: number;
  readonly postHoldMilliseconds: number;
  readonly preHoldMilliseconds: number;
  readonly privateTestGuildConfirmed: true;
  readonly readyTimeoutMilliseconds: number;
  readonly runId: string;
  readonly secretDirectory: string | undefined;
}

export interface VerifiedSupplementalVoiceManifest {
  readonly applicationId: string;
  readonly fixture: {
    readonly durationMs: number;
    readonly path: string;
    readonly purpose: "speaker-d-botik-question-and-later-group-farewell";
    readonly sha256: string;
  };
  readonly guildId: string;
  readonly privateTestGuildAcknowledgement: "private-test-guild";
  readonly schemaVersion: 1;
  readonly voiceChannelId: string;
}

export function loadSupplementalVoicePlaybackConfig(
  environment: NodeJS.ProcessEnv,
): SupplementalVoicePlaybackConfig {
  if (Object.keys(environment).some((key) =>
    key.startsWith("DISCORD_E2E_SUPPLEMENTAL_") && key.includes("TOKEN")
  )) {
    throw new Error("Supplemental voice playback does not accept bot tokens through environment variables");
  }
  const parsed = environmentSchema.parse(environment);
  return Object.freeze({
    evidenceOutputPath: parsed.DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT,
    keychainAccount: parsed.DISCORD_E2E_SUPPLEMENTAL_KEYCHAIN_ACCOUNT,
    keychainService: parsed.DISCORD_E2E_SUPPLEMENTAL_KEYCHAIN_SERVICE,
    manifestPath: parsed.DISCORD_E2E_SUPPLEMENTAL_MANIFEST,
    playbackTimeoutMilliseconds: parsed.DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_TIMEOUT_MS,
    postHoldMilliseconds: parsed.DISCORD_E2E_SUPPLEMENTAL_POST_HOLD_MS,
    preHoldMilliseconds: parsed.DISCORD_E2E_SUPPLEMENTAL_PRE_HOLD_MS,
    privateTestGuildConfirmed: true,
    readyTimeoutMilliseconds: parsed.DISCORD_E2E_SUPPLEMENTAL_READY_TIMEOUT_MS,
    runId: parsed.DISCORD_E2E_SUPPLEMENTAL_RUN_ID,
    secretDirectory: parsed.DISCORD_E2E_SUPPLEMENTAL_SECRET_DIRECTORY,
  });
}

export async function loadVerifiedSupplementalVoiceManifest(
  manifestPath: string,
  playbackTimeoutMilliseconds: number,
): Promise<VerifiedSupplementalVoiceManifest> {
  const parsed = supplementalManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const fixturePath = isAbsolute(parsed.fixture.path)
    ? resolve(parsed.fixture.path)
    : resolve(dirname(manifestPath), parsed.fixture.path);
  const inspected = await inspectOggOpus(await readFile(fixturePath));
  if (inspected.sha256 !== parsed.fixture.sha256) {
    throw new Error("Supplemental Speaker D fixture SHA-256 does not match its pinned manifest");
  }
  if (inspected.durationMs !== parsed.fixture.durationMs) {
    throw new Error("Supplemental Speaker D fixture duration does not match its pinned manifest");
  }
  if (playbackTimeoutMilliseconds < inspected.durationMs) {
    throw new Error("Supplemental playback timeout cannot cover the pinned fixture duration");
  }
  return Object.freeze({
    ...parsed,
    fixture: Object.freeze({ ...parsed.fixture, path: fixturePath }),
  });
}
