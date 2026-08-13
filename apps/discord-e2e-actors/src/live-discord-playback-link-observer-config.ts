import { isAbsolute } from "node:path";

import { z } from "zod";

import type { ObserveLiveDiscordPlaybackLinkInput } from "./live-discord-playback-link-observer.js";

const snowflake = z.string().regex(/^\d{17,20}$/u, "Expected a Discord snowflake");
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const absolutePath = z.string().min(1).refine(
  (value) => isAbsolute(value) && value !== "/",
  "Expected an absolute non-root path",
);
const container = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel-message"), parentChannelId: snowflake }).strict(),
  z.object({ id: snowflake, kind: z.literal("thread"), name: z.string().trim().min(1), parentId: snowflake }).strict(),
]);
const commonEnvironment = {
  DISCORD_E2E_PLAYBACK_LINK_DURATION_MS: z.coerce.number().int().min(1_000).max(600_000),
  DISCORD_E2E_PLAYBACK_LINK_KEYCHAIN_SERVICE: z.string().trim().min(1).default("discord-voice-bot-e2e"),
  DISCORD_E2E_PLAYBACK_LINK_OUTPUT: absolutePath,
  DISCORD_E2E_PLAYBACK_LINK_POLL_INTERVAL_MS: z.coerce.number().int().min(2_000).max(5_000),
  DISCORD_E2E_PLAYBACK_LINK_RECORDING_PLAYBACK_ORIGIN: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  }, "Expected an exact HTTPS playback origin"),
  DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID: snowflake,
  DISCORD_E2E_PLAYBACK_LINK_RUN_ID: identifier,
  DISCORD_E2E_PLAYBACK_LINK_SECRET_DIRECTORY: absolutePath.optional(),
  DISCORD_E2E_PLAYBACK_LINK_SUT_ACCOUNT: z.string().trim().min(1).max(64).default("sut"),
  DISCORD_E2E_PLAYBACK_LINK_SUT_APPLICATION_ID: snowflake,
};
const explicitEnvironment = z.object({
  ...commonEnvironment,
  DISCORD_E2E_PLAYBACK_LINK_MODE: z.literal("explicit").optional(),
  DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON: z.string().transform((value, context) => {
    try {
      return container.parse(JSON.parse(value) as unknown);
    } catch (error) {
      context.addIssue({ code: "custom", message: "Expected a valid projection container JSON", params: { error } });
      return z.NEVER;
    }
  }),
  DISCORD_E2E_PLAYBACK_LINK_PROJECTION_MARKER: z.string().trim().min(1),
  DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID: identifier,
});
const hostedEnvironment = z.object({
  ...commonEnvironment,
  DISCORD_E2E_PLAYBACK_LINK_MODE: z.literal("hosted"),
  DISCORD_E2E_PLAYBACK_LINK_READY_RECEIPT_INPUT: absolutePath,
});

export interface LiveDiscordPlaybackLinkObserverConfig extends ObserveLiveDiscordPlaybackLinkInput {
  readonly keychainService: string;
  readonly outputPath: string;
  readonly recordingPlaybackOrigin: string;
  readonly recordingIdentity:
    | { readonly kind: "recording-ready-receipt"; readonly path: string }
    | { readonly kind: "static"; readonly meetingId: string; readonly recordingId: string };
  readonly secretDirectory: string | undefined;
  readonly sutAccount: string;
}

export function loadLiveDiscordPlaybackLinkObserverConfig(
  input: NodeJS.ProcessEnv,
): LiveDiscordPlaybackLinkObserverConfig {
  const parsed = (input.DISCORD_E2E_PLAYBACK_LINK_MODE === "hosted"
    ? hostedEnvironment : explicitEnvironment).parse(input);
  if (parsed.DISCORD_E2E_PLAYBACK_LINK_MODE === "hosted") {
    return freezeConfig(parsed, {
      container: { kind: "channel-message", parentChannelId: parsed.DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID },
      projectionMarkers: [],
      recordingIdentity: {
        kind: "recording-ready-receipt", path: parsed.DISCORD_E2E_PLAYBACK_LINK_READY_RECEIPT_INPUT,
      },
    });
  }
  if (
    parsed.DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON.kind === "channel-message" &&
    parsed.DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON.parentChannelId !==
      parsed.DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID
  ) {
    throw new Error("Playback-link channel container must match the result channel");
  }
  if (
    parsed.DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON.kind === "thread" &&
    parsed.DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON.parentId !==
      parsed.DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID
  ) {
    throw new Error("Playback-link thread parent must match the result channel");
  }
  return freezeConfig(parsed, {
    container: parsed.DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON,
    projectionMarkers: [parsed.DISCORD_E2E_PLAYBACK_LINK_PROJECTION_MARKER],
    recordingIdentity: {
      kind: "static", meetingId: parsed.DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID,
      recordingId: parsed.DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID,
    },
  });
}

function freezeConfig(
  parsed: z.infer<typeof explicitEnvironment> | z.infer<typeof hostedEnvironment>,
  identity: Pick<LiveDiscordPlaybackLinkObserverConfig, "container" | "projectionMarkers" | "recordingIdentity">,
): LiveDiscordPlaybackLinkObserverConfig {
  return Object.freeze({
    ...identity,
    durationMilliseconds: parsed.DISCORD_E2E_PLAYBACK_LINK_DURATION_MS,
    keychainService: parsed.DISCORD_E2E_PLAYBACK_LINK_KEYCHAIN_SERVICE,
    outputPath: parsed.DISCORD_E2E_PLAYBACK_LINK_OUTPUT,
    pollIntervalMs: parsed.DISCORD_E2E_PLAYBACK_LINK_POLL_INTERVAL_MS,
    recordingPlaybackOrigin: parsed.DISCORD_E2E_PLAYBACK_LINK_RECORDING_PLAYBACK_ORIGIN,
    resultChannelId: parsed.DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID,
    runId: parsed.DISCORD_E2E_PLAYBACK_LINK_RUN_ID,
    secretDirectory: parsed.DISCORD_E2E_PLAYBACK_LINK_SECRET_DIRECTORY,
    sutAccount: parsed.DISCORD_E2E_PLAYBACK_LINK_SUT_ACCOUNT,
    sutApplicationId: parsed.DISCORD_E2E_PLAYBACK_LINK_SUT_APPLICATION_ID,
  });
}
