import { describe, expect, it } from "vitest";

import {
  e2eServiceLevelsV1Schema,
  type E2eServiceLevelsV1,
  verifyE2eServiceLevels,
} from "../src/e2e-service-levels.js";
import {
  exactServiceLevelThresholds as thresholds,
  serviceLevelsProof as proofAtThresholds,
} from "./e2e-service-level-fixtures.js";


describe("E2E service-level proof", () => {
  it("accepts exact threshold N and rejects N + 1", () => {
    const proof = proofAtThresholds();
    expect(failureCodes(proof)).toEqual([]);

    const over = structuredClone(proof);
    over.measurements[1]!.end.atEpochMs += 1;
    over.measurements[1]!.upperBoundMs += 1;
    expect(failureCodes(over)).toEqual(["SLA_THRESHOLD_EXCEEDED"]);
  });

  it("strictly rejects missing, duplicate, negative, and unknown identifiers", () => {
    const proof = proofAtThresholds();
    expect(e2eServiceLevelsV1Schema.safeParse({
      ...proof,
      measurements: proof.measurements.slice(0, 2),
    }).success).toBe(false);
    expect(e2eServiceLevelsV1Schema.safeParse({
      ...proof,
      measurements: [proof.measurements[0], proof.measurements[0], proof.measurements[2]],
    }).success).toBe(false);
    expect(e2eServiceLevelsV1Schema.safeParse({
      ...proof,
      measurements: proof.measurements.map((measurement, index) => index === 0
        ? { ...measurement, upperBoundMs: -1 }
        : measurement),
    }).success).toBe(false);
    expect(e2eServiceLevelsV1Schema.safeParse({
      ...proof,
      measurements: proof.measurements.map((measurement, index) => index === 0
        ? { ...measurement, serviceLevelId: "join-to-some-packet" }
        : measurement),
    }).success).toBe(false);
  });

  it("requires matching clock attestation and rejects tampered bounds", () => {
    const mismatch = proofAtThresholds();
    mismatch.measurements[0]!.clockSkewAttestation.endClockId = "other-clock";
    expect(failureCodes(mismatch)).toEqual(["SLA_CLOCK_ATTESTATION_MISMATCH"]);

    const tampered = proofAtThresholds();
    tampered.measurements[0]!.upperBoundMs -= 1;
    expect(failureCodes(tampered)).toEqual(["SLA_UPPER_BOUND_TAMPERED"]);
  });

  it("accepts negative observed delta within skew and rejects one beyond it", () => {
    const withinSkew = proofAtThresholds();
    const measurement = withinSkew.measurements[0]!;
    measurement.end.atEpochMs = measurement.start.atEpochMs - 10;
    measurement.clockSkewAttestation.clockSkewBoundMs = 10;
    measurement.upperBoundMs = 0;
    expect(failureCodes(withinSkew)).toEqual([]);

    const impossible = structuredClone(withinSkew);
    impossible.measurements[0]!.end.atEpochMs -= 1;
    expect(failureCodes(impossible)).toEqual(["SLA_IMPOSSIBLE_TIMELINE"]);
  });
});

function failureCodes(proof: E2eServiceLevelsV1): string[] {
  const codes: string[] = [];
  verifyE2eServiceLevels(proof, thresholds, (code) => codes.push(code));
  return codes;
}
