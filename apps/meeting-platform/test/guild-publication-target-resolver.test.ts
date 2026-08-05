import { describe, expect, it } from "vitest";

import { DiscordPublicationTargetResolver } from "../src/adapters/outbound/discord-publication-target-resolver.js";

const source = {
  roomId: "22222222222222222",
  scopeId: "11111111111111111",
} as const;

describe("DiscordPublicationTargetResolver", () => {
  it("prefers persisted configuration and isolates a legacy fallback by guild and voice", async () => {
    const configured = new DiscordPublicationTargetResolver({
      execute: () => Promise.resolve({
        publicationTargetId: "33333333333333333",
        status: "configured" as const,
      }),
    }, {
      guildId: source.scopeId,
      publicationTargetId: "44444444444444444",
      voiceChannelId: source.roomId,
    });
    await expect(configured.resolve(source)).resolves.toBe("33333333333333333");

    const missing = new DiscordPublicationTargetResolver({
      execute: () => Promise.resolve({ status: "not-configured" as const }),
    }, {
      guildId: source.scopeId,
      publicationTargetId: "44444444444444444",
      voiceChannelId: source.roomId,
    });
    await expect(missing.resolve(source)).resolves.toBe("44444444444444444");
    await expect(missing.resolve({ ...source, scopeId: "55555555555555555" }))
      .resolves.toBeNull();
    await expect(missing.resolve({ ...source, roomId: "66666666666666666" }))
      .resolves.toBeNull();
  });
});
