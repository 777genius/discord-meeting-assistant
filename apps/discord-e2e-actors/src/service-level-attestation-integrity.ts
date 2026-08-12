import { createHash } from "node:crypto";

export interface ServiceLevelClockAttestationContent {
  readonly clockSkewBoundMs: number;
  readonly endClockId: string;
  readonly endEvidenceSha256: string;
  readonly method: "host-clock-skew-preflight-v1";
  readonly serviceLevelId: string;
  readonly startClockId: string;
  readonly startEvidenceSha256: string;
}

export function serviceLevelEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function serviceLevelClockAttestationId(value: ServiceLevelClockAttestationContent): string {
  return serviceLevelEvidenceDigest(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
