import type { SummaryGenerationRequest } from "@discord-meeting/meeting-core";
import { describe, expect, it } from "vitest";

import {
  auditedSubscriptionRuntimePackageVersion,
  canonicalJsonSha256,
  meetingSummaryOutputSchemaName,
  meetingSummaryPolicyVersion,
  SubscriptionRuntimeSummaryAdapter,
  SubscriptionRuntimeTransportError,
  subscriptionRuntimeEngine,
  subscriptionRuntimeModel,
  subscriptionRuntimePurpose,
  subscriptionRuntimeReasoningEffort,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeHealthResult,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTransportPort,
} from "../src/index.js";

const launcherSha256 = "a".repeat(64);

const requestFixture: SummaryGenerationRequest = {
  idempotencyKey: "meeting-42:transcript-7:summary-policy-v1",
  meetingId: "meeting-42",
  transcript: {
    recordingId: "recording-42",
    transcriptId: "transcript-42",
    turns: [
      {
        endMs: 5_000,
        speakerId: "speaker-b",
        startMs: 2_000,
        text: "Я подготовлю релиз к пятнице.",
        turnId: "turn-b",
      },
      {
        endMs: 2_500,
        speakerId: "speaker-a",
        startMs: 0,
        text: "Решили выпустить первую версию в пятницу.",
        turnId: "turn-a",
      },
    ],
    version: 7,
  },
};

const validStructuredOutput: JsonObject = {
  actionItems: [
    {
      deadline: "к пятнице",
      evidenceTurnIds: ["turn-b"],
      ownerSpeakerId: "speaker-b",
      text: "Подготовить релиз к пятнице",
    },
  ],
  decisions: [
    {
      evidenceTurnIds: ["turn-a"],
      text: "Выпустить первую версию в пятницу",
    },
  ],
  openQuestions: [
    {
      evidenceTurnIds: ["turn-b"],
      text: "Кто проверит развертывание?",
    },
  ],
  overview: "Команда согласовала дату первой версии.",
  title: "План выпуска первой версии",
  topics: [
    {
      evidenceTurnIds: ["turn-a", "turn-b"],
      points: ["Дата выпуска", "Ответственный за подготовку"],
      title: "Подготовка выпуска",
    },
  ],
};

class FakeTransport implements SubscriptionRuntimeTransportPort {
  public request: SubscriptionRuntimeAgentTaskRequest | undefined;

  public constructor(
    private readonly responder: (
      request: SubscriptionRuntimeAgentTaskRequest,
    ) => SubscriptionRuntimeTaskResult | Promise<SubscriptionRuntimeTaskResult>,
    private readonly health: SubscriptionRuntimeHealthResult = healthyResult(),
  ) {}

  public async execute(
    request: SubscriptionRuntimeAgentTaskRequest,
  ): Promise<SubscriptionRuntimeTaskResult> {
    this.request = request;
    return this.responder(request);
  }

  public async checkHealth(): Promise<SubscriptionRuntimeHealthResult> {
    return this.health;
  }
}

describe("SubscriptionRuntimeSummaryAdapter", () => {
  it("builds the hardened subscription-only request and maps evidence output", async () => {
    const transport = new FakeTransport((request) =>
      completedResult(request, validStructuredOutput),
    );
    const adapter = createAdapter(transport);

    const result = await adapter.generate(requestFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toMatchObject({
      actionItems: [
        {
          deadline: "к пятнице",
          evidenceTurnIds: ["turn-b"],
          ownerSpeakerId: "speaker-b",
          text: "Подготовить релиз к пятнице",
        },
      ],
      decisions: [
        {
          evidenceTurnIds: ["turn-a"],
          text: "Выпустить первую версию в пятницу",
        },
      ],
      openQuestions: [
        {
          evidenceTurnIds: ["turn-b"],
          text: "Кто проверит развертывание?",
        },
      ],
      topics: [
        {
          evidenceTurnIds: ["turn-a", "turn-b"],
          points: ["Дата выпуска", "Ответственный за подготовку"],
          title: "Подготовка выпуска",
        },
      ],
      version: 1,
    });
    expect(result.value.summaryId).toMatch(/^summary-[0-9a-f]{32}$/u);
    expect(result.value.openQuestions[0]?.id).toMatch(/^question-[0-9a-f]{32}$/u);

    const captured = transport.request;
    expect(captured).toBeDefined();
    if (captured === undefined) {
      return;
    }
    expect(captured).toMatchObject({
      context: {
        application: "discord-meeting",
        purpose: subscriptionRuntimePurpose,
      },
      cwd: "/run/discord-meeting-subscription-runtime/workspace",
      protocolVersion: 1,
      task: {
        controls: {
          allowedTools: [],
          disableTools: true,
          executionProfile: "stateless-completion",
          interactive: false,
          maxTurns: 1,
          model: subscriptionRuntimeModel,
          outputKind: "structured_output",
          outputSchemaName: meetingSummaryOutputSchemaName,
          permissionMode: "read-only",
          reasoningEffort: subscriptionRuntimeReasoningEffort,
          responseFormat: "json",
        },
        kind: "structured-prompt",
        metadata: {
          policyVersion: meetingSummaryPolicyVersion,
          toolsDisabled: "true",
        },
      },
    });
    expect(captured.task.systemPrompt).toContain("untrusted quoted evidence");
    expect(captured.task.systemPrompt).toContain("exact deadline wording");
    expect(captured.task.systemPrompt).toContain("Consolidate related first-person commitments");
    expect(captured.task.systemPrompt).toContain("do not split one commitment into fragments");
    expect(captured.task.controls.outputSchema).toMatchObject({
      additionalProperties: false,
      type: "object",
    });
    expect(JSON.stringify(captured)).not.toMatch(/OPENAI_API_KEY|apiKey|auth\.json/iu);

    const prompt = JSON.parse(captured.task.prompt) as {
      outputSchema: { additionalProperties: boolean; type: string };
      transcript: { turns: readonly { turnId: string }[] };
    };
    expect(prompt.outputSchema).toEqual(captured.task.controls.outputSchema);
    expect(prompt.transcript.turns.map(({ turnId }) => turnId)).toEqual([
      "turn-a",
      "turn-b",
    ]);
  });

  it("fails closed when the launcher identity does not match", async () => {
    const transport = new FakeTransport((request) => ({
      ...completedResult(request, validStructuredOutput),
      executionAttestation: {
        ...completedResult(request, validStructuredOutput).executionAttestation,
        launcherSha256: "b".repeat(64),
      },
    }));

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toEqual({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_ATTESTATION",
        message:
          "Subscription runtime execution attestation did not match the request and result",
        retryable: false,
      },
      ok: false,
    });
  });

  it("fails closed when the attested result hash does not match", async () => {
    const transport = new FakeTransport((request) => ({
      ...completedResult(request, validStructuredOutput),
      executionAttestation: {
        ...completedResult(request, validStructuredOutput).executionAttestation,
        selectedOutputSha256: "0".repeat(64),
      },
    }));

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe(
        "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_ATTESTATION",
      );
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("rejects unknown evidence and action owners", async () => {
    const transport = new FakeTransport((request) =>
      completedResult(request, {
        ...validStructuredOutput,
        actionItems: [
          {
            deadline: null,
            evidenceTurnIds: ["turn-missing"],
            ownerSpeakerId: "speaker-missing",
            text: "Invented action",
          },
        ],
      }),
    );

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toEqual({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_EVIDENCE",
        message: "Summary references a transcript turn that does not exist",
        retryable: false,
      },
      ok: false,
    });
  });

  it("rejects unknown topic evidence before mapping provider output", async () => {
    const transport = new FakeTransport((request) =>
      completedResult(request, {
        ...validStructuredOutput,
        topics: [
          {
            evidenceTurnIds: ["turn-missing"],
            points: ["Придуманный тезис"],
            title: "Придуманная тема",
          },
        ],
      }),
    );

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toEqual({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_EVIDENCE",
        message: "Summary references a transcript turn that does not exist",
        retryable: false,
      },
      ok: false,
    });
  });

  it("rejects an open question that cites a nonexistent transcript turn", async () => {
    const transport = new FakeTransport((request) =>
      completedResult(request, {
        ...validStructuredOutput,
        openQuestions: [
          {
            evidenceTurnIds: ["turn-missing"],
            text: "Кто проверит развертывание?",
          },
        ],
      }),
    );

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toEqual({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_EVIDENCE",
        message: "Summary references a transcript turn that does not exist",
        retryable: false,
      },
      ok: false,
    });
  });

  it("rejects legacy string-only open questions", async () => {
    const transport = new FakeTransport((request) =>
      completedResult(request, {
        ...validStructuredOutput,
        openQuestions: ["Кто проверит развертывание?"],
      }),
    );

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toMatchObject({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_PROVIDER_RESPONSE",
        retryable: false,
      },
      ok: false,
    });
  });

  it("requires an explicit nullable deadline in every provider action item", async () => {
    const transport = new FakeTransport((request) =>
      completedResult(request, {
        ...validStructuredOutput,
        actionItems: [
          {
            evidenceTurnIds: ["turn-b"],
            ownerSpeakerId: "speaker-b",
            text: "Подготовить релиз",
          },
        ],
      }),
    );

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toMatchObject({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_PROVIDER_RESPONSE",
        retryable: false,
      },
      ok: false,
    });
  });

  it("rejects provider text that exceeds the bounded summary schema", async () => {
    const transport = new FakeTransport((request) =>
      completedResult(request, {
        ...validStructuredOutput,
        overview: "x".repeat(801),
      }),
    );

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toMatchObject({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_PROVIDER_RESPONSE",
        retryable: false,
      },
      ok: false,
    });
  });

  it("maps quota and reconnect failures to safe retryable failures", async () => {
    const transport = new FakeTransport(async () => ({
      failure: {
        code: "quota_limited",
        reconnectRequired: false,
        retryable: true,
        safeMessage: "secret-looking provider payload must not cross",
      },
      protocolVersion: 1,
      status: "failed",
    }));

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toEqual({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_QUOTA_LIMITED",
        message: "Subscription runtime account capacity is temporarily limited",
        retryable: true,
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret-looking");
  });

  it("rejects interactive provider results without retry", async () => {
    const transport = new FakeTransport(async () => ({
      protocolVersion: 1,
      status: "waiting_for_input",
    }));

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toEqual({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_INVALID_PROVIDER_RESPONSE",
        message: "Subscription runtime requested forbidden interactive input",
        retryable: false,
      },
      ok: false,
    });
  });

  it("maps transport errors without exposing their causes", async () => {
    const transport = new FakeTransport(async () => {
      throw new SubscriptionRuntimeTransportError("unavailable", true, {
        cause: new Error("credential payload"),
      });
    });

    const result = await createAdapter(transport).generate(requestFixture);

    expect(result).toEqual({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_TRANSPORT_UNAVAILABLE",
        message: "Subscription runtime summary transport failed",
        retryable: true,
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("credential payload");
  });

  it("requires the exact runtime and launcher identity in health checks", async () => {
    const healthyAdapter = createAdapter(
      new FakeTransport(async () => {
        throw new Error("not used");
      }),
    );
    await expect(healthyAdapter.checkHealth()).resolves.toEqual({
      code: "serving",
      runtimeVersion: auditedSubscriptionRuntimePackageVersion,
      status: "serving",
      verified: true,
    });

    const mismatchedAdapter = createAdapter(
      new FakeTransport(
        async () => {
          throw new Error("not used");
        },
        {
          ...healthyResult(),
          launcherSha256: "b".repeat(64),
        },
      ),
    );
    await expect(mismatchedAdapter.checkHealth()).resolves.toEqual({
      code: "identity_mismatch",
      runtimeVersion: auditedSubscriptionRuntimePackageVersion,
      status: "not_serving",
      verified: false,
    });
  });
});

function createAdapter(
  transport: SubscriptionRuntimeTransportPort,
): SubscriptionRuntimeSummaryAdapter {
  return new SubscriptionRuntimeSummaryAdapter(transport, {
    expectedLauncherSha256: launcherSha256,
    outputLanguage: "ru",
  });
}

function completedResult(
  request: SubscriptionRuntimeAgentTaskRequest,
  structuredOutput: JsonObject,
): Extract<SubscriptionRuntimeTaskResult, { readonly status: "completed" }> {
  return {
    executionAttestation: {
      canonicalRequestSha256: canonicalJsonSha256(request),
      launcherSha256,
      model: subscriptionRuntimeModel,
      provider: "codex",
      purpose: subscriptionRuntimePurpose,
      reasoningEffort: subscriptionRuntimeReasoningEffort,
      requestId: request.runId,
      runtimeEngine: subscriptionRuntimeEngine,
      runtimePackageVersion: auditedSubscriptionRuntimePackageVersion,
      schemaVersion: 1,
      selectedOutputKind: "structured_output",
      selectedOutputSha256: canonicalJsonSha256(structuredOutput),
    },
    protocolVersion: 1,
    status: "completed",
    structuredOutput,
  };
}

function healthyResult(): SubscriptionRuntimeHealthResult {
  return {
    launcherSha256,
    runtimeEngine: subscriptionRuntimeEngine,
    runtimeVersion: auditedSubscriptionRuntimePackageVersion,
    status: "serving",
    warningCodes: [],
  };
}
