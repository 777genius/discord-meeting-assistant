import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseCraigLifecycleEvent } from "../src/index.js";

const fixtureRoot = new URL("./fixtures/craig-lifecycle-v3/", import.meta.url);
const schemaFileName = "craig-lifecycle-v3.schema.json";
const fixturesFileName = "canonical-fixtures.json";
const pinnedChecksumManifestSha256 =
  "43b58c2661b22039fa432199227318b0d91fbbe1faa669bc0e62a68ddff8f940";
const pinnedBundleFileSha256 =
  "9ecdba8ebe3dd7e5ca4d67be0d540a66d07c3a66e0536dcd9c929099249f72a9";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checksumRecord(bytes: Uint8Array): ReadonlyMap<string, string> {
  const entries = new TextDecoder().decode(bytes).trimEnd().split("\n").map((line) => {
    const match = /^([a-f\d]{64})  (\S+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("pinned Craig checksum manifest is malformed");
    }
    return [match[2], match[1]] as const;
  });
  return new Map(entries);
}

describe("pinned Craig lifecycle v3 producer bundle", () => {
  it("pins exact schema, fixture, checksum-manifest, and bundle bytes", async () => {
    const [schema, fixtures, sums, bundle] = await Promise.all([
      readFile(new URL(schemaFileName, fixtureRoot)),
      readFile(new URL(fixturesFileName, fixtureRoot)),
      readFile(new URL("SHA256SUMS", fixtureRoot)),
      readFile(new URL("BUNDLE.sha256", fixtureRoot)),
    ]);
    const sumsByName = checksumRecord(sums);

    expect(sha256(schema)).toBe(sumsByName.get(schemaFileName));
    expect(sha256(fixtures)).toBe(sumsByName.get(fixturesFileName));
    expect(sha256(sums)).toBe(pinnedChecksumManifestSha256);
    expect(sha256(bundle)).toBe(pinnedBundleFileSha256);
    expect(new TextDecoder().decode(bundle)).toBe(`${sha256(sums)}  SHA256SUMS\n`);
  });

  it("parses every canonical producer lifecycle fixture", async () => {
    const bundle = JSON.parse(
      await readFile(new URL(fixturesFileName, fixtureRoot), "utf8"),
    ) as {
      readonly contract: string;
      readonly fixtures: readonly {
        readonly events: readonly unknown[];
        readonly name: string;
      }[];
    };

    expect(bundle.contract).toBe("craig-lifecycle-v3");
    expect(bundle.fixtures.length).toBeGreaterThan(0);
    for (const fixture of bundle.fixtures) {
      expect(fixture.events.length, fixture.name).toBeGreaterThan(0);
      for (const event of fixture.events) {
        expect(parseCraigLifecycleEvent(event), fixture.name).toEqual(event);
      }
    }
  });
});
