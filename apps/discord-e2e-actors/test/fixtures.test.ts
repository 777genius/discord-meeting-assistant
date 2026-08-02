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
        audioSha256: "d0facdd5b58acd2699987fd3a18669b2b3e0d1c93ce0f4a494bf8ac31f6b860c",
        durationMs: 16_001,
        fixtureId: "speaker-a",
        sourceSha256: "c10f73107bcfdac1eac201d737cae0a19c8a397c40e9c5e34f5f409c5e74eb8f",
      },
      {
        audioSha256: "7b695fae2699368b12211961ee01ce00f983b656627003e0ce009b4d1e5e69b4",
        durationMs: 12_367,
        fixtureId: "speaker-b",
        sourceSha256: "582d01de7c10d16a84d2cb608281b504ddc21a0b46ebf7450e3a260f94a033d8",
      },
    ]);
  });

  it("rejects a truncated fixture even if it starts with an Ogg header", async () => {
    const bytes = await readFile(fixturePaths[0] ?? "");
    await expect(inspectOggOpus(bytes.subarray(0, 100))).rejects.toThrow("truncated");
  });
});
