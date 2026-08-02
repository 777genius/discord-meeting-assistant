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
    expect(config.scenario).toBe("overlap");
    expect(config.speakers).toEqual([
      { name: "speaker-a", account: "speaker-a", fixturePath: "test/fixtures/speaker-a.ru-en.ogg" },
      { name: "speaker-b", account: "speaker-b", fixturePath: "test/fixtures/speaker-b.ru-en.ogg" },
    ]);
    expect(config.speakerBDelayMilliseconds).toBe(750);
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
});
