import type {
  IncrementalSummaryGenerationRequest,
} from "@discord-meeting/meeting-core";
import { describe, expect, it } from "vitest";

import {
  auditedSubscriptionRuntimePackageVersion,
  canonicalJsonSha256,
  lunaLongContextPriceCard,
  lunaStandardPriceCard,
  SubscriptionRuntimeIncrementalSummaryAdapter,
  subscriptionRuntimeEngine,
  subscriptionRuntimeIncrementalModel,
  subscriptionRuntimeIncrementalPurpose,
  subscriptionRuntimeIncrementalReasoningEffort,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTelemetry,
  type SubscriptionRuntimeTransportPort,
  type SubscriptionRuntimeUsage,
} from "../src/index.js";

const launcherSha256 = "a".repeat(64);
const completeUsage: SubscriptionRuntimeUsage = {
  cacheWriteInputTokens: 100,
  cachedInputTokens: 200,
  inputTokens: 1_000,
  outputTokens: 300,
  reasoningOutputTokens: 100,
  totalTokens: 1_300,
};

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
  it("sends previous summary, new evidence, bounded context and known IDs with Luna medium", async () => {
    const transport = new FakeTransport((request) => completed(
      request,
      structuredOutput,
      completeUsage,
    ));

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
      ...completed(request, structuredOutput, completeUsage),
      executionAttestation: {
        ...completed(request, structuredOutput, completeUsage).executionAttestation,
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
    const transport = new FakeTransport((request) => completed(
      request,
      structuredOutput,
      completeUsage,
    ));

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
    if (!result.ok || result.value.usage === undefined) {
      throw new Error("Expected complete incremental generation usage");
    }
    expect(result.value.usage.runId).toMatch(/^incremental-summary-request-[0-9a-f]{32}$/u);
  });

  it("accepts a valid incremental summary when only partial Codex telemetry is available", async () => {
    const telemetry = codexJsonlTelemetry();
    const result = await createAdapter(
      new FakeTransport((request) => completed(
        request,
        structuredOutput,
        undefined,
        telemetry,
      )),
    ).generate(requestFixture);

    expect(result).toMatchObject({
      ok: true,
      value: {
        summary: { revision: 2 },
        telemetry: {
          source: "codex_exec_jsonl",
          cacheWriteInputTokens: { availability: "unavailable" },
          totalTokens: {
            availability: "derived",
            derivedFrom: ["inputTokens", "outputTokens"],
            value: 1_300,
          },
          cost: {
            minimumUsd: 0.000_524,
            maximumUsd: 0.000_564,
            priceCardId: lunaStandardPriceCard.id,
          },
        },
      },
    });
    expect(result.ok && result.value.usage).toBeUndefined();
  });

  it("fails closed when a completed result has no telemetry at all", async () => {
    const result = await createAdapter(
      new FakeTransport((request) => completed(request, structuredOutput)),
    ).generate(requestFixture);

    expect(result).toMatchObject({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_TELEMETRY_UNAVAILABLE",
        retryable: false,
      },
      ok: false,
    });
  });

  it("calculates the documented long-context API-equivalent cost", async () => {
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
          apiEquivalentCostUsd: 0.110_600_4,
          inputTokens: 272_001,
          priceCard: lunaLongContextPriceCard.id,
        },
      },
    });
  });

  it("preserves complete real usage when the provider task fails after consuming tokens", async () => {
    const result = await createAdapter(
      new FakeTransport(() => failed(completeUsage)),
    ).generate(requestFixture);

    expect(result).toMatchObject({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_TASK_TIMEOUT",
        retryable: true,
      },
      ok: false,
      usage: {
        apiEquivalentCostUsd: 0.000_529,
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        inputTokens: 1_000,
        model: "gpt-5.6-luna",
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    });
    if (result.ok || result.usage === undefined) {
      throw new Error("Expected rejected incremental generation usage");
    }
    expect(result.usage.runId).toMatch(/^incremental-summary-request-[0-9a-f]{32}$/u);
  });

  it("preserves partial Codex telemetry when the provider task fails after consuming tokens", async () => {
    const result = await createAdapter(
      new FakeTransport(() => failed(undefined, codexJsonlTelemetry())),
    ).generate(requestFixture);

    expect(result).toMatchObject({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_TASK_TIMEOUT",
        retryable: true,
      },
      ok: false,
      telemetry: {
        cacheWriteInputTokens: { availability: "unavailable" },
        totalTokens: {
          availability: "derived",
          derivedFrom: ["inputTokens", "outputTokens"],
          value: 1_300,
        },
      },
    });
    expect(result.ok || result.usage).toBeUndefined();
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
  telemetry?: SubscriptionRuntimeTelemetry,
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
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function failed(
  usage?: SubscriptionRuntimeUsage,
  telemetry?: SubscriptionRuntimeTelemetry,
): Extract<SubscriptionRuntimeTaskResult, { readonly status: "failed" }> {
  return {
    failure: {
      code: "task_timeout",
      reconnectRequired: false,
      retryable: true,
      safeMessage: "Subscription runtime task timed out",
    },
    protocolVersion: 1,
    status: "failed",
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function codexJsonlTelemetry(): SubscriptionRuntimeTelemetry {
  return {
    source: "codex_exec_jsonl",
    cacheWriteInputTokens: { availability: "unavailable" },
    cachedInputTokens: { availability: "measured", value: 200 },
    inputTokens: { availability: "measured", value: 1_000 },
    outputTokens: { availability: "measured", value: 300 },
    reasoningOutputTokens: { availability: "measured", value: 100 },
    totalTokens: {
      availability: "derived",
      derivedFrom: ["inputTokens", "outputTokens"],
      value: 1_300,
    },
  };
}
