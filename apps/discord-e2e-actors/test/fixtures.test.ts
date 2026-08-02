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
        audioSha256: "442fc44fce75dad4c904d99fe63b45d69064a748333025a89c2fd51efd33ccb2",
        durationMs: 22_403,
        fixtureId: "speaker-a",
        sourceSha256: "8dc4edc94c379d44bb782df13840f2f015c0d2b47be9a261e560bc034e981cd7",
      },
      {
        audioSha256: "e69ed2e04090680a7525898ed94b0643e0637edbf13c2f2737c4b9cdfe13a4f5",
        durationMs: 31_247,
        fixtureId: "speaker-b",
        sourceSha256: "14a7925e1e46a9e7381d5fbfcbea5c746cf02644908daa0751f368dccdbf5b98",
      },
    ]);
  });

  it("rejects a truncated fixture even if it starts with an Ogg header", async () => {
    const bytes = await readFile(fixturePaths[0] ?? "");
    await expect(inspectOggOpus(bytes.subarray(0, 100))).rejects.toThrow("truncated");
  });
});
