import { isAbsolute } from "node:path";

import { z } from "zod";

import type { ObserveLiveDiscordPlaybackLinkInput } from "./live-discord-playback-link-observer.js";
import { createObservedMeetingProjectionMarkers } from "./live-discord-projection-marker-contract.js";

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
  DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID: identifier,
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
});
const hostedEnvironment = z.object({
  ...commonEnvironment,
  DISCORD_E2E_PLAYBACK_LINK_MEETING_ID: identifier,
  DISCORD_E2E_PLAYBACK_LINK_MODE: z.literal("hosted"),
});

export interface LiveDiscordPlaybackLinkObserverConfig extends ObserveLiveDiscordPlaybackLinkInput {
  readonly keychainService: string;
  readonly outputPath: string;
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
      meetingId: parsed.DISCORD_E2E_PLAYBACK_LINK_MEETING_ID,
      projectionMarkers: createObservedMeetingProjectionMarkers(
        parsed.DISCORD_E2E_PLAYBACK_LINK_MEETING_ID,
        parsed.DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID,
      ),
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
    meetingId: parsed.DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID,
    projectionMarkers: [parsed.DISCORD_E2E_PLAYBACK_LINK_PROJECTION_MARKER],
  });
}

function freezeConfig(
  parsed: z.infer<typeof explicitEnvironment> | z.infer<typeof hostedEnvironment>,
  identity: Pick<ObserveLiveDiscordPlaybackLinkInput, "container" | "meetingId" | "projectionMarkers">,
): LiveDiscordPlaybackLinkObserverConfig {
  return Object.freeze({
    ...identity,
    durationMilliseconds: parsed.DISCORD_E2E_PLAYBACK_LINK_DURATION_MS,
    keychainService: parsed.DISCORD_E2E_PLAYBACK_LINK_KEYCHAIN_SERVICE,
    outputPath: parsed.DISCORD_E2E_PLAYBACK_LINK_OUTPUT,
    pollIntervalMs: parsed.DISCORD_E2E_PLAYBACK_LINK_POLL_INTERVAL_MS,
    recordingId: parsed.DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID,
    resultChannelId: parsed.DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID,
    runId: parsed.DISCORD_E2E_PLAYBACK_LINK_RUN_ID,
    secretDirectory: parsed.DISCORD_E2E_PLAYBACK_LINK_SECRET_DIRECTORY,
    sutAccount: parsed.DISCORD_E2E_PLAYBACK_LINK_SUT_ACCOUNT,
    sutApplicationId: parsed.DISCORD_E2E_PLAYBACK_LINK_SUT_APPLICATION_ID,
  });
}
