import { describe, expect, it } from "vitest";

import {
  QuestionBinding,
  createExhaustiveCoverageGroundingPlan,
  createFocusedRetrievalGroundingPlan,
  focusedMemoryGeneration,
  type GroundedAnswerGenerationRequest,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  SubscriptionRuntimeGroundedAnswerAdapter,
  auditedSubscriptionRuntimePackageVersion,
  canonicalJsonSha256,
  buildSubscriptionRuntimeKnowledgeAnswerRequest,
  knowledgeAnswerExecutionProfile,
  knowledgeCoverageExecutionProfile,
  providerKnowledgeCoverageExtractSchema,
  subscriptionRuntimeCliEngine,
  subscriptionRuntimeConversationPurpose,
  subscriptionRuntimeKnowledgeAnswerPurpose,
  subscriptionRuntimeKnowledgeAnswerMaxOutputTokens,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";

const launcherSha256 = "a".repeat(64);

function generationRequest(): GroundedAnswerGenerationRequest {
  const canonicalEvidenceHash = "c".repeat(64);
  return {
    attemptId: "question-1:generation:1:attempt:1",
    binding: QuestionBinding.create({
      authorizationDigest: "b".repeat(64),
      authorizationPolicyVersion: "discord.participant-current-results.v1",
      authorizationPrincipalRef: "opaque-principal",
      botApplicationIdentity: "11111111111111111",
      canonicalEvidenceHash,
      expectedLocale: "en",
      finalProjectionEpoch: "final-epoch-1",
      finalProjectionReceipt:
        "discord:v2:channel:22222222222222222:message:33333333333333333",
      humanActorIds: ["77777777777777777", "88888888888888888"],
      meetingId: "meeting-1",
      meetingRevision: 4,
      memoryGeneration: focusedMemoryGeneration(canonicalEvidenceHash),
      policyVersion: "discord.participant-current-results.v1",
      projectionTargetContainerId: "22222222222222222",
      questionHash: "d".repeat(64),
      questionId: "44444444444444444",
      requesterSubject: "e".repeat(64),
      roomId: "55555555555555555",
      scopeId: "66666666666666666",
      transcriptId: "transcript-1",
      transcriptVersion: 1,
    }).toSnapshot(),
    locale: "en",
    plan: createFocusedRetrievalGroundingPlan({
      authorityGeneration: focusedMemoryGeneration(canonicalEvidenceHash),
      coverage: "sufficient",
      humanActorIds: ["77777777777777777", "88888888888888888"],
      turns: [
        {
          endMs: 2_000,
          speakerId: "77777777777777777",
          startMs: 0,
          text: "The release was moved from Friday.",
          turnHash: "1".repeat(64),
          turnId: "turn-1",
        },
        {
          endMs: 7_202_000,
          speakerId: "88888888888888888",
          startMs: 7_200_000,
          text: "Correction: the release is Monday.",
          turnHash: "2".repeat(64),
          turnId: "turn-720",
        },
      ],
    }),
    question: "When is the corrected release date?",
  };
}

class RuntimeFake implements SubscriptionRuntimeTransportPort {
  request?: SubscriptionRuntimeAgentTaskRequest;
  reportedPurpose?: string;
  output: JsonObject = {
    claims: [{ evidenceIds: ["evidence-000002"], text: "The release is Monday." }],
    locale: "en",
    status: "answered",
  };
  signal: AbortSignal | undefined;

  checkHealth() {
    return Promise.resolve({
      launcherSha256,
      runtimeEngine: subscriptionRuntimeCliEngine,
      runtimeVersion: auditedSubscriptionRuntimePackageVersion,
      status: "serving" as const,
      warningCodes: [],
    });
  }

  execute(
    request: SubscriptionRuntimeAgentTaskRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SubscriptionRuntimeTaskResult> {
    this.request = request;
    this.signal = options.signal;
    return Promise.resolve({
      executionAttestation: {
        canonicalRequestSha256: canonicalJsonSha256(request),
        launcherSha256,
        model: request.task.controls.model,
        provider: "codex",
        purpose: this.reportedPurpose ?? request.context.purpose,
        reasoningEffort: request.task.controls.reasoningEffort,
        requestId: request.runId,
        runtimeEngine: subscriptionRuntimeCliEngine,
        runtimePackageVersion: auditedSubscriptionRuntimePackageVersion,
        schemaVersion: 1,
        selectedOutputKind: "structured_output",
        selectedOutputSha256: canonicalJsonSha256(this.output),
      },
      protocolVersion: 1,
      status: "completed",
      structuredOutput: this.output,
    });
  }
}

function adapter(runtime: RuntimeFake) {
  return new SubscriptionRuntimeGroundedAnswerAdapter(runtime, {
    expectedLauncherSha256: launcherSha256,
    expectedRuntimeEngine: subscriptionRuntimeCliEngine,
  });
}

describe("Meeting Knowledge subscription runtime contract", () => {
  it("serializes only bounded locally rehydrated focused evidence", async () => {
    const runtime = new RuntimeFake();
    const generator = adapter(runtime);
    const measurement = await generator.measure(generationRequest());
    const generated = await generator.generate(generationRequest());

    expect(generated).toMatchObject({ status: "completed" });
    expect(measurement.runtimeProfile).toContain("sol-medium.bounded-grounding.v3");
    expect(measurement.inputTokens).toBeGreaterThan(0);
    expect(measurement.requestBytes).toBeGreaterThan(0);
    expect(runtime.request?.context.purpose).toBe(subscriptionRuntimeKnowledgeAnswerPurpose);
    expect(runtime.request?.task.controls).toMatchObject({
      disableTools: true,
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    expect(runtime.request?.task.prompt).toContain("evidence-000001");
    expect(runtime.request?.task.prompt).toContain("evidence-000002");
    expect(runtime.request?.task.prompt).not.toContain("77777777777777777");
    expect(runtime.request?.task.prompt).not.toContain("11111111111111111");
    expect(runtime.request?.task.prompt).not.toContain("transcript-1");
    expect(runtime.request?.task.prompt).not.toContain("1".repeat(64));
    const prompt = JSON.parse(runtime.request?.task.prompt ?? "null") as {
      readonly evidence: readonly unknown[];
      readonly groundingMode: string;
    };
    expect(prompt).toMatchObject({
      groundingMode: "focused_retrieval",
    });
    expect(prompt.evidence).toHaveLength(2);
    const serializedPrompt = runtime.request?.task.prompt ?? "";
    expect(serializedPrompt).not.toContain("currentTranscriptComplete");
    expect(serializedPrompt).not.toContain("currentTranscriptEvidenceIds");
    expect(serializedPrompt).not.toContain("priorityEvidenceIds");
    expect(runtime.request?.task.systemPrompt).toContain("bounded focused selection");
  });

  it("cannot serialize the literal full current transcript through the answer contract", async () => {
    const runtime = new RuntimeFake();
    const fullTranscriptLiteral = Array.from(
      { length: 1_000 },
      (_, index) => `FULL-CURRENT-TRANSCRIPT-TURN-${index}`,
    ).join("\n");

    await adapter(runtime).generate(generationRequest());

    const serializedRequest = JSON.stringify(runtime.request);
    expect(serializedRequest).not.toContain(fullTranscriptLiteral);
    expect(serializedRequest).not.toContain("FULL-CURRENT-TRANSCRIPT-TURN-500");
    expect(serializedRequest).not.toContain("currentTranscript");
    expect(serializedRequest.length).toBeLessThan(fullTranscriptLiteral.length);
    expect(JSON.parse(runtime.request?.task.prompt ?? "null").evidence).toHaveLength(2);
  });

  it("rejects the removed whole-current contract before its literal text reaches runtime", () => {
    const focused = generationRequest();
    const fullTranscriptLiteral = "FULL CURRENT TRANSCRIPT LITERAL MUST NEVER CROSS";
    const removedPlan = {
      ...focused.plan,
      evidence: [{ ...focused.plan.evidence[0]!, text: fullTranscriptLiteral }],
      mode: "current_complete",
    } as unknown as GroundedAnswerGenerationRequest["plan"];

    expect(() => buildSubscriptionRuntimeKnowledgeAnswerRequest({
      ...focused,
      plan: removedPlan,
    }, {
      isolatedCwd: "/tmp/meeting-knowledge-test",
      maxOutputTokens: subscriptionRuntimeKnowledgeAnswerMaxOutputTokens,
      timeoutMs: 60_000,
    })).toThrow("qualified evidence plan");
  });

  it("rejects malformed provider output without a repair call", async () => {
    const runtime = new RuntimeFake();
    runtime.output = {
      claims: [],
      extra: "forbidden",
      locale: "en",
      status: "answered",
    };
    const generated = await adapter(runtime).generate(generationRequest());

    expect(generated).toEqual({
      code: "provider_output_invalid",
      retryable: false,
      status: "failed",
    });
  });

  it("propagates the active cancellation signal to runtime transport", async () => {
    const runtime = new RuntimeFake();
    const controller = new AbortController();

    await adapter(runtime).generate(generationRequest(), {
      signal: controller.signal,
    });

    expect(runtime.signal).toBe(controller.signal);
  });

  it("admits exhaustive synthesis only with a complete explicit bitmap", async () => {
    const runtime = new RuntimeFake();
    const focused = generationRequest();
    const request: GroundedAnswerGenerationRequest = {
      ...focused,
      plan: createExhaustiveCoverageGroundingPlan({
        authorityGeneration: focused.plan.authorityGeneration,
        coverageBitmap: [true, true],
        coveragePlanDigest: "coverage-plan-1",
        coverageReduction: {
          evidenceBlockCount: 2,
          payload: { blocksReviewed: 2, matches: 1 },
          schemaVersion: 1,
          selectionStatus: "selected",
          selectedCanonicalTurnCount: focused.plan.evidence.length,
          selectedEvidenceBlockCount: 2,
        },
        humanActorIds: ["77777777777777777", "88888888888888888"],
        turns: focused.plan.evidence,
      }),
      question: "List every release-date decision",
    };
    await expect(adapter(runtime).generate(request)).resolves.toMatchObject({
      status: "completed",
    });
    const prompt = JSON.parse(runtime.request?.task.prompt ?? "null") as {
      readonly coverageBlocks: number;
      readonly coverageComplete: boolean;
      readonly coverageReduction: unknown;
      readonly groundingMode: string;
    };
    expect(prompt).toMatchObject({
      coverageBlocks: 2,
      coverageComplete: true,
      groundingMode: "exhaustive_coverage",
    });
    expect(prompt.coverageReduction).toMatchObject({
      payload: { blocksReviewed: 2, matches: 1 },
    });
    expect(runtime.request?.task.systemPrompt).toContain("every-block plan");
  });

  it("admits an uncited absence candidate only for a complete no-match plan", async () => {
    const runtime = new RuntimeFake();
    runtime.output = {
      claims: [{
        evidenceIds: [],
        text: "Project Zeta was absent from the complete authorized corpus.",
      }],
      locale: "en",
      status: "answered",
    };
    const focused = generationRequest();
    const request: GroundedAnswerGenerationRequest = {
      ...focused,
      plan: createExhaustiveCoverageGroundingPlan({
        authorityGeneration: focused.plan.authorityGeneration,
        coverageBitmap: [true, true],
        coveragePlanDigest: "coverage-plan-absence-1",
        coverageReduction: {
          evidenceBlockCount: 2,
          payload: { blocksReviewed: 2, semanticClaimCount: 0 },
          schemaVersion: 1,
          selectionStatus: "no_match",
          selectedCanonicalTurnCount: 0,
          selectedEvidenceBlockCount: 0,
        },
        humanActorIds: ["77777777777777777"],
        turns: [],
      }),
      question: "Was Project Zeta ever approved? Check every meeting.",
    };

    await expect(adapter(runtime).generate(request)).resolves.toEqual({
      answer: runtime.output,
      status: "completed",
    });
    expect(runtime.request?.task.systemPrompt).toContain(
      "Only when coverageReduction.selectionStatus is no_match",
    );
    expect(runtime.request?.task.controls.outputSchema).toMatchObject({
      properties: {
        claims: {
          items: {
            properties: { evidenceIds: { minItems: 0 } },
          },
        },
      },
    });
  });

  it("rejects conversation-profile attestation for a knowledge answer", async () => {
    const runtime = new RuntimeFake();
    runtime.reportedPurpose = subscriptionRuntimeConversationPurpose;

    await expect(adapter(runtime).generate(generationRequest())).resolves.toEqual({
      code: "invalid_attestation",
      retryable: false,
      status: "failed",
    });
  });

  it("pins distinct strict answer and coverage profiles", () => {
    expect(knowledgeAnswerExecutionProfile).toMatchObject({
      model: "gpt-5.6-sol",
      purpose: "discord_meeting.knowledge.answer.v1",
      reasoningEffort: "medium",
    });
    expect(knowledgeCoverageExecutionProfile).toMatchObject({
      model: "gpt-5.6-sol",
      purpose: "discord_meeting.knowledge.coverage_extract.v1",
      reasoningEffort: "medium",
    });
    expect(providerKnowledgeCoverageExtractSchema.safeParse({
      evidenceIds: ["evidence-000001"],
      extracts: [{
        evidenceId: "evidence-000002",
        relevance: "direct",
      }],
    }).success).toBe(false);
    expect(providerKnowledgeCoverageExtractSchema.safeParse({
      evidenceIds: [],
      extracts: [],
      providerPayload: "forbidden",
    }).success).toBe(false);
  });
});
