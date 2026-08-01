import { describe, expect, it } from "vitest";

import { loadActorConfig } from "../src/config.js";

describe("loadActorConfig", () => {
  it("uses only channel metadata, fixture paths, and Keychain coordinates", () => {
    const config = loadActorConfig({
      DISCORD_E2E_GUILD_ID: "11111111111111111",
      DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
    });

    expect(config.keychainService).toBe("discord-voice-bot-e2e");
    expect(config.speakers).toEqual([
      { name: "speaker-a", account: "speaker-a", fixturePath: "test/fixtures/speaker-a.ogg" },
      { name: "speaker-b", account: "speaker-b", fixturePath: "test/fixtures/speaker-b.ogg" },
    ]);
    expect(config.speakerBDelayMilliseconds).toBe(750);
  });

  it("rejects non-Discord channel identifiers before any connection", () => {
    expect(() =>
      loadActorConfig({
        DISCORD_E2E_GUILD_ID: "not-a-snowflake",
        DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
        DISCORD_E2E_SPEAKER_A_FIXTURE: "/fixtures/a.ogg",
        DISCORD_E2E_SPEAKER_B_FIXTURE: "/fixtures/b.ogg",
      }),
    ).toThrow();
  });
});
