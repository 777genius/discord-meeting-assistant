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
        audioSha256: "ba61f71aa15343b5187bff075003901f9abb07409e07fbc8e020d63e1e525844",
        durationMs: 16_150,
        fixtureId: "speaker-a",
        sourceSha256: "4cf35555ae6c77881dcddc093919dd7b70dfbc5fca56a3b147c29902a0260b03",
      },
      {
        audioSha256: "f1b173b7b8f82c8a7387481d161c704e91bb000ba9ba94185adfe360e86e5647",
        durationMs: 16_822,
        fixtureId: "speaker-b",
        sourceSha256: "595f2e8016d8ef2d2733f586501e8e9d5dc488b88cc3a4613c1d42e680104d10",
      },
    ]);
  });

  it("rejects a truncated fixture even if it starts with an Ogg header", async () => {
    const bytes = await readFile(fixturePaths[0] ?? "");
    await expect(inspectOggOpus(bytes.subarray(0, 100))).rejects.toThrow("truncated");
  });
});
