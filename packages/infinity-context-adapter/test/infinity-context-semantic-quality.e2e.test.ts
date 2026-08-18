import { describe, expect, it } from "vitest";

import { runSemanticQualityRetrieval } from "./semantic-quality-retrieval-helper.js";

const enabled = process.env.INFINITY_CONTEXT_SEMANTIC_QUALITY_E2E === "1";
const liveDescribe = enabled ? describe : describe.skip;

liveDescribe("Infinity Context frozen semantic quality retrieval", () => {
  it("emits retrieval-only evidence for a separately authenticated answer run", async () => {
    const config = semanticQualityConfig(process.env);
    const result = await runSemanticQualityRetrieval(config.service);
    expect(result.outcomes).toHaveLength(200);
    expect(result.remoteCleanupVerified).toBe(true);
    const artifact = Object.freeze({
      binding: Object.freeze({
        corpusSha256: result.corpusSha256,
        embeddingProfileDigestSha256: config.embeddingProfileDigestSha256,
        embeddingProfileId: config.embeddingProfileId,
        releaseRevision: config.releaseRevision,
        serviceRevision: config.serviceRevision,
      }),
      claims: Object.freeze({
        finalAnswerQualityMeasured: false,
        productionQualityQualified: false,
        retrievalOnly: true,
      }),
      outcomes: result.outcomes,
      schemaVersion: "meeting_knowledge.semantic_quality_retrieval.v1",
      service: result.service,
    });
    process.stdout.write(
      `INFINITY_CONTEXT_SEMANTIC_QUALITY_RETRIEVAL_V1 ${JSON.stringify(artifact)}\n`,
    );
  }, 1_800_000);
});
function semanticQualityConfig(environment: NodeJS.ProcessEnv) {
  if (required(
    environment.INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE,
    "INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE",
  ) !== "YES_DELETE_ALL_TEST_DATA") {
    throw new Error("semantic quality retrieval requires explicit disposable-data consent");
  }
  const embeddingProfileId = required(
    environment.INFINITY_CONTEXT_SEMANTIC_E2E_EMBEDDING_PROFILE,
    "INFINITY_CONTEXT_SEMANTIC_E2E_EMBEDDING_PROFILE",
  );
  if (/(?:deterministic|mock|non-production)/iu.test(embeddingProfileId)) {
    throw new Error("semantic quality requires a non-mock embedding profile");
  }
  const url = new URL(required(
    environment.INFINITY_CONTEXT_SEMANTIC_E2E_URL,
    "INFINITY_CONTEXT_SEMANTIC_E2E_URL",
  ));
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username !== "" ||
    url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new Error("semantic quality URL must be an HTTP(S) service root");
  }
  return {
    embeddingProfileDigestSha256: required(
      environment.INFINITY_CONTEXT_SEMANTIC_E2E_EMBEDDING_PROFILE_DIGEST_SHA256,
      "INFINITY_CONTEXT_SEMANTIC_E2E_EMBEDDING_PROFILE_DIGEST_SHA256",
    ),
    embeddingProfileId,
    releaseRevision: revision(environment.MEETING_KNOWLEDGE_RELEASE_REVISION),
    service: {
      baseUrl: url.toString().replace(/\/$/u, ""),
      requestTimeoutMs: 30_000,
      ...(environment.INFINITY_CONTEXT_SEMANTIC_E2E_TOKEN === undefined
        ? {}
        : { token: environment.INFINITY_CONTEXT_SEMANTIC_E2E_TOKEN }),
    },
    serviceRevision: revision(environment.INFINITY_CONTEXT_SEMANTIC_E2E_SERVICE_REVISION),
  };
}

function required(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function revision(value: string | undefined): string {
  const normalized = required(value, "revision");
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error("semantic quality requires an exact git revision");
  }
  return normalized;
}
