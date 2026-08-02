import { describe, expect, it } from "vitest";

import { loadLiveDiscordObserverConfig } from "../src/live-discord-observer-config.js";

const requiredEnvironment = {
  DISCORD_E2E_LIVE_DURATION_MS: "300000",
  DISCORD_E2E_LIVE_OUTPUT: "/tmp/discord-live-observation.json",
  DISCORD_E2E_LIVE_POLL_INTERVAL_MS: "2000",
  DISCORD_E2E_LIVE_RESULT_CHANNEL_ID: "11111111111111111",
  DISCORD_E2E_LIVE_RUN_ID: "live-run-2026-08-02",
  DISCORD_E2E_LIVE_SUT_APPLICATION_ID: "22222222222222222",
} as const;

describe("loadLiveDiscordObserverConfig", () => {
  it("uses explicit observation coordinates with safe secret-reader defaults", () => {
    const config = loadLiveDiscordObserverConfig(requiredEnvironment);

    expect(config).toEqual({
      durationMilliseconds: 300_000,
      keychainService: "discord-voice-bot-e2e",
      outputPath: "/tmp/discord-live-observation.json",
      pollIntervalMilliseconds: 2_000,
      resultChannelId: "11111111111111111",
      runId: "live-run-2026-08-02",
      secretDirectory: undefined,
      sutAccount: "sut",
      sutApplicationId: "22222222222222222",
    });
  });

  it("accepts only bounded durations and Discord-safe polling intervals", () => {
    expect(loadLiveDiscordObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_LIVE_DURATION_MS: "1000",
      DISCORD_E2E_LIVE_POLL_INTERVAL_MS: "5000",
    }).durationMilliseconds).toBe(1_000);
    expect(() => loadLiveDiscordObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_LIVE_DURATION_MS: "999",
    })).toThrow();
    expect(() => loadLiveDiscordObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_LIVE_DURATION_MS: "600001",
    })).toThrow();
    expect(() => loadLiveDiscordObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_LIVE_POLL_INTERVAL_MS: "1999",
    })).toThrow();
    expect(() => loadLiveDiscordObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_LIVE_POLL_INTERVAL_MS: "5001",
    })).toThrow();
  });

  it("requires an absolute, non-root trace output and validates optional file-secret coordinates", () => {
    expect(loadLiveDiscordObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_LIVE_SECRET_DIRECTORY: "/run/secrets/discord-e2e",
      DISCORD_E2E_LIVE_SUT_ACCOUNT: "sut-live",
    })).toMatchObject({
      secretDirectory: "/run/secrets/discord-e2e",
      sutAccount: "sut-live",
    });
    expect(() => loadLiveDiscordObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_LIVE_OUTPUT: "relative.json",
    })).toThrow();
    expect(() => loadLiveDiscordObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_LIVE_OUTPUT: "/",
    })).toThrow();
    expect(() => loadLiveDiscordObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_LIVE_SECRET_DIRECTORY: "relative/secrets",
    })).toThrow();
  });
});
