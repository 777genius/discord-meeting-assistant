import { describe, expect, it } from "vitest";

import {
  e2eServiceLevelsV1Schema,
  type E2eServiceLevelsV1,
  verifyE2eServiceLevels,
} from "../src/e2e-service-levels.js";
import {
  exactServiceLevelThresholds as thresholds,
  serviceLevelSourcesProof,
  serviceLevelsProof as proofAtThresholds,
} from "./e2e-service-level-fixtures.js";
import { retainedV8Evidence } from "./e2e-evidence-fixtures.js";


describe("E2E service-level proof", () => {
  it("accepts exact threshold N and rejects N + 1", () => {
    const proof = proofAtThresholds();
    expect(failureCodes(proof)).toEqual([]);

    const over = structuredClone(proof);
    const measurement = over.measurements.find(({ serviceLevelId }) =>
      serviceLevelId === "question-end-to-answer-first-packet"
    )!;
    expect(failureCodes(over, {
      ...thresholds,
      "question-end-to-answer-first-packet": measurement.upperBoundMs - 1,
    })).toEqual(["SLA_THRESHOLD_EXCEEDED"]);
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

  it("rejects timestamp tampering before recomputing a bound", () => {
    const tampered = proofAtThresholds();
    tampered.measurements[0]!.end.atEpochMs -= 10;
    tampered.measurements[0]!.upperBoundMs -= 10;
    expect(failureCodes(tampered)).toEqual(["SLA_SOURCE_MISMATCH"]);
  });

  it.each([
    ["run", (proof: E2eServiceLevelsV1) => { proof.measurements[0]!.end.source.runId = "other-run"; }],
    ["meeting", (proof: E2eServiceLevelsV1) => { proof.measurements[1]!.end.source.meetingId = "other-meeting"; }],
    ["turn", (proof: E2eServiceLevelsV1) => {
      const measurement = proof.measurements.find(({ serviceLevelId }) =>
        serviceLevelId === "question-end-to-answer-first-packet"
      )!;
      if (measurement.serviceLevelId === "question-end-to-answer-first-packet") {
        measurement.end.source.turnId = "other-turn";
      }
    }],
    ["attempt", (proof: E2eServiceLevelsV1) => {
      const measurement = proof.measurements.find(({ serviceLevelId }) =>
        serviceLevelId === "question-end-to-answer-first-packet"
      )!;
      if (measurement.serviceLevelId === "question-end-to-answer-first-packet") {
        measurement.end.source.attemptId = "other-attempt";
      }
    }],
    ["recording", (proof: E2eServiceLevelsV1) => { proof.measurements[2]!.end.source.recordingId = "other-recording"; }],
    ["message", (proof: E2eServiceLevelsV1) => {
      const measurement = proof.measurements.find(({ serviceLevelId }) =>
        serviceLevelId === "recording-end-to-discord-first-seen"
      )!;
      if (measurement.serviceLevelId === "recording-end-to-discord-first-seen") {
        measurement.end.source.messageId = "other-message";
      }
    }],
  ])("rejects a wrong %s source identity", (_label, mutate) => {
    const proof = proofAtThresholds();
    mutate(proof);
    expect(failureCodes(proof)).toEqual(["SLA_SOURCE_MISMATCH"]);
  });

  it("fails closed when lifecycle or link receipts are not retained", () => {
    const proof = proofAtThresholds();
    const evidence = retainedV8Evidence();
    const codes: string[] = [];
    verifyE2eServiceLevels(proof, thresholds, evidence, (code) => codes.push(code));
    expect(codes).toEqual(["SLA_SOURCE_MISMATCH", "SLA_SOURCE_MISMATCH"]);

    const sources = serviceLevelSourcesProof();
    sources.participantLifecycleReceipts = [];
    const withoutJoin: string[] = [];
    verifyE2eServiceLevels(proof, thresholds, { ...evidence, serviceLevelSources: sources },
      (code) => withoutJoin.push(code));
    expect(withoutJoin).toEqual(["SLA_SOURCE_MISMATCH"]);
  });
});

function failureCodes(proof: E2eServiceLevelsV1, suppliedThresholds = thresholds): string[] {
  const codes: string[] = [];
  const evidence = retainedV8Evidence();
  verifyE2eServiceLevels(proof, suppliedThresholds, {
    ...evidence,
    serviceLevelSources: serviceLevelSourcesProof(),
  }, (code) => codes.push(code));
  return codes;
}
