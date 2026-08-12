import { z } from "zod";

import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

export const serviceLevelIds = [
  "join-to-greeting-first-packet",
  "question-end-to-answer-first-packet",
  "recording-end-to-discord-first-seen",
] as const;

const identifierSchema = z.string().trim().min(1);
const safeNonNegativeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a nonnegative safe integer",
);
const timestampSchema = z.number().refine(Number.isSafeInteger, "Expected a safe integer timestamp");

const clockSkewAttestationSchema = z.object({
  attestationId: identifierSchema,
  clockSkewBoundMs: safeNonNegativeIntegerSchema,
  endClockId: identifierSchema,
  schemaVersion: z.literal(1),
  startClockId: identifierSchema,
}).strict();

export const serviceLevelMeasurementV1Schema = z.object({
  clockSkewAttestation: clockSkewAttestationSchema,
  end: z.object({
    atEpochMs: timestampSchema,
    clockId: identifierSchema,
    eventId: identifierSchema,
  }).strict(),
  measurementId: identifierSchema,
  serviceLevelId: z.enum(serviceLevelIds),
  start: z.object({
    atEpochMs: timestampSchema,
    clockId: identifierSchema,
    eventId: identifierSchema,
  }).strict(),
  upperBoundMs: safeNonNegativeIntegerSchema,
}).strict();

export const e2eServiceLevelsV1Schema = z.object({
  measurements: z.array(serviceLevelMeasurementV1Schema).length(serviceLevelIds.length),
  schemaVersion: z.literal(1),
}).strict().superRefine(({ measurements }, context) => {
  requireUnique(measurements.map(({ measurementId }) => measurementId), "measurementId", context);
  requireUnique(measurements.map(({ serviceLevelId }) => serviceLevelId), "serviceLevelId", context);
  for (const serviceLevelId of serviceLevelIds) {
    if (!measurements.some((measurement) => measurement.serviceLevelId === serviceLevelId)) {
      context.addIssue({ code: "custom", message: `Missing service level ${serviceLevelId}` });
    }
  }
});

export const serviceLevelThresholdsSchema = z.object({
  "join-to-greeting-first-packet": safeNonNegativeIntegerSchema,
  "question-end-to-answer-first-packet": safeNonNegativeIntegerSchema,
  "recording-end-to-discord-first-seen": safeNonNegativeIntegerSchema,
}).strict();

export type E2eServiceLevelsV1 = z.infer<typeof e2eServiceLevelsV1Schema>;
export type ServiceLevelThresholds = z.infer<typeof serviceLevelThresholdsSchema>;

export function verifyE2eServiceLevels(
  serviceLevels: E2eServiceLevelsV1,
  thresholdsInput: ServiceLevelThresholds,
  fail: VerificationFailureReporter,
): void {
  const thresholds = serviceLevelThresholdsSchema.parse(thresholdsInput);
  for (const measurement of serviceLevels.measurements) {
    const { clockSkewAttestation, end, serviceLevelId, start } = measurement;
    if (
      clockSkewAttestation.startClockId !== start.clockId ||
      clockSkewAttestation.endClockId !== end.clockId
    ) {
      fail("SLA_CLOCK_ATTESTATION_MISMATCH", `${serviceLevelId} clock IDs do not match their attestation`);
      continue;
    }
    const measuredDeltaMs = end.atEpochMs - start.atEpochMs;
    if (measuredDeltaMs + clockSkewAttestation.clockSkewBoundMs < 0) {
      fail("SLA_IMPOSSIBLE_TIMELINE", `${serviceLevelId} end precedes start beyond the attested clock skew`);
      continue;
    }
    const recomputedUpperBoundMs = measuredDeltaMs + clockSkewAttestation.clockSkewBoundMs;
    if (measurement.upperBoundMs !== recomputedUpperBoundMs) {
      fail("SLA_UPPER_BOUND_TAMPERED", `${serviceLevelId} upper bound does not match its timestamps and clock skew`);
      continue;
    }
    if (recomputedUpperBoundMs > thresholds[serviceLevelId]) {
      fail("SLA_THRESHOLD_EXCEEDED", `${serviceLevelId} upper bound exceeds its supplied threshold`);
    }
  }
}

function requireUnique(
  values: readonly string[],
  field: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `Duplicate ${field}` });
  }
}
