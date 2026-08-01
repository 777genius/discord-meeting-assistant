import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const fixturePaths = ["test/fixtures/speaker-a.ogg", "test/fixtures/speaker-b.ogg"];

describe("synthetic actor fixtures", () => {
  it.each(fixturePaths)("ships a valid Ogg Opus stream at %s", async (fixturePath) => {
    const bytes = await readFile(fixturePath);

    expect(bytes.subarray(0, 4).toString("ascii")).toBe("OggS");
    expect(bytes.includes(Buffer.from("OpusHead", "ascii"))).toBe(true);
    expect(bytes.length).toBeGreaterThan(1_000);
  });
});
