import { readFile } from "node:fs/promises";

const MEETING_PLATFORM_BUILD_PROVENANCE_PATH =
  "/opt/discord-meeting/meeting-platform-build-provenance.json";

export interface BuildProvenanceV1 {
  readonly releaseRevision: string;
  readonly schemaVersion: 1;
  readonly sourceTree: string;
  readonly sourceTreeSha256: string;
}

export type BuildProvenanceReader = () => Promise<BuildProvenanceV1>;

export async function readMeetingPlatformBuildProvenance(): Promise<BuildProvenanceV1> {
  return decodeBuildProvenance(JSON.parse(await readFile(
    MEETING_PLATFORM_BUILD_PROVENANCE_PATH,
    { encoding: "utf8" },
  )) as unknown);
}

export function decodeBuildProvenance(value: unknown): BuildProvenanceV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("immutable Meeting Platform build provenance is missing or invalid");
  }
  const input = value as Readonly<Record<string, unknown>>;
  const allowed = new Set([
    "releaseRevision",
    "schemaVersion",
    "sourceTree",
    "sourceTreeSha256",
  ]);
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    input.schemaVersion !== 1 ||
    typeof input.releaseRevision !== "string" ||
    !/^[0-9a-f]{40}$/u.test(input.releaseRevision) ||
    typeof input.sourceTree !== "string" ||
    !/^[0-9a-f]{40}$/u.test(input.sourceTree) ||
    typeof input.sourceTreeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.sourceTreeSha256)
  ) {
    throw new Error("immutable Meeting Platform build provenance is missing or invalid");
  }
  return Object.freeze({
    releaseRevision: input.releaseRevision,
    schemaVersion: 1,
    sourceTree: input.sourceTree,
    sourceTreeSha256: input.sourceTreeSha256,
  });
}
