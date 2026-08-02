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
        audioSha256: "60217e24e7145f5ee86db1eae104eac577f786a32666e75360165b6e75b43c7f",
        durationMs: 13_761,
        fixtureId: "speaker-a",
        sourceSha256: "7d3dc05c096e5b8d15435f8b5862d0c0fce99fe444125ba79e47dcb5550c1e1d",
      },
      {
        audioSha256: "391806e4a2c03498af2484f6b43454809ae75663b7fe5f50df3c88222acaf031",
        durationMs: 10_747,
        fixtureId: "speaker-b",
        sourceSha256: "5212ba5ecd2d3ebd5f928a9eaf6bb41e3be147202b73c09160c6bf5ed55f2439",
      },
    ]);
  });

  it("rejects a truncated fixture even if it starts with an Ogg header", async () => {
    const bytes = await readFile(fixturePaths[0] ?? "");
    await expect(inspectOggOpus(bytes.subarray(0, 100))).rejects.toThrow("truncated");
  });
});
