import { describe, expect, it } from "vitest";

import {
  createInfinitySemanticQualificationManifest,
  infinitySemanticQualificationSchema,
} from "../src/index.js";
import { semanticServiceConfig } from "./infinity-context-semantic-service.e2e.test.js";

const passingEvidence = {
  corpusHumanTurnsSha256: "a".repeat(64),
  endpointReceipt: {
    apiVersion: "v1",
    embeddingProfileDigestSha256: `sha256:${"b".repeat(64)}`,
    embeddingProfileId: "text-embedding-production-v1",
    enabledAdapters: ["qdrant"],
    qdrant: {
      enabled: true,
      healthy: true,
      supportsSearch: true,
      supportsUpsert: true,
    },
    serviceName: "disposable-infinity-context",
    serviceRevision: "d".repeat(40),
    supportsQdrant: true,
  },
  focusedQuestionCount: 7,
  focusedRecallAt5: 1,
  observedAt: "2026-08-15T12:00:00.000Z",
  releaseRevision: "c".repeat(40),
  remoteCleanupVerified: true,
  turnCount: 421,
} as const;

describe("Infinity production semantic qualification manifest", () => {
  it("binds a passing non-mock recall run to the immutable SDK and exact releases", () => {
    const manifest = createInfinitySemanticQualificationManifest(passingEvidence);

    expect(manifest).toMatchObject({
      claims: {
        productionSemanticQualification: true,
        remoteCleanupVerified: true,
      },
      corpus: { focusedQuestionCount: 7, focusedRecallAt5: 1, turnCount: 421 },
      embeddingProfile: {
        digestSha256: passingEvidence.endpointReceipt.embeddingProfileDigestSha256,
        id: passingEvidence.endpointReceipt.embeddingProfileId,
      },
      releaseRevision: passingEvidence.releaseRevision,
      schemaVersion: infinitySemanticQualificationSchema,
      service: {
        apiVersion: "v1",
        enabledAdapters: ["qdrant"],
        name: "disposable-infinity-context",
        revision: passingEvidence.endpointReceipt.serviceRevision,
      },
    });
    expect(manifest.sdk.packageSha256)
      .toBe("93ea6c98dec53c886250f3a3a06cb3825da27d1fc5ff73b85ab9633273e6bc1a");
  });

  it.each([
    [{ ...passingEvidence, endpointReceipt: { ...passingEvidence.endpointReceipt, embeddingProfileId: "deterministic-mock-non-production-v1" } }, /non-mock/u],
    [{ ...passingEvidence, focusedRecallAt5: 6 / 7 }, /complete frozen recall/u],
    [{ ...passingEvidence, focusedRecallAt5: 5 }, /complete frozen recall/u],
    [{ ...passingEvidence, remoteCleanupVerified: false }, /complete frozen recall/u],
    [{ ...passingEvidence, endpointReceipt: { ...passingEvidence.endpointReceipt, enabledAdapters: ["graphiti"] } }, /qdrant/u],
    [{ ...passingEvidence, endpointReceipt: { ...passingEvidence.endpointReceipt, embeddingProfileDigestSha256: "sha256:unknown" } }, /sha256-prefixed/u],
  ])("fails closed when evidence cannot qualify production search", (evidence, message) => {
    expect(() => createInfinitySemanticQualificationManifest(evidence)).toThrow(message);
  });

  it("reports the first exact missing input and refuses a mock live profile", () => {
    expect(() => semanticServiceConfig({})).toThrow(
      "INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE is required",
    );
    expect(() => semanticServiceConfig({
      INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE: "YES_DELETE_ALL_TEST_DATA",
      INFINITY_CONTEXT_SEMANTIC_E2E_EMBEDDING_PROFILE:
        "operator-value-is-not-evidence",
    })).toThrow("INFINITY_CONTEXT_SEMANTIC_E2E_URL is required");
  });
});
