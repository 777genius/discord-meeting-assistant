import { describe, expect, it } from "vitest";

import {
  SubscriptionRuntimeGroundedAnswerAdapter,
  knowledgeAnswerExecutionProfile,
  subscriptionRuntimeEngine,
  subscriptionRuntimeProfileForPurpose,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";

import { resolveProcessCompletion } from "../src/subscription-runtime-completion.js";
import type { ProcessRunResult } from "../src/types.js";
import {
  canonicalRequest,
  knowledgeAnswerStructuredOutput,
} from "./fixture.js";
import {
  completedProcess,
  failedProcess,
  installation,
} from "./executor-test-support.js";

const repairableCompletionFailures: readonly {
  readonly label: string;
  readonly process: () => ProcessRunResult;
}[] = [
  { label: "malformed JSON", process: malformedJsonProcess },
  { label: "invalid telemetry", process: invalidTelemetryProcess },
  {
    label: "output limit overflow",
    process: () => ({
      ...completedKnowledgeAnswerProcess(),
      outputLimitExceeded: true,
    }),
  },
  { label: "parsed provider_output_invalid", process: providerOutputInvalidProcess },
];

describe("subscription runtime completion failure precedence", () => {
  it.each(
    ([undefined, "fast"] as const).flatMap((serviceTier) =>
      repairableCompletionFailures.map(({ label, process }) =>
        [serviceTier ?? "missing", serviceTier, label, process] as const)
    ),
  )(
    "rejects %s-tier %s before the grounded adapter can repair it",
    async (_tierLabel, serviceTier, _failureLabel, process) => {
      const transport = new CompletionTransport(() => ({
        ...process(),
        ...(serviceTier === undefined ? {} : { serviceTier }),
      }));

      await expect(groundedAdapter(transport).generate(groundedGenerationRequest())).resolves
        .toEqual({
          code: "task_mode_unsupported",
          retryable: false,
          status: "failed",
        });
      expect(transport.requests).toHaveLength(1);
    },
  );

  it("retains the legitimate one-repair path on matching default tier", async () => {
    const transport = new CompletionTransport((requestIndex) => ({
      ...(requestIndex === 1
        ? malformedJsonProcess()
        : completedKnowledgeAnswerProcess()),
      serviceTier: "default",
    }));

    await expect(groundedAdapter(transport).generate(groundedGenerationRequest())).resolves
      .toMatchObject({ status: "completed" });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.runId).not.toBe(transport.requests[0]?.runId);
  });

  it("keeps timeout precedence when qualified tier evidence is absent", async () => {
    const transport = new CompletionTransport(() => ({
      ...malformedJsonProcess(),
      timedOut: true,
    }));

    await expect(groundedAdapter(transport).generate(groundedGenerationRequest())).resolves
      .toEqual({ code: "task_timeout", retryable: true, status: "failed" });
    expect(transport.requests).toHaveLength(1);
  });

  it("retains legacy completion when profile and execution tiers are both undefined", () => {
    const profile = subscriptionRuntimeProfileForPurpose(canonicalRequest.context.purpose);
    expect(profile).toBeDefined();
    if (profile === undefined) {
      return;
    }

    expect(resolveProcessCompletion({
      completedInstallation: installation(),
      execution: completedProcess(),
      profile,
      request: canonicalRequest,
      runtimeEngine: subscriptionRuntimeEngine,
    })).toMatchObject({ status: "completed" });
  });
});

class CompletionTransport implements SubscriptionRuntimeTransportPort {
  public readonly requests: SubscriptionRuntimeAgentTaskRequest[] = [];

  public constructor(
    private readonly process: (requestIndex: number) => ProcessRunResult,
  ) {}

  public checkHealth() {
    return Promise.resolve({
      launcherSha256: installation().launcherSha256,
      runtimeEngine: subscriptionRuntimeEngine,
      runtimeVersion: installation().runtimePackageVersion,
      status: "serving" as const,
      warningCodes: [],
    });
  }

  public execute(request: SubscriptionRuntimeAgentTaskRequest) {
    this.requests.push(request);
    return Promise.resolve(resolveProcessCompletion({
      completedInstallation: installation(),
      execution: this.process(this.requests.length),
      profile: knowledgeAnswerExecutionProfile,
      request,
      runtimeEngine: subscriptionRuntimeEngine,
    }));
  }
}

function groundedAdapter(
  transport: SubscriptionRuntimeTransportPort,
): SubscriptionRuntimeGroundedAnswerAdapter {
  return new SubscriptionRuntimeGroundedAnswerAdapter(transport, {
    expectedLauncherSha256: installation().launcherSha256,
    expectedRuntimeEngine: subscriptionRuntimeEngine,
  });
}

function groundedGenerationRequest(): Parameters<
  SubscriptionRuntimeGroundedAnswerAdapter["generate"]
>[0] {
  const canonicalEvidenceHash = "c".repeat(64);
  const memoryGeneration = `focused-memory:v1:${canonicalEvidenceHash}`;
  return {
    attemptId: "question-1:generation:1:attempt:1",
    binding: {
      canonicalEvidenceHash,
      memoryGeneration,
      transcriptVersion: 1,
    },
    locale: "en",
    plan: {
      authorityGeneration: memoryGeneration,
      evidence: [{
        endMs: 2_000,
        evidenceId: "evidence-000001",
        speakerId: "speaker-1",
        startMs: 0,
        text: "The release is Monday.",
        turnHash: "1".repeat(64),
        turnId: "turn-1",
      }],
      mode: "focused_retrieval",
    },
    question: "When is the release?",
  };
}

function completedKnowledgeAnswerProcess(): ProcessRunResult {
  return completedProcess(undefined, knowledgeAnswerStructuredOutput);
}

function malformedJsonProcess(): ProcessRunResult {
  return { ...completedKnowledgeAnswerProcess(), stdout: "{" };
}

function invalidTelemetryProcess(): ProcessRunResult {
  return {
    ...completedKnowledgeAnswerProcess(),
    stdout: JSON.stringify({
      outputText: JSON.stringify(knowledgeAnswerStructuredOutput),
      protocolVersion: 1,
      status: "completed",
      structuredOutput: knowledgeAnswerStructuredOutput,
      telemetry: {
        usage: {
          cacheWriteInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 100,
          outputTokens: -1,
          reasoningOutputTokens: 0,
          totalTokens: 99,
        },
      },
      warnings: [],
    }),
  };
}

function providerOutputInvalidProcess(): ProcessRunResult {
  return {
    ...failedProcess(),
    stdout: JSON.stringify({
      failure: {
        code: "provider_output_invalid",
        reconnectRequired: false,
        retryable: false,
      },
      protocolVersion: 1,
      status: "failed",
      warnings: [],
    }),
  };
}
