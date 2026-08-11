import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FileParticipantGreetingCueRegistry } from "../src/adapters/outbound/file-participant-greeting-cue-registry.js";

describe("FileParticipantGreetingCueRegistry", () => {
  it("preloads checksum-pinned named and anonymous production greetings", async () => {
    const root = fileURLToPath(new URL("../assets/greeting-cues", import.meta.url));
    const registry = await FileParticipantGreetingCueRegistry.load(
      root,
      "elevenlabs-multilingual",
      "jqcCZkN6Knx8BJ5TBdYR",
    );

    for (const input of [
      { locale: "ru" as const, speech: "Привет, Виталий!" },
      { locale: "ru" as const, speech: "Привет!" },
      { locale: "en" as const, speech: "Hi!" },
    ]) {
      const selected = registry.select({
        ...input,
        meetingId: "meeting-1",
        participantId: "participant-1",
        voiceProfileId: "elevenlabs-multilingual",
      });
      expect(selected?.pcmChunks.length).toBeGreaterThan(0);
      expect(selected?.playbackAttemptId).toMatch(
        /^participant-greeting-cue-v1-[0-9a-f]{64}$/u,
      );
    }
  });

  it("falls back safely for an unprepared phrase or mismatched voice", async () => {
    const root = fileURLToPath(new URL("../assets/greeting-cues", import.meta.url));
    const registry = await FileParticipantGreetingCueRegistry.load(
      root,
      "elevenlabs-multilingual",
      "jqcCZkN6Knx8BJ5TBdYR",
    );
    const input = {
      locale: "ru" as const,
      meetingId: "meeting-1",
      participantId: "participant-1",
      speech: "Привет, Новое Имя!",
      voiceProfileId: "elevenlabs-multilingual",
    };

    expect(registry.select(input)).toBeNull();
    expect(registry.select({
      ...input,
      speech: "Привет!",
      voiceProfileId: "another-voice",
    })).toBeNull();
  });

  it("uses a stable participant-scoped playback identity", async () => {
    const root = fileURLToPath(new URL("../assets/greeting-cues", import.meta.url));
    const registry = await FileParticipantGreetingCueRegistry.load(
      root,
      "elevenlabs-multilingual",
      "jqcCZkN6Knx8BJ5TBdYR",
    );
    const input = {
      locale: "en" as const,
      meetingId: "meeting-1",
      participantId: "participant-1",
      speech: "Hi!",
      voiceProfileId: "elevenlabs-multilingual",
    };

    expect(registry.select(input)?.playbackAttemptId).toBe(
      registry.select(input)?.playbackAttemptId,
    );
    expect(registry.select(input)?.playbackAttemptId).not.toBe(
      registry.select({ ...input, participantId: "participant-2" })?.playbackAttemptId,
    );
  });
});
