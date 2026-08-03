import { describe, expect, it } from "vitest";

import { loadCapacityConfig } from "../src/capacity-config.js";

const baseEnvironment = {
  DISCORD_E2E_CAPACITY_ACCOUNTS: "speaker-a,speaker-b,speaker-c,speaker-d,speaker-e,speaker-f",
  DISCORD_E2E_GUILD_ID: "11111111111111111",
  DISCORD_E2E_VOICE_CHANNEL_ID: "22222222222222222",
} as const;

describe("loadCapacityConfig", () => {
  it("builds a bounded six-actor capacity campaign", () => {
    const config = loadCapacityConfig(baseEnvironment);

    expect(config.actors).toHaveLength(6);
    expect(config.actors.map(({ account }) => account)).toEqual([
      "speaker-a",
      "speaker-b",
      "speaker-c",
      "speaker-d",
      "speaker-e",
      "speaker-f",
    ]);
    expect(config.actors[0]?.fixturePath).toContain("speaker-a");
    expect(config.actors[1]?.fixturePath).toContain("speaker-b");
  });

  it("accepts ten unique actors but rejects eleven, duplicates, and invalid accounts", () => {
    expect(loadCapacityConfig({
      ...baseEnvironment,
      DISCORD_E2E_CAPACITY_ACCOUNTS: Array.from(
        { length: 10 },
        (_, index) => `speaker-${index + 1}`,
      ).join(","),
    }).actors).toHaveLength(10);
    expect(() => loadCapacityConfig({
      ...baseEnvironment,
      DISCORD_E2E_CAPACITY_ACCOUNTS: Array.from(
        { length: 11 },
        (_, index) => `speaker-${index + 1}`,
      ).join(","),
    })).toThrow("between 2 and 10");
    expect(() => loadCapacityConfig({
      ...baseEnvironment,
      DISCORD_E2E_CAPACITY_ACCOUNTS: "speaker-a,speaker-a",
    })).toThrow("must be unique");
    expect(() => loadCapacityConfig({
      ...baseEnvironment,
      DISCORD_E2E_CAPACITY_ACCOUNTS: "speaker-a,../../secret",
    })).toThrow();
  });
});
