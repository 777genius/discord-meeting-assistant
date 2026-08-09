import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FileConversationFarewellCueRegistry } from "../src/adapters/outbound/file-conversation-farewell-cue-registry.js";

describe("FileConversationFarewellCueRegistry", () => {
  it("preloads the checksum-pinned RU and EN production voice cues", async () => {
    const root = fileURLToPath(new URL("../assets/farewell-cues", import.meta.url));
    const registry = await FileConversationFarewellCueRegistry.load(
      root,
      "elevenlabs-multilingual",
      "jqcCZkN6Knx8BJ5TBdYR",
    );

    const russian = registry.select({
      locale: "ru",
      meetingId: "meeting-1",
      voiceProfileId: "elevenlabs-multilingual",
    });
    const english = registry.select({
      locale: "en",
      meetingId: "meeting-1",
      voiceProfileId: "elevenlabs-multilingual",
    });

    expect(russian?.cueId).toBe("farewell-ru-v1");
    expect(english?.cueId).toBe("farewell-en-v1");
    expect(russian?.pcmChunks.length).toBeGreaterThan(0);
    expect(english?.pcmChunks.length).toBeGreaterThan(0);
    expect(
      registry.select({
        locale: "ru",
        meetingId: "meeting-1",
        voiceProfileId: "different-voice",
      }),
    ).toBeNull();
  });

  it("uses a meeting-stable playback attempt identity", async () => {
    const root = fileURLToPath(new URL("../assets/farewell-cues", import.meta.url));
    const registry = await FileConversationFarewellCueRegistry.load(
      root,
      "elevenlabs-multilingual",
      "jqcCZkN6Knx8BJ5TBdYR",
    );
    const input = {
      locale: "en" as const,
      meetingId: "meeting-1",
      voiceProfileId: "elevenlabs-multilingual",
    };

    expect(registry.select(input)?.playbackAttemptId).toBe(
      registry.select(input)?.playbackAttemptId,
    );
    expect(registry.select(input)?.playbackAttemptId).not.toBe(
      registry.select({ ...input, meetingId: "meeting-2" })?.playbackAttemptId,
    );
  });
});
