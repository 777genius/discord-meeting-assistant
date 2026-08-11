import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { FileParticipantGreetingCueRegistry } from "../src/adapters/outbound/file-participant-greeting-cue-registry.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

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

  it("rejects duplicate cue IDs even when speech is distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "greeting-cue-registry-"));
    temporaryRoots.push(root);
    const bytes = Buffer.from([1, 2]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await Promise.all([
      writeFile(join(root, "first.pcm"), bytes),
      writeFile(join(root, "second.pcm"), bytes),
      writeFile(join(root, "manifest.json"), JSON.stringify({
        audio: { channels: 1, format: "pcm_s16le", sampleRateHz: 48_000 },
        cues: [
          {
            cueId: "duplicate-cue-v1",
            locale: "ru",
            pcmFile: "first.pcm",
            sha256: digest,
            text: "Привет!",
          },
          {
            cueId: "duplicate-cue-v1",
            locale: "en",
            pcmFile: "second.pcm",
            sha256: digest,
            text: "Hi!",
          },
        ],
        version: 1,
        voiceId: "test-voice",
        voiceProfileId: "test-profile",
      })),
    ]);

    await expect(FileParticipantGreetingCueRegistry.load(
      root,
      "test-profile",
      "test-voice",
    )).rejects.toThrow("duplicate cue IDs");
  });
});
