import type {
  IncrementalSummaryGenerationRequest,
} from "@discord-meeting/meeting-core";
import { describe, expect, it } from "vitest";

import {
  auditedSubscriptionRuntimePackageVersion,
  canonicalJsonSha256,
  lunaStandardPriceCard,
  SubscriptionRuntimeIncrementalSummaryAdapter,
  subscriptionRuntimeEngine,
  subscriptionRuntimeIncrementalModel,
  subscriptionRuntimeIncrementalPurpose,
  subscriptionRuntimeIncrementalReasoningEffort,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTransportPort,
  type SubscriptionRuntimeUsage,
} from "../src/index.js";

const launcherSha256 = "a".repeat(64);

const requestFixture: IncrementalSummaryGenerationRequest = {
  idempotencyKey: "live-summary-revision-2",
  knownSpeakerIds: ["speaker-a", "speaker-b"],
  knownTurnIds: ["turn-1", "turn-2", "turn-3"],
  meetingId: "meeting-live-1",
  newTurns: [
    {
      endMs: 6_000,
      speakerId: "speaker-b",
      startMs: 4_000,
      text: "Я подготовлю релиз к пятнице.",
      turnId: "turn-3",
    },
  ],
  previousSummary: {
    actionItems: [],
    decisions: [
      {
        decisionId: "decision-1",
        evidenceTurnIds: ["turn-1"],
        text: "Выпустить релиз",
      },
    ],
    openQuestions: [],
    overview: "Команда обсуждает релиз.",
    revision: 1,
    title: "Релиз",
    topics: [
      {
        evidenceTurnIds: ["turn-1"],
        points: ["Релиз согласован"],
        title: "План",
      },
    ],
  },
  recentContextTurns: [
    {
      endMs: 4_000,
      speakerId: "speaker-a",
      startMs: 2_000,
      text: "Нужно определить ответственного.",
      turnId: "turn-2",
    },
  ],
  revision: 2,
  throughTurnCount: 3,
};

const structuredOutput: JsonObject = {
  actionItems: [
    {
      deadline: "к пятнице",
      evidenceTurnIds: ["turn-3"],
      ownerSpeakerId: "speaker-b",
      text: "Подготовить релиз",
    },
  ],
  decisions: [
    { evidenceTurnIds: ["turn-1"], text: "Выпустить релиз" },
  ],
  openQuestions: [],
  overview: "Команда согласовала релиз и ответственного.",
  title: "Релиз",
  topics: [
    {
      evidenceTurnIds: ["turn-1", "turn-3"],
      points: ["Релиз готовится к пятнице"],
      title: "План",
    },
  ],
};

class FakeTransport implements SubscriptionRuntimeTransportPort {
  public request: SubscriptionRuntimeAgentTaskRequest | undefined;

  public constructor(
    private readonly responder: (
      request: SubscriptionRuntimeAgentTaskRequest,
    ) => SubscriptionRuntimeTaskResult,
  ) {}

  public async execute(
    request: SubscriptionRuntimeAgentTaskRequest,
  ): Promise<SubscriptionRuntimeTaskResult> {
    this.request = request;
    return this.responder(request);
  }

  public async checkHealth() {
    return {
      launcherSha256,
      runtimeEngine: subscriptionRuntimeEngine,
      runtimeVersion: auditedSubscriptionRuntimePackageVersion,
      status: "serving" as const,
      warningCodes: [],
    };
  }
}

describe("SubscriptionRuntimeIncrementalSummaryAdapter", () => {
  it("sends previous summary, new evidence, bounded context and known IDs with Luna low", async () => {
    const transport = new FakeTransport((request) => completed(request));

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toMatchObject({
      ok: true,
      value: {
        summary: {
          revision: 2,
          actionItems: [
            {
              deadline: "к пятнице",
              evidenceTurnIds: ["turn-3"],
              ownerSpeakerId: "speaker-b",
            },
          ],
        },
      },
    });
    const captured = transport.request;
    expect(captured).toBeDefined();
    if (captured === undefined) {
      return;
    }
    expect(captured).toMatchObject({
      context: { purpose: subscriptionRuntimeIncrementalPurpose },
      task: {
        controls: {
          model: subscriptionRuntimeIncrementalModel,
          reasoningEffort: subscriptionRuntimeIncrementalReasoningEffort,
        },
        metadata: {
          model: subscriptionRuntimeIncrementalModel,
          reasoningEffort: subscriptionRuntimeIncrementalReasoningEffort,
        },
      },
    });
    const prompt = JSON.parse(captured.task.prompt) as Record<string, unknown>;
    expect(prompt).toMatchObject({
      knownSpeakerIds: ["speaker-a", "speaker-b"],
      knownTurnIds: ["turn-1", "turn-2", "turn-3"],
      newFinalizedTurns: [{ turnId: "turn-3" }],
      previousSummary: { revision: 1 },
      recentContextTurns: [{ turnId: "turn-2" }],
      revision: 2,
      throughTurnCount: 3,
    });
    expect(captured.task.systemPrompt).toContain("previous summary is an editable draft");
    expect(captured.task.systemPrompt).toContain("untrusted quoted evidence");
  });

  it("rejects an attested profile mismatch", async () => {
    const transport = new FakeTransport((request) => ({
      ...completed(request),
      executionAttestation: {
        ...completed(request).executionAttestation,
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      },
    }));

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toMatchObject({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_ATTESTATION",
        retryable: false,
      },
      ok: false,
    });
  });

  it("rejects output evidence outside all known finalized turns", async () => {
    const usage: SubscriptionRuntimeUsage = {
      cacheWriteInputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 100,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 120,
    };
    const transport = new FakeTransport((request) => completed(
      request,
      {
        ...structuredOutput,
        decisions: [{ evidenceTurnIds: ["turn-unknown"], text: "Invented" }],
      },
      usage,
    ));

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toMatchObject({
      failure: { code: "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_EVIDENCE" },
      ok: false,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it("maps complete real usage to the official short-context API-equivalent card", async () => {
    const usage: SubscriptionRuntimeUsage = {
      cacheWriteInputTokens: 100,
      cachedInputTokens: 200,
      inputTokens: 1_000,
      outputTokens: 300,
      reasoningOutputTokens: 100,
      totalTokens: 1_300,
    };
    const transport = new FakeTransport((request) => completed(request, structuredOutput, usage));

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toMatchObject({
      ok: true,
      value: {
        usage: {
          apiEquivalentCostUsd: 0.000_529,
          cacheWriteInputTokens: 100,
          cachedInputTokens: 200,
          inputTokens: 1_000,
          model: "gpt-5.6-luna",
          outputTokens: 300,
          priceCard: lunaStandardPriceCard.id,
          reasoningOutputTokens: 100,
          totalTokens: 1_300,
        },
      },
    });
  });

  it("does not fabricate usage when the runtime omits it", async () => {
    const result = await createAdapter(
      new FakeTransport((request) => completed(request)),
    ).generate(requestFixture);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty("usage");
    }
  });

  it("keeps real long-context tokens but leaves API-equivalent cost unavailable", async () => {
    const usage: SubscriptionRuntimeUsage = {
      cacheWriteInputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 272_001,
      outputTokens: 1_000,
      reasoningOutputTokens: 500,
      totalTokens: 273_001,
    };
    const result = await createAdapter(
      new FakeTransport((request) => completed(request, structuredOutput, usage)),
    ).generate(requestFixture);

    expect(result).toMatchObject({
      ok: true,
      value: {
        usage: {
          apiEquivalentCostUsd: null,
          inputTokens: 272_001,
          priceCard: `${lunaStandardPriceCard.id}:context-over-272000-unpriced`,
        },
      },
    });
  });
});

function createAdapter(
  transport: SubscriptionRuntimeTransportPort,
): SubscriptionRuntimeIncrementalSummaryAdapter {
  return new SubscriptionRuntimeIncrementalSummaryAdapter(transport, {
    expectedLauncherSha256: launcherSha256,
    outputLanguage: "ru",
  });
}

function completed(
  request: SubscriptionRuntimeAgentTaskRequest,
  output: JsonObject = structuredOutput,
  usage?: SubscriptionRuntimeUsage,
): Extract<SubscriptionRuntimeTaskResult, { readonly status: "completed" }> {
  return {
    executionAttestation: {
      canonicalRequestSha256: canonicalJsonSha256(request),
      launcherSha256,
      model: subscriptionRuntimeIncrementalModel,
      provider: "codex",
      purpose: subscriptionRuntimeIncrementalPurpose,
      reasoningEffort: subscriptionRuntimeIncrementalReasoningEffort,
      requestId: request.runId,
      runtimeEngine: subscriptionRuntimeEngine,
      runtimePackageVersion: auditedSubscriptionRuntimePackageVersion,
      schemaVersion: 1,
      selectedOutputKind: "structured_output",
      selectedOutputSha256: canonicalJsonSha256(output),
    },
    protocolVersion: 1,
    status: "completed",
    structuredOutput: output,
    ...(usage === undefined ? {} : { usage }),
  };
}
