import { z } from "zod";

import {
  serviceLevelIds,
} from "./e2e-service-levels.js";
import {
  serviceLevelClockAttestationId,
  serviceLevelEvidenceDigest,
} from "./service-level-attestation-integrity.js";
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

const clockAttestationV2Schema = z.object({
  attestationId: sha256,
  clockSkewBoundMs: safeNonnegativeInteger,
  endClockId: identifier,
  endEvidenceSha256: sha256,
  method: z.literal("ssh-bracketed-clock-v2"),
  runClockProofId: sha256,
  serviceLevelId: z.enum(serviceLevelIds),
  startClockId: identifier,
  startEvidenceSha256: sha256,
}).strict().superRefine((attestation, context) => {
  if (attestation.attestationId !== clockAttestationId({
    clockSkewBoundMs: attestation.clockSkewBoundMs,
    endClockId: attestation.endClockId,
    endEvidenceSha256: attestation.endEvidenceSha256,
    method: attestation.method,
    runClockProofId: attestation.runClockProofId,
    serviceLevelId: attestation.serviceLevelId,
    startClockId: attestation.startClockId,
    startEvidenceSha256: attestation.startEvidenceSha256,
  })) {
    context.addIssue({ code: "custom", message: "Clock V2 attestation content digest is invalid" });
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

export const hostedServiceLevelClockAttestationsV2Schema = z.object({
  host: z.literal(HOSTED_CAMPAIGN_TARGET.host),
  kind: z.literal("hosted-service-level-clock-attestations"),
  measurements: z.array(clockAttestationV2Schema).length(serviceLevelIds.length),
  meetingId: identifier,
  recordingId: identifier,
  runClockProofId: sha256,
  runId: identifier,
  schemaVersion: z.literal(2),
}).strict().superRefine(({ measurements, runClockProofId }, context) => {
  const ids = measurements.map(({ serviceLevelId }) => serviceLevelId);
  if (new Set(ids).size !== serviceLevelIds.length || serviceLevelIds.some((id) => !ids.includes(id))) {
    context.addIssue({ code: "custom", message: "Clock V2 attestations must cover each service level exactly once" });
  }
  if (measurements.some((measurement) => measurement.runClockProofId !== runClockProofId)) {
    context.addIssue({ code: "custom", message: "Clock V2 attestations do not share the run proof" });
  }
});

export type HostedServiceLevelClockAttestationsV2 = z.infer<
  typeof hostedServiceLevelClockAttestationsV2Schema
>;

type ClockAttestation = HostedServiceLevelClockAttestationsV1["measurements"][number];
type ClockAttestationV2 = HostedServiceLevelClockAttestationsV2["measurements"][number];
type ClockAttestationContent = Omit<ClockAttestation, "attestationId"> |
  Omit<ClockAttestationV2, "attestationId">;

export function clockEvidenceDigest(value: unknown): string {
  return serviceLevelEvidenceDigest(value);
}

export function clockAttestationId(
  value: ClockAttestationContent,
): string {
  return serviceLevelClockAttestationId(value);
}
