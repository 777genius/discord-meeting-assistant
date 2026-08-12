import { describe, expect, it } from "vitest";

import {
  attestHostedServiceLevelClocks,
  clockPreflightArtifactId,
} from "../src/hosted-service-level-clock-preflight.js";
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
});

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
