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
        audioSha256: "013ab837a19d5063a649d82f6040aa10c8fd79fdb1ef6d57fa57188619b2a370",
        durationMs: 12_728,
        fixtureId: "speaker-a",
        sourceSha256: "d75ef22920bbd6750b7f698b52bd6bd114ecc8112778b275799eaf7db4ada3ff",
      },
      {
        audioSha256: "cb516f1dadaa91a0f90379f11e14cbe8917280613426be306faf2506054a483e",
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
