import {
  buildSubscriptionRuntimeIncrementalSummaryRequest,
  buildSubscriptionRuntimeSummaryRequest,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";
import type { Logger } from "@discord-meeting/observability-adapter";
import { describe, expect, it, vi } from "vitest";

import { InstrumentedSubscriptionRuntimeTransport } from "../src/adapters/outbound/instrumented-subscription-runtime-transport.js";

type CompletedRuntimeTaskResult = Extract<
  SubscriptionRuntimeTaskResult,
  { readonly status: "completed" }
>;

function observability() {
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => {}),
    info: vi.fn(),
    warn: vi.fn(),
  } satisfies Logger;
  return logger;
}

function finalRequest(): SubscriptionRuntimeAgentTaskRequest {
  return buildSubscriptionRuntimeSummaryRequest(
    {
      idempotencyKey: "final-summary-once",
      meetingId: "meeting-1",
      transcript: {
        recordingId: "recording-1",
        transcriptId: "transcript-1",
        turns: [{
          endMs: 2_000,
          speakerId: "speaker-1",
          startMs: 0,
          text: "DO_NOT_LOG_THIS_EVIDENCE",
          turnId: "turn-1",
        }],
        version: 1,
      },
    },
    {
      isolatedCwd: "/runtime/workspace",
      maxOutputTokens: 2_048,
      maxPromptBytes: 1_048_576,
      timeoutMs: 600_000,
    },
  );
}

function incrementalRequest(): SubscriptionRuntimeAgentTaskRequest {
  return buildSubscriptionRuntimeIncrementalSummaryRequest(
    {
      idempotencyKey: "incremental-summary-once",
      knownSpeakerIds: ["speaker-1"],
      knownTurnIds: ["turn-1"],
      meetingId: "meeting-2",
      newTurns: [{
        endMs: 2_000,
        speakerId: "speaker-1",
        startMs: 0,
        text: "DO_NOT_LOG_THIS_EVIDENCE",
        turnId: "turn-1",
      }],
      previousSummary: null,
      recentContextTurns: [],
      revision: 1,
      throughTurnCount: 1,
    },
    {
      isolatedCwd: "/runtime/workspace",
      maxOutputTokens: 2_048,
      maxPromptBytes: 1_048_576,
      maxRecentContextTurns: 256,
      timeoutMs: 30_000,
    },
  );
}

function completedResult(): CompletedRuntimeTaskResult {
  return {
    executionAttestation: {
      canonicalRequestSha256: "a".repeat(64),
      launcherSha256: "b".repeat(64),
      model: "gpt-5.6-sol",
      provider: "codex",
      purpose: "discord_meeting.summary.generate",
      reasoningEffort: "medium",
      requestId: "runtime-request-1",
      runtimeEngine: "subscription-runtime-app-server",
      runtimePackageVersion: "0.1.0-main.27",
      schemaVersion: 1,
      selectedOutputKind: "structured_output",
      selectedOutputSha256: "c".repeat(64),
    },
    protocolVersion: 1,
    status: "completed",
    structuredOutput: {
      ignored: "DO_NOT_LOG_THIS_OUTPUT",
    },
    telemetry: {
      cacheWriteInputTokens: { availability: "unavailable" },
      cachedInputTokens: { availability: "measured", value: 20 },
      cost: {
        maximumUsd: 0.004,
        minimumUsd: 0.003,
        priceCardId: "sol-standard",
        priceCardSource: "internal-price-card",
      },
      inputTokens: { availability: "measured", value: 100 },
      outputTokens: { availability: "measured", value: 30 },
      reasoningOutputTokens: { availability: "measured", value: 10 },
      source: "runtime_bridge",
      totalTokens: {
        availability: "derived",
        derivedFrom: ["inputTokens", "outputTokens"],
        value: 130,
      },
    },
  };
}

function allFieldNames(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) => [
    key,
    ...allFieldNames(nested),
  ]);
}

describe("instrumented subscription runtime transport", () => {
  it("records a completed Sol call with safe partial provider units and cost", async () => {
    const logger = observability();
    const result = completedResult();
    const delegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => result),
    } satisfies SubscriptionRuntimeTransportPort;
    const now = vi.fn()
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_250);
    const subject = new InstrumentedSubscriptionRuntimeTransport(
      delegate,
      logger,
      now,
    );
    const request = finalRequest();

    await expect(subject.execute(request)).resolves.toBe(result);
    expect(delegate.execute).toHaveBeenCalledWith(request);
    expect(now).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      "Subscription runtime task completed",
      {
        durationMs: 250,
        maxOutputUnits: 2_048,
        meetingId: "meeting-1",
        model: "gpt-5.6-sol",
        outputSchemaName: "discord_meeting_summary_v4",
        policyVersion: "meeting-summary.subscription-runtime.v8",
        providerCost: {
          availability: "bounded",
          maximumUsd: 0.004,
          minimumUsd: 0.003,
          priceCardId: "sol-standard",
          priceCardSource: "internal-price-card",
        },
        providerUnits: {
          cacheWriteInput: { availability: "unavailable" },
          cachedInput: { availability: "measured", value: 20 },
          input: { availability: "measured", value: 100 },
          output: { availability: "measured", value: 30 },
          reasoningOutput: { availability: "measured", value: 10 },
          total: {
            availability: "derived",
            derivedFrom: ["inputTokens", "outputTokens"],
            value: 130,
          },
        },
        purpose: "discord_meeting.summary.generate",
        reasoningEffort: "medium",
        requestCharacterCount: request.task.prompt.length,
        runId: request.runId,
        status: "completed",
        systemInstructionCharacterCount: request.task.systemPrompt.length,
        timeoutMs: 600_000,
        usageCompleteness: "partial",
      },
    );
    const fields = logger.info.mock.calls[0]?.[1] as unknown;
    expect(JSON.stringify(fields)).not.toContain(request.task.prompt);
    expect(JSON.stringify(fields)).not.toContain(request.task.systemPrompt);
    expect(JSON.stringify(fields)).not.toContain("DO_NOT_LOG_THIS_OUTPUT");
    expect(allFieldNames(fields)).not.toContainEqual(
      expect.stringMatching(/prompt|transcript|audio|token/iu),
    );
  });

  it("records a failed result with unavailable provider units", async () => {
    const logger = observability();
    const result = {
      failure: {
        code: "task_timeout",
        reconnectRequired: false,
        retryable: true,
        safeMessage: "runtime timed out",
      },
      protocolVersion: 1,
      status: "failed",
    } as const satisfies SubscriptionRuntimeTaskResult;
    const delegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => result),
    } satisfies SubscriptionRuntimeTransportPort;
    const now = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(275);
    const subject = new InstrumentedSubscriptionRuntimeTransport(
      delegate,
      logger,
      now,
    );

    await expect(subject.execute(finalRequest())).resolves.toBe(result);
    expect(logger.info).toHaveBeenCalledWith(
      "Subscription runtime task completed",
      expect.objectContaining({
        durationMs: 175,
        failureCode: "task_timeout",
        providerCost: { availability: "unavailable" },
        retryable: true,
        status: "failed",
        usageCompleteness: "unavailable",
      }),
    );
    const fields = logger.info.mock.calls[0]?.[1] as {
      readonly providerUnits: Record<string, { readonly availability: string }>;
    };
    expect(Object.values(fields.providerUnits)).toEqual([
      { availability: "unavailable" },
      { availability: "unavailable" },
      { availability: "unavailable" },
      { availability: "unavailable" },
      { availability: "unavailable" },
      { availability: "unavailable" },
    ]);
  });

  it("prefers complete usage units while retaining an exact telemetry cost", async () => {
    const logger = observability();
    const base = completedResult();
    if (base.telemetry === undefined || base.telemetry.cost === undefined) {
      throw new Error("completed result must have telemetry cost");
    }
    const result = {
      ...base,
      telemetry: {
        ...base.telemetry,
        cost: {
          ...base.telemetry.cost,
          exactUsd: 0.0035,
        },
      },
      usage: {
        cacheWriteInputTokens: 11,
        cachedInputTokens: 22,
        inputTokens: 300,
        outputTokens: 90,
        reasoningOutputTokens: 40,
        totalTokens: 390,
      },
    } as const satisfies SubscriptionRuntimeTaskResult;
    const delegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => result),
    } satisfies SubscriptionRuntimeTransportPort;
    const subject = new InstrumentedSubscriptionRuntimeTransport(
      delegate,
      logger,
      () => 1_000,
    );

    await expect(subject.execute(finalRequest())).resolves.toBe(result);
    expect(logger.info).toHaveBeenCalledWith(
      "Subscription runtime task completed",
      expect.objectContaining({
        providerCost: {
          availability: "exact",
          exactUsd: 0.0035,
          maximumUsd: 0.004,
          minimumUsd: 0.003,
          priceCardId: "sol-standard",
          priceCardSource: "internal-price-card",
        },
        providerUnits: {
          cacheWriteInput: { availability: "measured", value: 11 },
          cachedInput: { availability: "measured", value: 22 },
          input: { availability: "measured", value: 300 },
          output: { availability: "measured", value: 90 },
          reasoningOutput: { availability: "measured", value: 40 },
          total: { availability: "measured", value: 390 },
        },
        usageCompleteness: "complete",
      }),
    );
  });

  it("records waiting Luna calls with numeric queryable revision metadata", async () => {
    const logger = observability();
    const result = {
      protocolVersion: 1,
      status: "waiting_for_input",
    } as const satisfies SubscriptionRuntimeTaskResult;
    const delegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => result),
    } satisfies SubscriptionRuntimeTransportPort;
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_040);
    const subject = new InstrumentedSubscriptionRuntimeTransport(
      delegate,
      logger,
      now,
    );

    await expect(subject.execute(incrementalRequest())).resolves.toBe(result);
    expect(logger.info).toHaveBeenCalledWith(
      "Subscription runtime task completed",
      expect.objectContaining({
        durationMs: 40,
        model: "gpt-5.6-luna",
        outputSchemaName: "discord_meeting_incremental_summary_v1",
        policyVersion: "meeting-summary.incremental.subscription-runtime.v4",
        status: "waiting_for_input",
        summaryRevision: 1,
        throughTurnCount: 1,
      }),
    );
  });
});

describe("instrumented subscription runtime safety", () => {
  it("omits invalid revision metadata rather than logging unqueryable values", async () => {
    const logger = observability();
    const result = {
      protocolVersion: 1,
      status: "waiting_for_input",
    } as const satisfies SubscriptionRuntimeTaskResult;
    const request = incrementalRequest();
    const invalidRequest = {
      ...request,
      context: {
        ...request.context,
        metadata: {
          ...request.context.metadata,
          summaryRevision: "seven",
          throughTurnCount: "12.5",
        },
      },
    } as SubscriptionRuntimeAgentTaskRequest;
    const delegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => result),
    } satisfies SubscriptionRuntimeTransportPort;
    const subject = new InstrumentedSubscriptionRuntimeTransport(
      delegate,
      logger,
      () => 1_000,
    );

    await expect(subject.execute(invalidRequest)).resolves.toBe(result);
    const fields = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields).not.toHaveProperty("summaryRevision");
    expect(fields).not.toHaveProperty("throughTurnCount");
  });

  it("keeps successful results intact when clock reads throw before or after delegation", async () => {
    const result = {
      protocolVersion: 1,
      status: "waiting_for_input",
    } as const satisfies SubscriptionRuntimeTaskResult;
    const beforeLogger = observability();
    const beforeDelegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => result),
    } satisfies SubscriptionRuntimeTransportPort;
    const beforeClock = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("clock unavailable");
      })
      .mockReturnValueOnce(1_000);
    const beforeSubject = new InstrumentedSubscriptionRuntimeTransport(
      beforeDelegate,
      beforeLogger,
      beforeClock,
    );

    await expect(beforeSubject.execute(finalRequest())).resolves.toBe(result);
    expect(beforeDelegate.execute).toHaveBeenCalledOnce();
    const beforeFields = beforeLogger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(beforeFields).not.toHaveProperty("durationMs");

    const afterLogger = observability();
    const afterDelegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => result),
    } satisfies SubscriptionRuntimeTransportPort;
    const afterClock = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockImplementationOnce(() => {
        throw new Error("clock unavailable");
      });
    const afterSubject = new InstrumentedSubscriptionRuntimeTransport(
      afterDelegate,
      afterLogger,
      afterClock,
    );

    await expect(afterSubject.execute(finalRequest())).resolves.toBe(result);
    expect(afterDelegate.execute).toHaveBeenCalledOnce();
    const afterFields = afterLogger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(afterFields).not.toHaveProperty("durationMs");
  });

  it("omits non-finite durations and clamps backwards clock values", async () => {
    const result = {
      protocolVersion: 1,
      status: "waiting_for_input",
    } as const satisfies SubscriptionRuntimeTaskResult;
    const unavailableLogger = observability();
    const unavailableDelegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => result),
    } satisfies SubscriptionRuntimeTransportPort;
    const unavailableSubject = new InstrumentedSubscriptionRuntimeTransport(
      unavailableDelegate,
      unavailableLogger,
      vi.fn()
        .mockReturnValueOnce(Number.NaN)
        .mockReturnValueOnce(1_000),
    );

    await expect(unavailableSubject.execute(finalRequest())).resolves.toBe(result);
    const unavailableFields = unavailableLogger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(unavailableFields).not.toHaveProperty("durationMs");

    const backwardsLogger = observability();
    const backwardsDelegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => result),
    } satisfies SubscriptionRuntimeTransportPort;
    const backwardsSubject = new InstrumentedSubscriptionRuntimeTransport(
      backwardsDelegate,
      backwardsLogger,
      vi.fn()
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(500),
    );

    await expect(backwardsSubject.execute(finalRequest())).resolves.toBe(result);
    expect(backwardsLogger.info).toHaveBeenCalledWith(
      "Subscription runtime task completed",
      expect.objectContaining({ durationMs: 0 }),
    );
  });

  it("warns and rethrows the original transport exception when the clock and warning delivery fail", async () => {
    const logger = observability();
    logger.warn.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const transportError = new Error("provider disconnected");
    transportError.name = "Bearer secret";
    const delegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => Promise.reject(transportError)),
    } satisfies SubscriptionRuntimeTransportPort;
    const now = vi.fn()
      .mockReturnValueOnce(500)
      .mockImplementationOnce(() => {
        throw new Error("clock unavailable");
      });
    const subject = new InstrumentedSubscriptionRuntimeTransport(
      delegate,
      logger,
      now,
    );

    await expect(subject.execute(finalRequest())).rejects.toBe(transportError);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Subscription runtime transport failed",
      expect.objectContaining({
        errorName: "Error",
        status: "exception",
      }),
    );
    const fields = logger.warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields).not.toHaveProperty("durationMs");
  });

  it("uses UnknownError for non-Error transport throws", async () => {
    const logger = observability();
    const transportError = { name: "Bearer secret" };
    const delegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => Promise.reject(transportError)),
    } satisfies SubscriptionRuntimeTransportPort;
    const subject = new InstrumentedSubscriptionRuntimeTransport(
      delegate,
      logger,
      () => 1_000,
    );

    await expect(subject.execute(finalRequest())).rejects.toBe(transportError);
    expect(logger.warn).toHaveBeenCalledWith(
      "Subscription runtime transport failed",
      expect.objectContaining({ errorName: "UnknownError" }),
    );
  });

  it("does not let a failed info write reject an otherwise valid provider result", async () => {
    const logger = observability();
    logger.info.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const result = {
      protocolVersion: 1,
      status: "waiting_for_input",
    } as const satisfies SubscriptionRuntimeTaskResult;
    const delegate = {
      checkHealth: vi.fn(),
      execute: vi.fn(async () => result),
    } satisfies SubscriptionRuntimeTransportPort;
    const subject = new InstrumentedSubscriptionRuntimeTransport(
      delegate,
      logger,
      () => 1_000,
    );

    await expect(subject.execute(finalRequest())).resolves.toBe(result);
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it("delegates health checks unchanged without clock or log activity", async () => {
    const logger = observability();
    const health = {
      runtimeEngine: "subscription-runtime-app-server",
      runtimeVersion: "0.1.0-main.27",
      status: "serving",
      warningCodes: [],
    } as const;
    const delegate = {
      checkHealth: vi.fn(async () => health),
      execute: vi.fn(),
    } satisfies SubscriptionRuntimeTransportPort;
    const now = vi.fn();
    const subject = new InstrumentedSubscriptionRuntimeTransport(
      delegate,
      logger,
      now,
    );

    await expect(subject.checkHealth()).resolves.toBe(health);
    expect(delegate.checkHealth).toHaveBeenCalledOnce();
    expect(now).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
