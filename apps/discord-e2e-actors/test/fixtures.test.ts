import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { fixtureManifestV1Schema } from "../src/e2e-evidence.js";
import { inspectOggOpus, loadVerifiedFixtureSet } from "../src/fixture-integrity.js";

const fixturePaths = [
  "test/fixtures/speaker-a.ru-en.ogg",
  "test/fixtures/speaker-b.ru-en.ogg",
];

describe("synthetic actor fixtures", () => {
  it.each(fixturePaths)("ships a valid Ogg Opus stream at %s", async (fixturePath) => {
    const bytes = await readFile(fixturePath);

    expect(bytes.subarray(0, 4).toString("ascii")).toBe("OggS");
    expect(bytes.includes(Buffer.from("OpusHead", "ascii"))).toBe(true);
    expect(bytes.length).toBeGreaterThan(1_000);
  });

  it("pins the Russian/English ground truth source hashes", async () => {
    const manifest = fixtureManifestV1Schema.parse(
      JSON.parse(await readFile("test/fixtures/manifest.v1.json", "utf8")),
    );

    expect(manifest.locale).toBe("ru-RU");
    expect(manifest.scenarios.map(({ kind }) => kind)).toEqual([
      "sequential",
      "overlap",
      "reconnect",
    ]);
    expect(
      manifest.scenarios.find(({ kind }) => kind === "reconnect")?.playbackCountByFixture,
    ).toEqual({ "speaker-a": 1, "speaker-b": 1 });
    for (const fixture of manifest.fixtures) {
      const source = await readFile(fixture.sourcePath);
      expect(createHash("sha256").update(source).digest("hex")).toBe(fixture.sourceSha256);
      expect(source.toString("utf8").trim()).toBe(fixture.sourceText);
      expect(fixture.requiredTerms.some((term) => /[a-z]/iu.test(term))).toBe(true);
    }
  });

  it("pins the exact generated Ogg hashes and durations before playback", async () => {
    const verified = await loadVerifiedFixtureSet("test/fixtures/manifest.v1.json", [
      { actorName: "speaker-a", fixturePath: fixturePaths[0] ?? "" },
      { actorName: "speaker-b", fixturePath: fixturePaths[1] ?? "" },
    ]);

    expect(verified.fixtures).toEqual([
      {
        audioSha256: "8e29a933ef95eaf1f149b150ff123f90a3276847fcd4941ccb6c55b24561b9d8",
        durationMs: 26_235,
        fixtureId: "speaker-a",
        sourceSha256: "5aa51fdfca1325cf5b78a35927f1a256989dffc5adcf50cd6d8e5c02b0493a44",
      },
      {
        audioSha256: "f169479293fcf2911c8b3bffc32a187fdae0899b67267fde3171e2d2b8de3d2e",
        durationMs: 34_996,
        fixtureId: "speaker-b",
        sourceSha256: "ce6d53650f73aac8872289ede15a67b6a74535d4620c572bd17a46fd1322df00",
      },
    ]);
  });

  it("pins the long heartbeat fixtures used at the five-minute live boundary", async () => {
    const liveFixturePaths = [
      "test/fixtures/speaker-a.live.ru-en.ogg",
      "test/fixtures/speaker-b.live.ru-en.ogg",
    ] as const;
    const verified = await loadVerifiedFixtureSet("test/fixtures/manifest.live.v1.json", [
      { actorName: "speaker-a", fixturePath: liveFixturePaths[0] },
      { actorName: "speaker-b", fixturePath: liveFixturePaths[1] },
    ]);

    expect(verified.fixtures).toEqual([
      {
        audioSha256: "1f5314c3ea9d8767cc4c304142eeb92a77c76cc8f36c212b1d10670daf73a162",
        durationMs: 296_235,
        fixtureId: "speaker-a",
        sourceSha256: "5aa51fdfca1325cf5b78a35927f1a256989dffc5adcf50cd6d8e5c02b0493a44",
      },
      {
        audioSha256: "cb6fc152aaed139947c40064a615cb0b5708f096fc8e1166191804784ea7b0b5",
        durationMs: 304_996,
        fixtureId: "speaker-b",
        sourceSha256: "ce6d53650f73aac8872289ede15a67b6a74535d4620c572bd17a46fd1322df00",
      },
    ]);
    expect(verified.manifest.fixtures.map(({ fixtureId, speechStartOffsetMs }) => ({
      fixtureId,
      speechStartOffsetMs,
    }))).toEqual([
      { fixtureId: "speaker-a", speechStartOffsetMs: 270_004 },
      { fixtureId: "speaker-b", speechStartOffsetMs: 270_004 },
    ]);
  });

  it("rejects a truncated fixture even if it starts with an Ogg header", async () => {
    const bytes = await readFile(fixturePaths[0] ?? "");
    await expect(inspectOggOpus(bytes.subarray(0, 100))).rejects.toThrow("truncated");
  });
});
