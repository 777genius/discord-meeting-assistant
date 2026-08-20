import { describe, expect, it } from "vitest";

import { frozenSemanticQualityCorpus } from "./semantic-quality-corpus.js";
import {
  immutableCheckoutProvenance,
  runAuthenticatedAnswerEvaluation,
  type SubscriptionAnswerTransport,
} from "./semantic-quality-answer-runner.js";
import { runSemanticQualityRetrieval } from "./semantic-quality-retrieval-helper.js";

const enabled = process.env.INFINITY_CONTEXT_SEMANTIC_QUALITY_E2E === "1";
const liveDescribe = enabled ? describe : describe.skip;

liveDescribe("Infinity Context frozen semantic quality retrieval", () => {
  it("emits retrieval-only evidence for a separately authenticated answer run", async () => {
    const config = semanticQualityConfig(process.env);
    const corpus = frozenSemanticQualityCorpus();
    const result = await runSemanticQualityRetrieval(config.service);
    expect(result.outcomes).toHaveLength(200);
    expect(result.remoteCleanupVerified).toBe(true);
    const artifact = Object.freeze({
      binding: Object.freeze({
        corpusSha256: result.corpusSha256,
        embeddingProfileDigestSha256: result.service.embeddingProfileDigestSha256,
        embeddingProfileId: result.service.embeddingProfileId,
        serviceRevision: result.service.revision,
      }),
      claims: Object.freeze({
        finalAnswerQualityMeasured: false,
        productionQualityQualified: false,
        retrievalOnly: true,
      }),
      outcomes: result.outcomes,
      profile: corpus.profile,
      schemaVersion: "meeting_knowledge.semantic_quality_retrieval.v1",
      service: result.service,
    });
    process.stdout.write(
      `INFINITY_CONTEXT_SEMANTIC_QUALITY_RETRIEVAL_V1 ${JSON.stringify(artifact)}\n`,
    );
    if (process.env.INFINITY_CONTEXT_SEMANTIC_ANSWER_E2E === "1") {
      const transport = await injectedTransport(process.env);
      const answerRun = await runAuthenticatedAnswerEvaluation({
        build: immutableCheckoutProvenance(repositoryRoot()),
        corpus,
        observedAt: new Date().toISOString(),
        repetition: positiveInteger(process.env.INFINITY_CONTEXT_SEMANTIC_E2E_REPETITION),
        retrieval: result,
        runId: required(process.env.INFINITY_CONTEXT_SEMANTIC_E2E_RUN_ID,
          "INFINITY_CONTEXT_SEMANTIC_E2E_RUN_ID"),
        transport,
      });
      process.stdout.write(
        `INFINITY_CONTEXT_SEMANTIC_QUALITY_ANSWER_V1 ${JSON.stringify(Object.freeze({
          ...answerRun,
          claims: Object.freeze({ independentlyAdjudicated: false,
            productionQualityQualified: false }),
          schemaVersion: "meeting_knowledge.semantic_quality_answer_pending.v1",
        }))}\n`,
      );
    }
  }, 1_800_000);
});
function semanticQualityConfig(environment: NodeJS.ProcessEnv) {
  if (required(
    environment.INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE,
    "INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE",
  ) !== "YES_DELETE_ALL_TEST_DATA") {
    throw new Error("semantic quality retrieval requires explicit disposable-data consent");
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
    service: {
      baseUrl: url.toString().replace(/\/$/u, ""),
      requestTimeoutMs: 30_000,
      ...(environment.INFINITY_CONTEXT_SEMANTIC_E2E_TOKEN === undefined
        ? {}
        : { token: environment.INFINITY_CONTEXT_SEMANTIC_E2E_TOKEN }),
    },
  };
}

function required(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

async function injectedTransport(environment: NodeJS.ProcessEnv): Promise<SubscriptionAnswerTransport> {
  const path = required(environment.INFINITY_CONTEXT_SEMANTIC_ANSWER_TRANSPORT_MODULE,
    "INFINITY_CONTEXT_SEMANTIC_ANSWER_TRANSPORT_MODULE");
  const module = await import(path) as { readonly default?: unknown };
  const transport = module.default as Partial<SubscriptionAnswerTransport> | undefined;
  if (transport === undefined || typeof transport.execute !== "function") {
    throw new Error("injected answer transport must export a SubscriptionAnswerTransport");
  }
  return transport as SubscriptionAnswerTransport;
}

function positiveInteger(value: string | undefined): number {
  const parsed = Number.parseInt(required(value, "INFINITY_CONTEXT_SEMANTIC_E2E_REPETITION"), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {throw new Error("repetition must be positive");}
  return parsed;
}

function repositoryRoot(): string {
  return new URL("../../../", import.meta.url).pathname;
}
