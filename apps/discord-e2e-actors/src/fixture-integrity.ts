import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  fixtureManifestV1Schema,
  type ActorRunEvidenceV1,
  type FixtureManifestV1,
} from "./e2e-evidence.js";

export interface ConfiguredFixture {
  readonly actorName: "speaker-a" | "speaker-b";
  readonly fixturePath: string;
}

export interface VerifiedFixtureSet {
  readonly fixtures: Readonly<ActorRunEvidenceV1["fixtures"]>;
  readonly manifest: FixtureManifestV1;
}

export async function loadVerifiedFixtureSet(
  manifestPath: string,
  configured: readonly ConfiguredFixture[],
): Promise<VerifiedFixtureSet> {
  const manifest = fixtureManifestV1Schema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const fixtures: ActorRunEvidenceV1["fixtures"][number][] = [];
  for (const fixture of manifest.fixtures) {
    const selected = configured.find(({ actorName }) => actorName === fixture.actorName);
    if (selected === undefined) {
      throw new Error(`No configured audio file for ${fixture.actorName}`);
    }
    if (resolve(selected.fixturePath) !== resolve(fixture.audioPath)) {
      throw new Error(`${fixture.actorName} fixture path does not match the pinned manifest`);
    }
    const bytes = await readFile(selected.fixturePath);
    const inspected = await inspectOggOpus(bytes);
    if (inspected.sha256 !== fixture.audioSha256) {
      throw new Error(`${fixture.actorName} fixture SHA-256 does not match the pinned manifest`);
    }
    if (inspected.durationMs !== fixture.durationMs) {
      throw new Error(`${fixture.actorName} fixture duration does not match the pinned manifest`);
    }
    fixtures.push({
      audioSha256: inspected.sha256,
      durationMs: inspected.durationMs,
      fixtureId: fixture.fixtureId,
      sourceSha256: fixture.sourceSha256,
    });
  }
  return { fixtures: Object.freeze(fixtures), manifest };
}

export async function inspectOggOpus(
  bytes: Uint8Array,
): Promise<{ readonly durationMs: number; readonly sha256: string }> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.includes(Buffer.from("OpusHead", "ascii"))) {
    throw new Error("fixture is not an Ogg Opus stream");
  }
  let offset = 0;
  let maximumGranule = 0n;
  while (offset < buffer.byteLength) {
    if (offset + 27 > buffer.byteLength || buffer.toString("ascii", offset, offset + 4) !== "OggS") {
      throw new Error("fixture contains a truncated or invalid Ogg page");
    }
    const segmentCount = buffer[offset + 26] ?? 0;
    const segmentTableEnd = offset + 27 + segmentCount;
    if (segmentTableEnd > buffer.byteLength) {
      throw new Error("fixture contains a truncated Ogg segment table");
    }
    let bodyLength = 0;
    for (let index = offset + 27; index < segmentTableEnd; index += 1) {
      bodyLength += buffer[index] ?? 0;
    }
    const pageEnd = segmentTableEnd + bodyLength;
    if (pageEnd > buffer.byteLength) {
      throw new Error("fixture contains a truncated Ogg page body");
    }
    const granule = buffer.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn && granule > maximumGranule) {
      maximumGranule = granule;
    }
    offset = pageEnd;
  }
  if (maximumGranule === 0n) {
    throw new Error("fixture has no positive Ogg granule duration");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    durationMs: Math.round(Number(maximumGranule) / 48),
    sha256: Buffer.from(digest).toString("hex"),
  };
}
