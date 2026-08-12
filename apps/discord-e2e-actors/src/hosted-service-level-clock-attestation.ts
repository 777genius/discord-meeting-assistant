import { createHash } from "node:crypto";

import { z } from "zod";

import { serviceLevelIds } from "./e2e-service-levels.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const safeNonnegativeInteger = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a nonnegative safe integer",
);

const clockAttestationSchema = z.object({
  attestationId: sha256,
  clockSkewBoundMs: safeNonnegativeInteger,
  endClockId: identifier,
  endEvidenceSha256: sha256,
  method: z.literal("host-clock-skew-preflight-v1"),
  serviceLevelId: z.enum(serviceLevelIds),
  startClockId: identifier,
  startEvidenceSha256: sha256,
}).strict().superRefine((attestation, context) => {
  if (attestation.attestationId !== clockAttestationId({
    clockSkewBoundMs: attestation.clockSkewBoundMs,
    endClockId: attestation.endClockId,
    endEvidenceSha256: attestation.endEvidenceSha256,
    method: attestation.method,
    serviceLevelId: attestation.serviceLevelId,
    startClockId: attestation.startClockId,
    startEvidenceSha256: attestation.startEvidenceSha256,
  })) {
    context.addIssue({ code: "custom", message: "Clock attestation content digest is invalid" });
  }
});

export const hostedServiceLevelClockAttestationsV1Schema = z.object({
  host: z.literal(HOSTED_CAMPAIGN_TARGET.host),
  kind: z.literal("hosted-service-level-clock-attestations"),
  measurements: z.array(clockAttestationSchema).length(serviceLevelIds.length),
  meetingId: identifier,
  recordingId: identifier,
  runId: identifier,
  schemaVersion: z.literal(1),
}).strict().superRefine(({ measurements }, context) => {
  const ids = measurements.map(({ serviceLevelId }) => serviceLevelId);
  if (new Set(ids).size !== serviceLevelIds.length ||
    serviceLevelIds.some((id) => !ids.includes(id))) {
    context.addIssue({ code: "custom", message: "Clock attestations must cover each service level exactly once" });
  }
});

export type HostedServiceLevelClockAttestationsV1 = z.infer<
  typeof hostedServiceLevelClockAttestationsV1Schema
>;

type ClockAttestation = HostedServiceLevelClockAttestationsV1["measurements"][number];
type ClockAttestationContent = Omit<ClockAttestation, "attestationId">;

export function clockEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function clockAttestationId(
  value: ClockAttestationContent,
): string {
  return clockEvidenceDigest(value);
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
