import { describe, expect, it } from "vitest";

import { GuildPublicationTargetResolver } from "../src/application/guild-publication-target-resolver.js";

const request = {
  guildId: "11111111111111111",
  voiceChannelId: "22222222222222222",
} as const;

describe("GuildPublicationTargetResolver", () => {
  it("prefers persisted configuration and isolates a legacy fallback by guild and voice", async () => {
    const configured = new GuildPublicationTargetResolver({
      execute: () => Promise.resolve({
        publicationTargetId: "33333333333333333",
        status: "configured" as const,
      }),
    }, {
      ...request,
      publicationTargetId: "44444444444444444",
    });
    await expect(configured.resolve(request)).resolves.toBe("33333333333333333");

    const missing = new GuildPublicationTargetResolver({
      execute: () => Promise.resolve({ status: "not-configured" as const }),
    }, {
      ...request,
      publicationTargetId: "44444444444444444",
    });
    await expect(missing.resolve(request)).resolves.toBe("44444444444444444");
    await expect(missing.resolve({ ...request, guildId: "55555555555555555" }))
      .resolves.toBeNull();
    await expect(missing.resolve({ ...request, voiceChannelId: "66666666666666666" }))
      .resolves.toBeNull();
  });
});
