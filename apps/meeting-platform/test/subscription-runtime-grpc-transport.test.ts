import {
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
    maxOutputTokens: 4_096,
    maxPromptBytes: 1_048_576,
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
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });
    expect(JSON.stringify(request)).not.toContain("OPENAI_API_KEY");
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
        reasoningEffort: "xhigh",
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
    });
  });
});
