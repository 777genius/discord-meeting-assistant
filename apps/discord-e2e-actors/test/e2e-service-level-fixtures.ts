import {
  e2eServiceLevelsV1Schema,
  type E2eServiceLevelsV1,
  type ServiceLevelThresholds,
} from "../src/e2e-service-levels.js";

export const exactServiceLevelThresholds: ServiceLevelThresholds = {
  "join-to-greeting-first-packet": 100,
  "question-end-to-answer-first-packet": 200,
  "recording-end-to-discord-first-seen": 300,
};

export function serviceLevelsProof(): E2eServiceLevelsV1 {
  return e2eServiceLevelsV1Schema.parse({
    measurements: Object.entries(exactServiceLevelThresholds).map(
      ([serviceLevelId, upperBoundMs], index) => ({
        clockSkewAttestation: {
          attestationId: `attestation-${index}`,
          clockSkewBoundMs: 5,
          endClockId: "observer-clock",
          schemaVersion: 1,
          startClockId: "source-clock",
        },
        end: {
          atEpochMs: 10_000 + upperBoundMs - 5,
          clockId: "observer-clock",
          eventId: `end-${index}`,
        },
        measurementId: `measurement-${index}`,
        serviceLevelId,
        start: {
          atEpochMs: 10_000,
          clockId: "source-clock",
          eventId: `start-${index}`,
        },
        upperBoundMs,
      }),
    ),
    schemaVersion: 1,
  });
}
