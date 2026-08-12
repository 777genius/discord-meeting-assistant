import { describe, expect, it } from "vitest";

import {
  attestHostedServiceLevelClocks,
  attestHostedServiceLevelClocksV2,
  clockPreflightArtifactId,
} from "../src/hosted-service-level-clock-preflight.js";
import {
  bindHostedClockRunV2,
  deriveHostedClockPreflightReceiptV2,
} from "../src/hosted-clock-proof-v2.js";
import type { HostedServiceLevelClockBindingRequest } from
  "../src/hosted-service-levels.js";

const request: HostedServiceLevelClockBindingRequest = {
  measurements: [
    {
      endAtEpochMs: 1_100,
      endEvidenceSha256: "b".repeat(64),
      serviceLevelId: "join-to-greeting-first-packet",
      startAtEpochMs: 1_000,
      startEvidenceSha256: "a".repeat(64),
    },
    {
      endAtEpochMs: 1_300,
      endEvidenceSha256: "d".repeat(64),
      serviceLevelId: "question-end-to-answer-first-packet",
      startAtEpochMs: 1_200,
      startEvidenceSha256: "c".repeat(64),
    },
    {
      endAtEpochMs: 1_500,
      endEvidenceSha256: "f".repeat(64),
      serviceLevelId: "recording-end-to-discord-first-seen",
      startAtEpochMs: 1_400,
      startEvidenceSha256: "e".repeat(64),
    },
  ],
  meetingId: "meeting-1",
  recordingId: "meeting-1",
  runId: "run-1",
};

describe("hosted service-level external clock preflight", () => {
  it("binds the measured external bound and exact source digests", () => {
    const result = attestHostedServiceLevelClocks(preflight(), request);

    expect(result.measurements).toHaveLength(3);
    expect(result.measurements[0]).toMatchObject({
      clockSkewBoundMs: 7,
      endClockId: "host-observer-clock",
      endEvidenceSha256: "b".repeat(64),
      startClockId: "meeting-source-clock",
      startEvidenceSha256: "a".repeat(64),
    });
  });

  it("rejects a self-inconsistent or differently bound preflight", () => {
    expect(() => attestHostedServiceLevelClocks({
      ...preflight(),
      clockSkewBoundMs: 0,
    }, request)).toThrow("digest");
    expect(() => attestHostedServiceLevelClocks(preflight({ runId: "other-run" }), request))
      .toThrow("does not match");
  });

  it("rejects a preflight window that does not cover all raw evidence", () => {
    expect(() => attestHostedServiceLevelClocks(preflight({ validUntilEpochMs: 1_499 }), request))
      .toThrow("does not cover");
  });

  it("produces V2 SLA attestations only from a run-bound V2 clock proof", () => {
    const admission = deriveHostedClockPreflightReceiptV2(clockExchange(900, 900_000_000n));
    const runClock = bindHostedClockRunV2({
      admission,
      completion: clockExchange(11_000, 11_000_000_000n),
      meetingId: request.meetingId,
      recordingId: request.recordingId,
      runId: request.runId,
    });

    const result = attestHostedServiceLevelClocksV2(runClock, request);
    expect(result).toMatchObject({ runClockProofId: runClock.proofId, schemaVersion: 2 });
    expect(result.measurements).toHaveLength(request.measurements.length);
    for (const measurement of result.measurements) {
      expect(measurement).toMatchObject({
        method: "ssh-bracketed-clock-v2",
        runClockProofId: runClock.proofId,
      });
    }
    expect(() => attestHostedServiceLevelClocksV2(preflight(), request)).toThrow();
  });

  it("rejects an admission that expired before the first measured source", () => {
    const admission = deriveHostedClockPreflightReceiptV2(clockExchange(1_000, 1_000_000_000n));
    const runClock = bindHostedClockRunV2({
      admission,
      completion: clockExchange(70_000, 70_000_000_000n),
      meetingId: request.meetingId, recordingId: request.recordingId, runId: request.runId,
    });
    const lateRequest = { ...request, measurements: request.measurements.map((measurement) => ({
      ...measurement, endAtEpochMs: measurement.endAtEpochMs + 61_000,
      startAtEpochMs: measurement.startAtEpochMs + 61_000,
    })) };
    expect(() => attestHostedServiceLevelClocksV2(runClock, lateRequest))
      .toThrow("was not live");
  });

  it("rejects a completion bracket captured before the final measured source", () => {
    const admission = deriveHostedClockPreflightReceiptV2(clockExchange(900, 900_000_000n));
    const runClock = bindHostedClockRunV2({
      admission, completion: clockExchange(1_490, 1_490_000_000n),
      meetingId: request.meetingId, recordingId: request.recordingId, runId: request.runId,
    });
    expect(() => attestHostedServiceLevelClocksV2(runClock, request))
      .toThrow("predates the final hosted run evidence");
  });
});

function clockExchange(epoch: number, monotonic: bigint) {
  return {
    observer: {
      after: { bootId: "observer-boot", epochMs: epoch + 10, monotonicNs: String(monotonic + 10_000_000n) },
      before: { bootId: "observer-boot", epochMs: epoch, monotonicNs: String(monotonic) },
    },
    observerClockId: "host-observer-clock",
    source: {
      after: { bootId: "source-boot", epochMs: epoch + 8, monotonicNs: String(monotonic + 8_000_000n) },
      before: { bootId: "source-boot", epochMs: epoch + 5, monotonicNs: String(monotonic + 5_000_000n) },
      sample: { bootId: "source-boot", epochMs: epoch + 7, monotonicNs: String(monotonic + 7_000_000n) },
    },
    sourceClockId: "meeting-source-clock",
    target: { environment: "private-test-guild" as const, host: "codex-workers-eu-01" as const,
      project: "discord-meeting-assistant" as const },
  };
}

function preflight(overrides: Partial<PreflightContent> = {}) {
  const content: PreflightContent = {
    clockSkewBoundMs: 7,
    measuredAt: "1970-01-01T00:00:01.000Z",
    meetingId: "meeting-1",
    method: "synthetic-ntp-bound-v1",
    observerClockId: "host-observer-clock",
    recordingId: "meeting-1",
    runId: "run-1",
    schemaVersion: 1,
    sourceClockId: "meeting-source-clock",
    target: {
      environment: "private-test-guild",
      host: "codex-workers-eu-01",
      project: "discord-meeting-assistant",
    },
    validFromEpochMs: 900,
    validUntilEpochMs: 1_600,
    ...overrides,
  };
  return { ...content, artifactId: clockPreflightArtifactId(content) };
}

interface PreflightContent {
  readonly clockSkewBoundMs: number;
  readonly measuredAt: string;
  readonly meetingId: string;
  readonly method: string;
  readonly observerClockId: string;
  readonly recordingId: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly sourceClockId: string;
  readonly target: {
    readonly environment: "private-test-guild";
    readonly host: "codex-workers-eu-01";
    readonly project: "discord-meeting-assistant";
  };
  readonly validFromEpochMs: number;
  readonly validUntilEpochMs: number;
}
