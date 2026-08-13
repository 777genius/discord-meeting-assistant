import { describe, expect, it } from "vitest";

import { loadActorConfig } from "../src/config.js";

describe("loadActorConfig", () => {
  const requiredCorrelation = {
    DISCORD_E2E_RUN_ID: "run-test-1",
  } as const;

  it("uses only channel metadata, fixture paths, and Keychain coordinates", () => {
    const config = loadActorConfig({
      DISCORD_E2E_GUILD_ID: "11111111111111111",
      DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
      ...requiredCorrelation,
    });

    expect(config.keychainService).toBe("discord-voice-bot-e2e");
    expect(config.secretDirectory).toBeUndefined();
    expect(config.scenario).toBe("overlap");
    expect(config.speakers).toEqual([
      { name: "speaker-a", account: "speaker-a", fixturePath: "test/fixtures/speaker-a.ru-en.ogg" },
      { name: "speaker-b", account: "speaker-b", fixturePath: "test/fixtures/speaker-b.ru-en.ogg" },
    ]);
    expect(config.speakerBDelayMilliseconds).toBe(750);
    expect(config.speakerBConnectDelayMilliseconds).toBe(0);
    expect(config.prePlaybackHoldMilliseconds).toBe(0);
    expect(config.postPlaybackHoldMilliseconds).toBe(0);
    expect(config.releaseGate).toBeUndefined();
  });

  it("bounds the opt-in Speaker B first-connect delay", () => {
    const environment = {
      DISCORD_E2E_GUILD_ID: "11111111111111111",
      DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
      ...requiredCorrelation,
    };
    expect(loadActorConfig({
      ...environment,
      DISCORD_E2E_SPEAKER_B_CONNECT_DELAY_MS: "120000",
    }).speakerBConnectDelayMilliseconds).toBe(120_000);
    expect(() => loadActorConfig({
      ...environment,
      DISCORD_E2E_SPEAKER_B_CONNECT_DELAY_MS: "120001",
    })).toThrow();
  });

  it.each([
    ["DISCORD_E2E_PRE_PLAYBACK_HOLD_MS", "prePlaybackHoldMilliseconds"],
    ["DISCORD_E2E_POST_PLAYBACK_HOLD_MS", "postPlaybackHoldMilliseconds"],
  ] as const)("allows an opt-in %s only within the safe E2E limit", (key, property) => {
    const baseEnvironment = {
      DISCORD_E2E_GUILD_ID: "11111111111111111",
      DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
      ...requiredCorrelation,
    };

    const maximum = loadActorConfig({
      ...baseEnvironment,
      [key]: "600000",
    });
    expect(maximum[property]).toBe(600_000);
    expect(() => loadActorConfig({
      ...baseEnvironment,
      [key]: "-1",
    })).toThrow();
    expect(() => loadActorConfig({
      ...baseEnvironment,
      [key]: "600001",
    })).toThrow();
    expect(() => loadActorConfig({
      ...baseEnvironment,
      [key]: "1.5",
    })).toThrow();
  });

  it("accepts only an absolute file-secret directory for isolated host actors", () => {
    const baseEnvironment = {
      DISCORD_E2E_GUILD_ID: "11111111111111111",
      DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
      ...requiredCorrelation,
    };

    expect(loadActorConfig({
      ...baseEnvironment,
      DISCORD_E2E_SECRET_DIRECTORY: "/run/secrets/discord-e2e",
    }).secretDirectory).toBe("/run/secrets/discord-e2e");
    expect(() => loadActorConfig({
      ...baseEnvironment,
      DISCORD_E2E_SECRET_DIRECTORY: "relative/secrets",
    })).toThrow();
  });

  it("selects sequential and reconnect scenarios without accepting arbitrary commands", () => {
    const baseEnvironment = {
      DISCORD_E2E_GUILD_ID: "11111111111111111",
      DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
      ...requiredCorrelation,
    };

    expect(loadActorConfig({ ...baseEnvironment, DISCORD_E2E_SCENARIO: "sequential" }).scenario)
      .toBe("sequential");
    expect(loadActorConfig({ ...baseEnvironment, DISCORD_E2E_SCENARIO: "reconnect" }).scenario)
      .toBe("reconnect");
    expect(() => loadActorConfig({ ...baseEnvironment, DISCORD_E2E_SCENARIO: "custom" }))
      .toThrow();
  });

  it("rejects non-Discord channel identifiers before any connection", () => {
    expect(() =>
      loadActorConfig({
        DISCORD_E2E_GUILD_ID: "not-a-snowflake",
        DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
        DISCORD_E2E_SPEAKER_A_FIXTURE: "/fixtures/a.ogg",
        DISCORD_E2E_SPEAKER_B_FIXTURE: "/fixtures/b.ogg",
        ...requiredCorrelation,
      }),
    ).toThrow();
  });

  it("requires an explicit run ID without requiring Craig's future recording ID", () => {
    expect(() => loadActorConfig({
      DISCORD_E2E_GUILD_ID: "11111111111111111",
      DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
    })).toThrow();
  });

  it("requires the hosted release gate configuration as one pinned bounded group", () => {
    const environment = {
      DISCORD_E2E_GUILD_ID: "11111111111111111",
      DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
      ...requiredCorrelation,
    };
    expect(loadActorConfig({
      ...environment,
      DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: "/private/run-1/release.json",
      DISCORD_E2E_HOSTED_RELEASE_GATE_ARMED_PATH: "/private/run-1/release-armed.json",
      DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: "campaign-1",
      DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS: "45000",
    }).releaseGate).toEqual({
      armedPath: "/private/run-1/release-armed.json",
      campaignId: "campaign-1",
      path: "/private/run-1/release.json",
      runId: "run-test-1",
      timeoutMilliseconds: 45_000,
    });

    expect(() => loadActorConfig({
      ...environment,
      DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: "/private/run-1/release.json",
    })).toThrow(/configured together/u);
    expect(() => loadActorConfig({
      ...environment,
      DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: "relative/release.json",
      DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: "campaign-1",
      DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS: "45000",
    })).toThrow();
    expect(() => loadActorConfig({
      ...environment,
      DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: "/private/run-1/release.json",
      DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: "campaign-1",
      DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS: "600001",
    })).toThrow();
  });
});
