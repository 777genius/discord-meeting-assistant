import {
  buildSubscriptionRuntimeIncrementalSummaryRequest,
  buildSubscriptionRuntimeSummaryRequest,
  canonicalJsonSha256,
} from "@discord-meeting/subscription-runtime-adapter";
import { describe, expect, it } from "vitest";

import {
  fromGrpcTaskResponse,
  toGrpcTaskRequest,
} from "../src/subscription-runtime-grpc-transport.js";

const runtimeRequest = buildSubscriptionRuntimeSummaryRequest(
  {
    idempotencyKey: "summary-once",
    meetingId: "meeting-1",
    transcript: {
      recordingId: "recording-1",
      transcriptId: "transcript-1",
      turns: [
        {
          endMs: 1_000,
          speakerId: "1533227577286852649",
          startMs: 0,
          text: "Нужно выпустить релиз.",
          turnId: "turn-1",
        },
      ],
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

const incrementalRuntimeRequest = buildSubscriptionRuntimeIncrementalSummaryRequest(
  {
    idempotencyKey: "incremental-once",
    knownSpeakerIds: ["1533227577286852649"],
    knownTurnIds: ["turn-1"],
    meetingId: "meeting-1",
    newTurns: [
      {
        endMs: 1_000,
        speakerId: "1533227577286852649",
        startMs: 0,
        text: "Нужно выпустить релиз.",
        turnId: "turn-1",
      },
    ],
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
    timeoutMs: 600_000,
  },
);

describe("subscription runtime gRPC transport mapping", () => {
  it("maps the consumer-owned request to the audited AgentRuntime v1 contract", () => {
    const request = toGrpcTaskRequest(runtimeRequest);

    expect(request.provider).toBe("AGENT_RUNTIME_PROVIDER_CODEX");
    expect(request.purpose).toBe("discord_meeting.summary.generate");
    expect(JSON.parse(request.controlsJson)).toMatchObject({
      disableTools: true,
      executionProfile: "stateless-completion",
      maxOutputTokens: 2_048,
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    expect(request.metadata).toMatchObject({
      model: "gpt-5.6-sol",
      policyVersion: "meeting-summary.subscription-runtime.v8",
      reasoningEffort: "medium",
    });
    expect(JSON.stringify(request)).not.toContain("OPENAI_API_KEY");
  });

  it("maps the incremental request with its Luna low 2048-token profile", () => {
    const request = toGrpcTaskRequest(incrementalRuntimeRequest);

    expect(request.purpose).toBe("discord_meeting.summary.incremental");
    expect(JSON.parse(request.controlsJson)).toMatchObject({
      maxOutputTokens: 2_048,
      model: "gpt-5.6-luna",
      outputSchemaName: "discord_meeting_incremental_summary_v1",
      reasoningEffort: "low",
    });
    expect(request.metadata).toMatchObject({
      model: "gpt-5.6-luna",
      policyVersion: "meeting-summary.incremental.subscription-runtime.v4",
      reasoningEffort: "low",
      summaryRevision: "1",
      throughTurnCount: "1",
    });
  });

  it("maps completed structured output and its attestation", () => {
    const structuredOutput = {
      actionItems: [],
      decisions: [{ evidenceTurnIds: ["turn-1"], text: "Выпустить релиз" }],
      openQuestions: [],
      overview: "Обсудили релиз.",
      title: "Релиз",
    };
    const result = fromGrpcTaskResponse({
      schemaVersion: 1,
      status: "AGENT_RUNTIME_TASK_STATUS_COMPLETED",
      structuredOutputJson: JSON.stringify(structuredOutput),
      executionAttestation: {
        schemaVersion: 1,
        requestId: runtimeRequest.runId,
        purpose: runtimeRequest.context.purpose,
        canonicalRequestSha256: canonicalJsonSha256(runtimeRequest),
        provider: "AGENT_RUNTIME_PROVIDER_CODEX",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        runtimeEngine: "subscription-runtime-cli",
        runtimePackageVersion: "0.1.0-main.2",
        launcherSha256: "a".repeat(64),
        selectedOutputKind:
          "AGENT_RUNTIME_SELECTED_OUTPUT_KIND_STRUCTURED_OUTPUT",
        selectedOutputSha256: canonicalJsonSha256(structuredOutput),
      },
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.structuredOutput).toEqual(structuredOutput);
      expect(result.executionAttestation.provider).toBe("codex");
    }
  });

  it("maps complete real usage and never fabricates absent/default usage", () => {
    const baseResponse = {
      schemaVersion: 1,
      status: "AGENT_RUNTIME_TASK_STATUS_COMPLETED",
      structuredOutputJson: JSON.stringify({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        overview: "Обсудили релиз.",
        title: "Релиз",
        topics: [],
      }),
      executionAttestation: {
        schemaVersion: 1,
        requestId: incrementalRuntimeRequest.runId,
        purpose: incrementalRuntimeRequest.context.purpose,
        canonicalRequestSha256: canonicalJsonSha256(incrementalRuntimeRequest),
        provider: "AGENT_RUNTIME_PROVIDER_CODEX",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        runtimeEngine: "subscription-runtime-cli",
        runtimePackageVersion: "0.1.0-main.2",
        launcherSha256: "a".repeat(64),
        selectedOutputKind: "AGENT_RUNTIME_SELECTED_OUTPUT_KIND_STRUCTURED_OUTPUT",
        selectedOutputSha256: "b".repeat(64),
      },
    };

    const complete = fromGrpcTaskResponse({
      ...baseResponse,
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        complete: true,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    });
    const absent = fromGrpcTaskResponse({
      ...baseResponse,
      usage: {
        cacheWriteInputTokens: 0,
        cachedInputTokens: 0,
        complete: false,
        inputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    });

    expect(complete).toMatchObject({
      status: "completed",
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    });
    expect(absent).not.toHaveProperty("usage");
  });

  it("round-trips partial telemetry, a derived total, and an inexact cost range", () => {
    const result = fromGrpcTaskResponse({
      schemaVersion: 1,
      status: "AGENT_RUNTIME_TASK_STATUS_COMPLETED",
      structuredOutputJson: JSON.stringify({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        overview: "Обсудили релиз.",
        title: "Релиз",
        topics: [],
      }),
      executionAttestation: attestationFor(incrementalRuntimeRequest),
      telemetry: {
        source: "codex_exec_jsonl",
        cacheWriteInputTokens: {
          availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE",
          value: "0",
        },
        cachedInputTokens: {
          availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_MEASURED",
          value: "200",
        },
        inputTokens: {
          availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_MEASURED",
          value: "1000",
        },
        outputTokens: {
          availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_MEASURED",
          value: "300",
        },
        reasoningOutputTokens: {
          availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_MEASURED",
          value: "100",
        },
        totalTokens: {
          availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_DERIVED",
          derivedFrom: [
            "AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_INPUT",
            "AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_OUTPUT",
          ],
          value: "1300",
        },
        cost: {
          hasExactUsd: false,
          maximumUsd: 0.000_564,
          minimumUsd: 0.000_524,
          priceCardId: "openai-standard-2026-08-02",
          priceCardSource: "https://developers.openai.com/api/docs/pricing#text-tokens",
        },
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      telemetry: {
        source: "codex_exec_jsonl",
        cacheWriteInputTokens: { availability: "unavailable" },
        totalTokens: {
          availability: "derived",
          derivedFrom: ["inputTokens", "outputTokens"],
          value: 1_300,
        },
        cost: {
          maximumUsd: 0.000_564,
          minimumUsd: 0.000_524,
          priceCardId: "openai-standard-2026-08-02",
        },
      },
    });
    if (result.status !== "completed") {
      throw new Error("expected completed result");
    }
    expect(result.telemetry?.cacheWriteInputTokens).toEqual({
      availability: "unavailable",
    });
    expect(result.usage).toBeUndefined();
  });

  it("fails closed on an unsupported telemetry availability", () => {
    expect(() => fromGrpcTaskResponse({
      schemaVersion: 1,
      status: "AGENT_RUNTIME_TASK_STATUS_COMPLETED",
      structuredOutputJson: JSON.stringify({}),
      executionAttestation: attestationFor(incrementalRuntimeRequest),
      telemetry: {
        source: "codex_exec_jsonl",
        cacheWriteInputTokens: { availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNSPECIFIED" },
        cachedInputTokens: { availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE" },
        inputTokens: { availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE" },
        outputTokens: { availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE" },
        reasoningOutputTokens: { availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE" },
        totalTokens: { availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE" },
      },
    })).toThrow("telemetry.cacheWriteInputTokens.availability is invalid");
  });

  it("normalizes transport-specific failures without exposing details", () => {
    const result = fromGrpcTaskResponse({
      schemaVersion: 1,
      status: "AGENT_RUNTIME_TASK_STATUS_FAILED",
      failure: {
        code: "agent_runtime.cli_timeout",
        safeMessage: "Agent runtime task timed out",
        retryable: true,
        reconnectRequired: false,
        causeCategory: "subscription_runtime_cli",
        details: { stderr: "must-not-cross" },
      },
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        complete: true,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    });

    expect(result).toEqual({
      protocolVersion: 1,
      status: "failed",
      failure: {
        causeCategory: "subscription_runtime_cli",
        code: "task_timeout",
        reconnectRequired: false,
        retryable: true,
        safeMessage: "Agent runtime task timed out",
      },
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    });
  });
});

function attestationFor(request: typeof incrementalRuntimeRequest) {
  return {
    schemaVersion: 1,
    requestId: request.runId,
    purpose: request.context.purpose,
    canonicalRequestSha256: canonicalJsonSha256(request),
    provider: "AGENT_RUNTIME_PROVIDER_CODEX",
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    runtimeEngine: "subscription-runtime-cli",
    runtimePackageVersion: "0.1.0-main.2",
    launcherSha256: "a".repeat(64),
    selectedOutputKind: "AGENT_RUNTIME_SELECTED_OUTPUT_KIND_STRUCTURED_OUTPUT",
    selectedOutputSha256: "b".repeat(64),
  };
}
