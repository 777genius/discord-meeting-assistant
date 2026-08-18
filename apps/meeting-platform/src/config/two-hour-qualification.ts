import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  TwoHourHistoricalQualificationV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import type { BuildProvenanceV1 } from "./build-provenance.js";

export const TWO_HOUR_QUALIFICATION_MANIFEST_SCHEMA =
  "meeting-knowledge.two-hour-qualification-manifest.v1" as const;

export interface AcceptedTwoHourQualification {
  readonly evidenceSha256: string;
  readonly manifestSha256: string;
  readonly releaseRevision: string;
  readonly rolloutEpoch: string;
  readonly sourceTreeSha256: string;
}

// Fail closed until a reviewed two-hour holdout manifest is retained.
const ACCEPTED_TWO_HOUR_QUALIFICATION:
  AcceptedTwoHourQualification | null = null;

export type QualificationFileReader = (path: string) => Promise<Buffer>;

export async function loadTwoHourHistoricalQualification(
  path: string | undefined,
  build: BuildProvenanceV1 | undefined,
  readQualificationFile: QualificationFileReader = readFile,
  accepted: AcceptedTwoHourQualification | null =
    ACCEPTED_TWO_HOUR_QUALIFICATION,
): Promise<TwoHourHistoricalQualificationV1 | undefined> {
  if (path === undefined) {
    return undefined;
  }
  if (build === undefined) {
    throw new Error("two-hour qualification requires immutable build provenance");
  }
  if (accepted === null) {
    throw new Error("no retained two-hour qualification is accepted by this release");
  }
  const bytes = await readQualificationFile(path);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (manifestSha256 !== accepted.manifestSha256) {
    throw new Error("two-hour qualification manifest digest is not retained");
  }
  const manifest = decodeManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  if (
    manifest.evidenceSha256 !== accepted.evidenceSha256 ||
    manifest.releaseRevision !== accepted.releaseRevision ||
    manifest.rolloutEpoch !== accepted.rolloutEpoch ||
    manifest.sourceTreeSha256 !== accepted.sourceTreeSha256 ||
    manifest.releaseRevision !== build.releaseRevision ||
    manifest.sourceTreeSha256 !== build.sourceTreeSha256
  ) {
    throw new Error(
      "two-hour qualification does not match the accepted rollout and running source tree",
    );
  }
  return Object.freeze({
    evidenceSha256: manifest.evidenceSha256,
    releaseRevision: manifest.releaseRevision,
    rolloutEpoch: manifest.rolloutEpoch,
    schemaVersion: 1 as const,
  });
}

interface Manifest {
  readonly evidenceSha256: string;
  readonly releaseRevision: string;
  readonly rolloutEpoch: string;
  readonly schemaVersion: typeof TWO_HOUR_QUALIFICATION_MANIFEST_SCHEMA;
  readonly sourceTreeSha256: string;
}

function decodeManifest(value: unknown): Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("two-hour qualification manifest must be an object");
  }
  const input = value as Readonly<Record<string, unknown>>;
  const allowed = new Set([
    "evidenceSha256",
    "releaseRevision",
    "rolloutEpoch",
    "schemaVersion",
    "sourceTreeSha256",
  ]);
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    input.schemaVersion !== TWO_HOUR_QUALIFICATION_MANIFEST_SCHEMA ||
    typeof input.evidenceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.evidenceSha256) ||
    typeof input.releaseRevision !== "string" ||
    !/^[0-9a-f]{40}$/u.test(input.releaseRevision) ||
    typeof input.rolloutEpoch !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.rolloutEpoch) ||
    typeof input.sourceTreeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.sourceTreeSha256)
  ) {
    throw new Error("two-hour qualification manifest is invalid");
  }
  return {
    evidenceSha256: input.evidenceSha256,
    releaseRevision: input.releaseRevision,
    rolloutEpoch: input.rolloutEpoch,
    schemaVersion: TWO_HOUR_QUALIFICATION_MANIFEST_SCHEMA,
    sourceTreeSha256: input.sourceTreeSha256,
  };
}
