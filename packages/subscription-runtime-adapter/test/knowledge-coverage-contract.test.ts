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

function extractionInput(
  evidenceBlock: LocallyRehydratedEvidenceBlockV1,
  question: string,
) {
  return {
    analysisTurns: evidenceBlock.turns,
    block: evidenceBlock,
    question,
  };
}

describe("Meeting Knowledge semantic every-block provider contract", () => {
  it("maps semantic claims and contradictions back to local canonical turn IDs", async () => {
    const runtime = new RuntimeFake();
    const evidenceBlock = block();
    const result = await adapter(runtime).extract(extractionInput(
      evidenceBlock,
      "List all decisions about Beta",
    ));

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

  it("sends only the overlap-safe analysis projection while retaining canonical metadata", async () => {
    const runtime = new RuntimeFake();
    runtime.output = {
      claims: [],
      reviewedEvidenceIds: ["evidence-000001", "evidence-000002"],
      status: "no_match",
    };
    const evidenceBlock = block();

    await adapter(runtime).extract({
      analysisTurns: evidenceBlock.turns.slice(1),
      block: evidenceBlock,
      question: "List all decisions about Beta",
    });

    const prompt = JSON.parse(runtime.request?.task.prompt ?? "") as {
      evidence: readonly { readonly evidenceId: string; readonly text: string }[];
    };
    expect(prompt.evidence).toEqual([
      expect.objectContaining({
        evidenceId: "evidence-000001",
        text: "The team agreed to launch Beta next week.",
      }),
      expect.objectContaining({
        evidenceId: "evidence-000002",
        text: "Correction: Beta was rejected pending review.",
      }),
    ]);
    expect(runtime.request?.task.prompt).not.toContain("Routine status update.");
    expect(runtime.request?.context.metadata).toMatchObject({
      meetingId: evidenceBlock.candidateLocator,
      transcriptId: evidenceBlock.contentHash,
      transcriptVersion: "1",
    });
  });

  it("preserves distinct source ranges and binds the runId to their ordered projection", async () => {
    const canonicalBlock = block();
    const source = canonicalBlock.turns[1];
    if (source === undefined) {
      throw new Error("missing fixture turn");
    }
    const firstHalf = {
      ...source,
      sourceEndCodePoint: 18,
      text: "The team agreed to",
    };
    const secondHalf = {
      ...source,
      sourceStartCodePoint: 19,
      text: "launch Beta next week.",
    };
    const firstRuntime = new RuntimeFake();
    firstRuntime.output = {
      claims: [{
        evidenceIds: ["evidence-000001", "evidence-000002"],
        relevance: "direct",
      }],
      reviewedEvidenceIds: ["evidence-000001", "evidence-000002"],
      status: "claims",
    };
    const secondRuntime = new RuntimeFake();
    secondRuntime.output = {
      claims: [],
      reviewedEvidenceIds: ["evidence-000001", "evidence-000002"],
      status: "no_match",
    };

    const result = await adapter(firstRuntime).extract({
      analysisTurns: [firstHalf, secondHalf],
      block: canonicalBlock,
      question: "What was agreed?",
    });
    await adapter(secondRuntime).extract({
      analysisTurns: [secondHalf, firstHalf],
      block: canonicalBlock,
      question: "What was agreed?",
    });

    const prompt = JSON.parse(firstRuntime.request?.task.prompt ?? "") as {
      evidence: readonly { readonly text: string }[];
    };
    expect(prompt.evidence.map(({ text }) => text)).toEqual([
      "The team agreed to",
      "launch Beta next week.",
    ]);
    expect(result.selectedTurns).toEqual([
      {
        blockLocator: canonicalBlock.candidateLocator,
        relevance: "direct",
        sourceEndCodePoint: 18,
        sourceRef: source.sourceRef,
        sourceStartCodePoint: 0,
        turnId: source.turnId,
      },
      {
        blockLocator: canonicalBlock.candidateLocator,
        relevance: "direct",
        sourceEndCodePoint: source.sourceEndCodePoint,
        sourceRef: source.sourceRef,
        sourceStartCodePoint: 19,
        turnId: source.turnId,
      },
    ]);
    expect(firstRuntime.request?.runId).not.toBe(secondRuntime.request?.runId);
  });

  it("changes the runId when only a valid split source range changes", async () => {
    const repeatedBlock = block("same same");
    const source = repeatedBlock.turns[0];
    if (source === undefined) {
      throw new Error("missing fixture turn");
    }
    const firstRuntime = new RuntimeFake();
    firstRuntime.output = {
      claims: [],
      reviewedEvidenceIds: ["evidence-000001"],
      status: "no_match",
    };
    const secondRuntime = new RuntimeFake();
    secondRuntime.output = firstRuntime.output;

    await adapter(firstRuntime).extract({
      analysisTurns: [{
        ...source,
        sourceEndCodePoint: 4,
        sourceStartCodePoint: 0,
        text: "same",
      }],
      block: repeatedBlock,
      question: "What was repeated?",
    });
    await adapter(secondRuntime).extract({
      analysisTurns: [{
        ...source,
        sourceEndCodePoint: 9,
        sourceStartCodePoint: 5,
        text: "same",
      }],
      block: repeatedBlock,
      question: "What was repeated?",
    });

    expect(firstRuntime.request?.runId).not.toBe(secondRuntime.request?.runId);
  });

  it("rejects a provider attempt to cite an excluded canonical overlap turn", async () => {
    const runtime = new RuntimeFake();
    runtime.output = {
      claims: [{ evidenceIds: ["evidence-000002"], relevance: "direct" }],
      reviewedEvidenceIds: ["evidence-000001", "evidence-000002"],
      status: "claims",
    };
    const evidenceBlock = block();

    await expect(adapter(runtime).extract({
      analysisTurns: [evidenceBlock.turns[1]!],
      block: evidenceBlock,
      question: "List all decisions about Beta",
    })).rejects.toThrow("account for every local turn");
  });
});

describe("Meeting Knowledge semantic extraction failure contract", () => {
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

    const evidenceBlock = block();
    await expect(adapter(runtime).extract(extractionInput(
      evidenceBlock,
      "Was Project Zeta approved?",
    ))).resolves.toMatchObject({
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
    const evidenceBlock = block();
    await expect(adapter(unknown).extract(extractionInput(
      evidenceBlock,
      "List all decisions",
    ))).rejects.toThrow("account for every local turn");

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
    await expect(adapter(duplicate).extract(extractionInput(
      evidenceBlock,
      "List all decisions",
    ))).rejects.toThrow("malformed contract");

    const omitted = new RuntimeFake();
    omitted.output = {
      claims: [{ evidenceIds: ["evidence-000002"], relevance: "direct" }],
      reviewedEvidenceIds: ["evidence-000002", "evidence-000003"],
      status: "claims",
    };
    await expect(adapter(omitted).extract(extractionInput(
      evidenceBlock,
      "List all decisions",
    ))).rejects.toThrow("did not account for every local turn");

    const timeout = new RuntimeFake();
    timeout.transportError = new Error("synthetic timeout");
    await expect(adapter(timeout).extract(extractionInput(
      evidenceBlock,
      "List all decisions",
    ))).rejects.toThrow("transport failed");

    const oversized = new RuntimeFake();
    const oversizedBlock = block("x".repeat(16_384));
    await expect(adapter(oversized, 4_096).extract(extractionInput(
      oversizedBlock,
      "List all decisions",
    ))).rejects.toBeInstanceOf(CoverageExtractionCapacityError);
    expect(oversized.request).toBeUndefined();
  });

  it("propagates active cancellation to the subscription runtime", async () => {
    const runtime = new RuntimeFake();
    const controller = new AbortController();
    const evidenceBlock = block();
    await adapter(runtime).extract({
      ...extractionInput(evidenceBlock, "List all decisions"),
      signal: controller.signal,
    });
    expect(runtime.signal).toBe(controller.signal);
  });
});
