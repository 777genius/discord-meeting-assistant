import { describe, expect, it } from "vitest";

import {
  createInfinitySemanticQualificationManifest,
  infinitySemanticQualificationSchema,
} from "../src/index.js";
import {
  checkoutQualificationProvenance,
  semanticServiceConfig,
} from "./infinity-context-semantic-service.e2e.test.js";

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
  qualificationHarnessSha256: "e".repeat(64),
  releaseSourceTreeSha256: "f".repeat(64),
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
      source: {
        harnessSha256: passingEvidence.qualificationHarnessSha256,
        treeSha256: passingEvidence.releaseSourceTreeSha256,
      },
    });
    expect(manifest.sdk.packageSha256)
      .toBe("2e4bcced4df632a7953c7ff767a4076ce6cfff1aa4469a40e8b36659f29a90c8");
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

  it("reports the first exact missing input and refuses a mock live profile", async () => {
    await expect(semanticServiceConfig({})).rejects.toThrow(
      "INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE is required",
    );
    await expect(semanticServiceConfig({
      INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE: "YES_DELETE_ALL_TEST_DATA",
      INFINITY_CONTEXT_SEMANTIC_E2E_EMBEDDING_PROFILE:
        "operator-value-is-not-evidence",
    })).rejects.toThrow("INFINITY_CONTEXT_SEMANTIC_E2E_URL is required");
  });

  it("binds evidence to checkout HEAD and ignores a spoofed operator label", async () => {
    const actualRevision = "f".repeat(40);
    const config = await semanticServiceConfig({
      INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE: "YES_DELETE_ALL_TEST_DATA",
      INFINITY_CONTEXT_SEMANTIC_E2E_URL: "https://infinity.invalid/",
      MEETING_KNOWLEDGE_RELEASE_REVISION: "a".repeat(40),
    }, async () => ({
      qualificationHarnessSha256: "b".repeat(64),
      releaseRevision: actualRevision,
      sourceTreeSha256: "c".repeat(64),
    }));

    expect(config.releaseRevision).toBe(actualRevision);
  });

  it("refuses to qualify a dirty checkout before deriving release evidence", async () => {
    await expect(checkoutQualificationProvenance(async (args) =>
      args[0] === "status" ? " M qualification-harness.ts\n" : ""
    )).rejects.toThrow("clean Git checkout");
  });
});
