import { describe, expect, it } from "vitest";

import {
  CoverageExtractionCapacityError,
  createHistoricalReleaseBinding,
  type LocallyRehydratedEvidenceBlockV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  SubscriptionRuntimeCoverageExtractorAdapter,
  auditedSubscriptionRuntimePackageVersion,
  canonicalJsonSha256,
  subscriptionRuntimeCliEngine,
  subscriptionRuntimeKnowledgeCoveragePurpose,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";

const launcherSha256 = "a".repeat(64);

class RuntimeFake implements SubscriptionRuntimeTransportPort {
  public output: JsonObject = {
    claims: [
      { evidenceIds: ["evidence-000002"], relevance: "direct" },
      { evidenceIds: ["evidence-000003"], relevance: "conflicting" },
    ],
    reviewedEvidenceIds: [
      "evidence-000001",
      "evidence-000002",
      "evidence-000003",
    ],
    status: "claims",
  };
  public request?: SubscriptionRuntimeAgentTaskRequest;
  public signal: AbortSignal | undefined;
  public transportError?: Error;

  public checkHealth() {
    return Promise.resolve({
      launcherSha256,
      runtimeEngine: subscriptionRuntimeCliEngine,
      runtimeVersion: auditedSubscriptionRuntimePackageVersion,
      status: "serving" as const,
      warningCodes: [],
    });
  }

  public execute(
    request: SubscriptionRuntimeAgentTaskRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SubscriptionRuntimeTaskResult> {
    this.request = request;
    this.signal = options.signal;
    if (this.transportError !== undefined) {
      return Promise.reject(this.transportError);
    }
    return Promise.resolve({
      executionAttestation: {
        canonicalRequestSha256: canonicalJsonSha256(request),
        launcherSha256,
        model: request.task.controls.model,
        provider: "codex",
        purpose: request.context.purpose,
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

function block(textOverride?: string): LocallyRehydratedEvidenceBlockV1 {
  return {
    binding: createHistoricalReleaseBinding({
      acceptedMeetingRevision: 2,
      desiredGeneration: 3,
      meetingId: "private-meeting",
      roomId: "private-room",
      scopeId: "private-scope",
      transcriptId: "private-transcript",
      transcriptVersion: 1,
    }),
    candidateLocator: "mkblock1.opaque-candidate",
    contentHash: "opaque-content-hash",
    indexGeneration: "mkgeneration1.opaque-generation",
    ordinal: 0,
    turns: [
      {
        endMs: 1_000,
        sourceEndCodePoint: Array.from(textOverride ?? "Routine status update.").length,
        sourceRef: "turn1.routine",
        sourceStartCodePoint: 0,
        speakerId: "private-speaker-a",
        startMs: 0,
        text: textOverride ?? "Routine status update.",
        turnId: "turn-routine",
      },
      {
        endMs: 2_000,
        sourceEndCodePoint: Array.from("The team agreed to launch Beta next week.").length,
        sourceRef: "turn1.decision",
        sourceStartCodePoint: 0,
        speakerId: "private-speaker-b",
        startMs: 1_000,
        text: "The team agreed to launch Beta next week.",
        turnId: "turn-semantic-decision",
      },
      {
        endMs: 3_000,
        sourceEndCodePoint: Array.from("Correction: Beta was rejected pending review.").length,
        sourceRef: "turn1.contradiction",
        sourceStartCodePoint: 0,
        speakerId: "private-speaker-a",
        startMs: 2_000,
        text: "Correction: Beta was rejected pending review.",
        turnId: "turn-contradiction",
      },
    ],
  };
}

function adapter(runtime: RuntimeFake, maximumRequestBytes = 131_072) {
  return new SubscriptionRuntimeCoverageExtractorAdapter(runtime, {
    expectedLauncherSha256: launcherSha256,
    expectedRuntimeEngine: subscriptionRuntimeCliEngine,
    maximumRequestBytes,
  });
}

describe("Meeting Knowledge semantic every-block provider contract", () => {
  it("maps semantic claims and contradictions back to local canonical turn IDs", async () => {
    const runtime = new RuntimeFake();
    const result = await adapter(runtime).extract({
      block: block(),
      question: "List all decisions about Beta",
    });

    expect(result).toMatchObject({
      selectionStatus: "selected",
      selectedTurns: [
        { relevance: "direct", turnId: "turn-semantic-decision" },
        { relevance: "conflicting", turnId: "turn-contradiction" },
      ],
    });
    expect(runtime.request?.context.purpose).toBe(
      subscriptionRuntimeKnowledgeCoveragePurpose,
    );
    expect(runtime.request?.task.controls).toMatchObject({
      disableTools: true,
      maxTurns: 1,
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    const prompt = runtime.request?.task.prompt ?? "";
    expect(prompt).toContain("The team agreed to launch Beta next week.");
    expect(prompt).not.toContain("private-speaker-a");
    expect(prompt).not.toContain("private-room");
    expect(prompt).not.toMatch(
      /current_complete|full transcript|prefix|summary|SDK chunk/iu,
    );
    expect(runtime.request?.task.systemPrompt).toContain(
      "lexical overlap is neither required nor sufficient",
    );
  });

  it("preserves a zero-selection no-match proof for one fully reviewed block", async () => {
    const runtime = new RuntimeFake();
    runtime.output = {
      claims: [],
      reviewedEvidenceIds: [
        "evidence-000001",
        "evidence-000002",
        "evidence-000003",
      ],
      status: "no_match",
    };

    await expect(adapter(runtime).extract({
      block: block(),
      question: "Was Project Zeta approved?",
    })).resolves.toMatchObject({
      payload: { blocksReviewed: 1, turnsReviewed: 3 },
      selectedTurns: [],
      selectionStatus: "no_match",
    });
  });

  it("fails closed for unknown, duplicate, malformed, timeout, and capacity outcomes", async () => {
    const unknown = new RuntimeFake();
    unknown.output = {
      claims: [{ evidenceIds: ["evidence-999999"], relevance: "direct" }],
      reviewedEvidenceIds: [
        "evidence-000001",
        "evidence-000002",
        "evidence-000003",
        "evidence-999999",
      ],
      status: "claims",
    };
    await expect(adapter(unknown).extract({
      block: block(),
      question: "List all decisions",
    })).rejects.toThrow("account for every local turn");

    const duplicate = new RuntimeFake();
    duplicate.output = {
      claims: [
        { evidenceIds: ["evidence-000002"], relevance: "direct" },
        { evidenceIds: ["evidence-000002"], relevance: "context" },
      ],
      reviewedEvidenceIds: [
        "evidence-000001",
        "evidence-000002",
        "evidence-000003",
      ],
      status: "claims",
    };
    await expect(adapter(duplicate).extract({
      block: block(),
      question: "List all decisions",
    })).rejects.toThrow("malformed contract");

    const omitted = new RuntimeFake();
    omitted.output = {
      claims: [{ evidenceIds: ["evidence-000002"], relevance: "direct" }],
      reviewedEvidenceIds: ["evidence-000002", "evidence-000003"],
      status: "claims",
    };
    await expect(adapter(omitted).extract({
      block: block(),
      question: "List all decisions",
    })).rejects.toThrow("did not account for every local turn");

    const timeout = new RuntimeFake();
    timeout.transportError = new Error("synthetic timeout");
    await expect(adapter(timeout).extract({
      block: block(),
      question: "List all decisions",
    })).rejects.toThrow("transport failed");

    const oversized = new RuntimeFake();
    await expect(adapter(oversized, 4_096).extract({
      block: block("x".repeat(16_384)),
      question: "List all decisions",
    })).rejects.toBeInstanceOf(CoverageExtractionCapacityError);
    expect(oversized.request).toBeUndefined();
  });

  it("propagates active cancellation to the subscription runtime", async () => {
    const runtime = new RuntimeFake();
    const controller = new AbortController();
    await adapter(runtime).extract({
      block: block(),
      question: "List all decisions",
      signal: controller.signal,
    });
    expect(runtime.signal).toBe(controller.signal);
  });
});
