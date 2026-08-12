import { z } from "zod";

import { serviceLevelIds, serviceLevelMeasurementV2Schema } from "./e2e-service-levels.js";

const sha256 = z.string().regex(/^[a-f\d]{64}$/u);

export const e2eServiceLevelsV2Schema = z.object({
  measurements: z.array(serviceLevelMeasurementV2Schema).length(serviceLevelIds.length),
  runClockProofId: sha256,
  schemaVersion: z.literal(2),
}).strict().superRefine(({ measurements, runClockProofId }, context) => {
  requireUnique(measurements.map(({ measurementId }) => measurementId), "measurementId", context);
  requireUnique(measurements.map(({ serviceLevelId }) => serviceLevelId), "serviceLevelId", context);
  for (const serviceLevelId of serviceLevelIds) {
    if (!measurements.some((measurement) => measurement.serviceLevelId === serviceLevelId)) {
      context.addIssue({ code: "custom", message: `Missing service level ${serviceLevelId}` });
    }
  }
  if (measurements.some(({ clockSkewAttestation }) =>
    clockSkewAttestation.runClockProofId !== runClockProofId)) {
    context.addIssue({ code: "custom", message: "Service levels do not share the run clock proof" });
  }
});

export type E2eServiceLevelsV2 = z.infer<typeof e2eServiceLevelsV2Schema>;

function requireUnique(values: readonly string[], label: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `Duplicate ${label}` });
  }
}
