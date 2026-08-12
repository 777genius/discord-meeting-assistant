import { createHash } from "node:crypto";

import { z } from "zod";

import {
  clockAttestationId,
  hostedServiceLevelClockAttestationsV1Schema,
  hostedServiceLevelClockAttestationsV2Schema,
  type HostedServiceLevelClockAttestationsV1,
  type HostedServiceLevelClockAttestationsV2,
} from "./hosted-service-level-clock-attestation.js";
import {
  hostedClockRunBindingV2Schema,
  hostedClockRunSkewBoundMs,
} from "./hosted-clock-proof-v2.js";
import type { HostedServiceLevelClockBindingRequest } from "./hosted-service-levels.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const safeNonnegativeInteger = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a nonnegative safe integer",
);

const hostedServiceLevelClockPreflightV1Schema = z.object({
  artifactId: sha256,
  clockSkewBoundMs: safeNonnegativeInteger,
  measuredAt: z.iso.datetime(),
  meetingId: identifier,
  method: z.string().trim().min(1).max(128),
  observerClockId: identifier,
  recordingId: identifier,
  runId: identifier,
  schemaVersion: z.literal(1),
  sourceClockId: identifier,
  target: z.object({
    environment: z.literal(HOSTED_CAMPAIGN_TARGET.environment),
    host: z.literal(HOSTED_CAMPAIGN_TARGET.host),
    project: z.literal(HOSTED_CAMPAIGN_TARGET.project),
  }).strict(),
  validFromEpochMs: safeNonnegativeInteger,
  validUntilEpochMs: safeNonnegativeInteger,
}).strict().superRefine((value, context) => {
  if (value.validUntilEpochMs < value.validFromEpochMs) {
    context.addIssue({ code: "custom", message: "Clock preflight validity window moved backwards" });
  }
  if (value.artifactId !== clockPreflightArtifactId({
    clockSkewBoundMs: value.clockSkewBoundMs,
    measuredAt: value.measuredAt,
    meetingId: value.meetingId,
    method: value.method,
    observerClockId: value.observerClockId,
    recordingId: value.recordingId,
    runId: value.runId,
    schemaVersion: value.schemaVersion,
    sourceClockId: value.sourceClockId,
    target: value.target,
    validFromEpochMs: value.validFromEpochMs,
    validUntilEpochMs: value.validUntilEpochMs,
  })) {
    context.addIssue({ code: "custom", message: "Clock preflight artifact digest is invalid" });
  }
});

export type HostedServiceLevelClockPreflightV1 = z.infer<
  typeof hostedServiceLevelClockPreflightV1Schema
>;

type ClockPreflightContent = Omit<HostedServiceLevelClockPreflightV1, "artifactId">;

export function clockPreflightArtifactId(value: ClockPreflightContent): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function attestHostedServiceLevelClocks(
  preflightValue: unknown,
  request: HostedServiceLevelClockBindingRequest,
): HostedServiceLevelClockAttestationsV1 {
  const preflight = hostedServiceLevelClockPreflightV1Schema.parse(preflightValue);
  if (
    preflight.runId !== request.runId || preflight.meetingId !== request.meetingId ||
    preflight.recordingId !== request.recordingId
  ) {
    throw new Error("Clock preflight does not match the hosted SLA run and recording");
  }
  const evidenceTimestamps = request.measurements.flatMap(
    ({ startAtEpochMs, endAtEpochMs }) => [startAtEpochMs, endAtEpochMs],
  );
  if (evidenceTimestamps.some((timestamp) =>
    timestamp < preflight.validFromEpochMs || timestamp > preflight.validUntilEpochMs
  )) {
    throw new Error("Clock preflight does not cover every hosted SLA source timestamp");
  }
  return hostedServiceLevelClockAttestationsV1Schema.parse({
    host: preflight.target.host,
    kind: "hosted-service-level-clock-attestations",
    measurements: request.measurements.map((measurement) => {
      const content = {
        clockSkewBoundMs: preflight.clockSkewBoundMs,
        endClockId: preflight.observerClockId,
        endEvidenceSha256: measurement.endEvidenceSha256,
        method: "host-clock-skew-preflight-v1" as const,
        serviceLevelId: measurement.serviceLevelId,
        startClockId: preflight.sourceClockId,
        startEvidenceSha256: measurement.startEvidenceSha256,
      };
      return { ...content, attestationId: clockAttestationId(content) };
    }),
    meetingId: request.meetingId,
    recordingId: request.recordingId,
    runId: request.runId,
    schemaVersion: 1,
  });
}

export function attestHostedServiceLevelClocksV2(
  runBindingValue: unknown,
  request: HostedServiceLevelClockBindingRequest,
): HostedServiceLevelClockAttestationsV2 {
  const binding = hostedClockRunBindingV2Schema.parse(runBindingValue);
  if (binding.runId !== request.runId || binding.meetingId !== request.meetingId ||
    binding.recordingId !== request.recordingId) {
    throw new Error("Clock V2 run proof does not match the hosted SLA run and recording");
  }
  assertClockV2ContainsEvidenceWindow(binding, request);
  const clockSkewBoundMs = hostedClockRunSkewBoundMs(binding);
  const measurements = request.measurements.map((measurement) => {
    const content = {
      clockSkewBoundMs,
      endClockId: binding.admission.raw.observerClockId,
      endEvidenceSha256: measurement.endEvidenceSha256,
      method: "ssh-bracketed-clock-v2" as const,
      runClockProofId: binding.proofId,
      serviceLevelId: measurement.serviceLevelId,
      startClockId: binding.admission.raw.sourceClockId,
      startEvidenceSha256: measurement.startEvidenceSha256,
    };
    return { ...content, attestationId: clockAttestationId(content) };
  });
  return hostedServiceLevelClockAttestationsV2Schema.parse({
    host: binding.admission.raw.target.host,
    kind: "hosted-service-level-clock-attestations",
    measurements,
    meetingId: request.meetingId,
    recordingId: request.recordingId,
    runClockProofId: binding.proofId,
    runId: request.runId,
    schemaVersion: 2,
  });
}

function assertClockV2ContainsEvidenceWindow(
  binding: z.infer<typeof hostedClockRunBindingV2Schema>,
  request: HostedServiceLevelClockBindingRequest,
): void {
  const firstEvidenceAt = Math.min(...request.measurements.map(({ startAtEpochMs }) => startAtEpochMs));
  const lastEvidenceAt = Math.max(...request.measurements.map(({ endAtEpochMs }) => endAtEpochMs));
  if (binding.admission.qualifiedAtEpochMs > firstEvidenceAt ||
    binding.admission.validUntilEpochMs < firstEvidenceAt) {
    throw new Error("Clock V2 admission was not live when the hosted run evidence started");
  }
  if (binding.completion.raw.observer.before.epochMs < lastEvidenceAt ||
    binding.completion.raw.source.before.epochMs < lastEvidenceAt) {
    throw new Error("Clock V2 completion bracket predates the final hosted run evidence");
  }
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
