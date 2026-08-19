import { describe, expect, it } from "vitest";

import { CraigRecordingConfigurationAdapter } from
  "../src/adapters/inbound/craig/craig-recording-configuration-adapter.js";

describe("CraigRecordingConfigurationAdapter", () => {
  it("maps provider-neutral active rooms to the Craig configuration contract", async () => {
    const adapter = new CraigRecordingConfigurationAdapter({
      listActiveMeetingRooms: async () => [
        { roomId: "voice-2", sourceId: "guild-2" },
        { roomId: "voice-1", sourceId: "guild-1" },
      ],
    });

    await expect(adapter.listActiveGuildVoiceChannels()).resolves.toEqual([
      { guildId: "guild-2", voiceChannelId: "voice-2" },
      { guildId: "guild-1", voiceChannelId: "voice-1" },
    ]);
  });
});
