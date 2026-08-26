import { describe, expect, it } from "vitest";

import {
  DiscordInfinityActorKeys,
  decodeDiscordInfinityActorKeyring,
} from "../src/index.js";

const snowflake = "123456789012345678";

describe("Discord Infinity actor-key custody", () => {
  it("derives stable purpose-scoped opaque active and rotation keys", () => {
    const authority = new DiscordInfinityActorKeys({
      activeKeyId: "r2",
      keys: { r1: "11".repeat(32), r2: "22".repeat(32) },
      schemaVersion: 1,
    });

    const active = authority.activeActorKey(snowflake);
    expect(active).toMatch(/^dactor1\.r2\.[A-Za-z0-9_-]{43}$/u);
    expect(authority.activeActorKey(snowflake)).toBe(active);
    expect(authority.actorKeysForFilter(snowflake)).toEqual([
      expect.stringMatching(/^dactor1\.r1\./u),
      active,
    ]);
    expect(JSON.stringify(authority.actorKeysForFilter(snowflake)))
      .not.toContain(snowflake);
    expect(authority.activeProfileId()).toBe("discord-infinity-actor-key.v1:r2");
  });

  it("fails closed for missing, malformed, or non-snowflake authority input", () => {
    expect(() => decodeDiscordInfinityActorKeyring(JSON.stringify({
      activeKeyId: "r2", keys: { r1: "11".repeat(32) }, schemaVersion: 1,
    }))).toThrow("active key");
    expect(() => decodeDiscordInfinityActorKeyring("{}"))
      .toThrow();
    const authority = new DiscordInfinityActorKeys({
      activeKeyId: "r1", keys: { r1: "11".repeat(32) }, schemaVersion: 1,
    });
    expect(() => authority.activeActorKey("Vlad"))
      .toThrow();
  });
});
