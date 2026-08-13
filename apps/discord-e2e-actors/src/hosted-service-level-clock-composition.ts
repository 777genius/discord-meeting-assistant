import { createHash } from "node:crypto";

import { z } from "zod";

import { e2eServiceLevelsV1Schema, type E2eServiceLevelsV1 } from "./e2e-service-levels.js";
import { e2eServiceLevelsV2Schema, type E2eServiceLevelsV2 } from "./e2e-service-levels-v2.js";
import {
  hostedServiceLevelClockAttestationsV1Schema,
  hostedServiceLevelClockAttestationsV2Schema,
} from "./hosted-service-level-clock-attestation.js";

export interface HostedPreparedMeasurement {
  readonly endAtEpochMs: number;
  readonly endEvidenceSha256: string;
  readonly endSource: Record<string, unknown>;
  readonly serviceLevelId: E2eServiceLevelsV1["measurements"][number]["serviceLevelId"];
  readonly startAtEpochMs: number;
  readonly startEvidenceSha256: string;
  readonly startSource: Record<string, unknown>;
}

export function composeHostedServiceLevels(input: {
  readonly attestations: unknown;
  readonly measurements: readonly HostedPreparedMeasurement[];
  readonly meetingId: string;
  readonly recordingId: string;
  readonly runId: string;
}): E2eServiceLevelsV1 | E2eServiceLevelsV2 {
  const version = z.looseObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]) })
    .parse(input.attestations).schemaVersion;
  const attestations = version === 2
    ? hostedServiceLevelClockAttestationsV2Schema.parse(input.attestations)
    : hostedServiceLevelClockAttestationsV1Schema.parse(input.attestations);
  if (attestations.runId !== input.runId || attestations.meetingId !== input.meetingId ||
    attestations.recordingId !== input.recordingId) {
    throw new Error("Hosted clock attestations do not match the run and recording");
  }
  const measurements = input.measurements.map((source) => {
    const attestation = attestations.measurements.find(
      ({ serviceLevelId }) => serviceLevelId === source.serviceLevelId,
    );
    if (attestation === undefined || attestation.startEvidenceSha256 !== source.startEvidenceSha256 ||
      attestation.endEvidenceSha256 !== source.endEvidenceSha256) {
      throw new Error(`${source.serviceLevelId} clocks are not bound to its exact source artifacts`);
    }
    const upperBoundMs = source.endAtEpochMs - source.startAtEpochMs + attestation.clockSkewBoundMs;
    if (!Number.isSafeInteger(upperBoundMs) || upperBoundMs < 0) {
      throw new RangeError(`${source.serviceLevelId} has an impossible attested timeline`);
    }
    return {
      clockSkewAttestation: {
        attestationId: attestation.attestationId,
        clockSkewBoundMs: attestation.clockSkewBoundMs,
        endClockId: attestation.endClockId,
        endEvidenceSha256: attestation.endEvidenceSha256,
        method: attestation.method,
        ...(attestation.method === "ssh-bracketed-clock-v2"
          ? { runClockProofId: attestation.runClockProofId, schemaVersion: 2 as const }
          : { schemaVersion: 1 as const }),
        startClockId: attestation.startClockId,
        startEvidenceSha256: attestation.startEvidenceSha256,
      },
      end: { atEpochMs: source.endAtEpochMs, clockId: attestation.endClockId, source: source.endSource },
      measurementId: measurementId(source),
      serviceLevelId: source.serviceLevelId,
      start: { atEpochMs: source.startAtEpochMs, clockId: attestation.startClockId, source: source.startSource },
      upperBoundMs,
    };
  });
  if (attestations.schemaVersion === 2) {
    return e2eServiceLevelsV2Schema.parse({
      measurements, runClockProofId: attestations.runClockProofId, schemaVersion: 2,
    });
  }
  return e2eServiceLevelsV1Schema.parse({ measurements, schemaVersion: 1 });
}

function measurementId(source: HostedPreparedMeasurement): string {
  const digest = createHash("sha256").update(JSON.stringify([
    source.serviceLevelId, source.startSource, source.endSource,
  ])).digest("hex").slice(0, 32);
  return `hosted-sla:${source.serviceLevelId}:${digest}`;
}
