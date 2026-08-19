import {
  canonicalJsonSha256,
  conversationAnswerOutputSchemaName,
  conversationAnswerPolicyVersion,
  incrementalMeetingSummaryOutputSchemaName,
  meetingSummaryOutputSchemaName,
  meetingSummaryPolicyVersion,
  providerConversationAnswerJsonSchema,
  providerIncrementalMeetingSummaryJsonSchema,
  providerKnowledgeAnswerJsonSchema,
  providerKnowledgeCoverageExtractJsonSchema,
  providerMeetingSummaryJsonSchema,
} from "@discord-meeting/subscription-runtime-adapter";
import { describe, expect, it } from "vitest";

import { reconstructCanonicalRequest } from "../src/policy.js";
import {
  canonicalRequest,
  conversationCanonicalRequest,
  grpcRequest,
  incrementalCanonicalRequest,
  isolatedCwd,
  knowledgeAnswerCanonicalRequest,
  knowledgeCoverageCanonicalRequest,
} from "./fixture.js";

const options = {
  isolatedCwd,
  maxPromptBytes: 2 * 1_024 * 1_024,
  maxTaskTimeoutMs: 600_000,
};

describe("subscription runtime request policy", () => {
  it("reconstructs the consumer-owned nested request without semantic drift", () => {
    const reconstructed = reconstructCanonicalRequest(grpcRequest(), options);

    expect(reconstructed).toEqual(canonicalRequest);
    expect(canonicalJsonSha256(reconstructed)).toBe(
      canonicalJsonSha256(canonicalRequest),
    );
    expect(reconstructed.task.controls).toMatchObject({
      maxOutputTokens: 8_192,
      model: "gpt-5.6-sol",
      outputSchemaName: meetingSummaryOutputSchemaName,
      reasoningEffort: "medium",
    });
    expect(reconstructed.context.metadata.policyVersion).toBe(
      meetingSummaryPolicyVersion,
    );
    expect(reconstructed.task.controls.outputSchema).toEqual(
      providerMeetingSummaryJsonSchema,
    );
  });

  it("reconstructs only the exact incremental Luna low 2048-token profile", () => {
    const reconstructed = reconstructCanonicalRequest(
      grpcRequest(incrementalCanonicalRequest),
      options,
    );

    expect(reconstructed).toEqual(incrementalCanonicalRequest);
    expect(reconstructed.context.purpose).toBe("discord_meeting.summary.incremental");
    expect(reconstructed.context.metadata.policyVersion).toBe(
      "meeting-summary.incremental.subscription-runtime.v7",
    );
    expect(reconstructed.task.controls).toMatchObject({
      maxOutputTokens: 2_048,
      model: "gpt-5.6-luna",
      outputSchemaName: incrementalMeetingSummaryOutputSchemaName,
      reasoningEffort: "low",
    });
    expect(reconstructed.task.controls.outputSchema).toEqual(
      providerIncrementalMeetingSummaryJsonSchema,
    );
  });

  it("reconstructs only the exact conversation Luna low 512-token profile", () => {
    const reconstructed = reconstructCanonicalRequest(
      grpcRequest(conversationCanonicalRequest),
      options,
    );

    expect(reconstructed).toEqual(conversationCanonicalRequest);
    expect(canonicalJsonSha256(reconstructed)).toBe(
      canonicalJsonSha256(conversationCanonicalRequest),
    );
    expect(reconstructed.context).toMatchObject({
      metadata: {
        locale: "auto",
        policyVersion: conversationAnswerPolicyVersion,
        recordingId: "recording-1",
        turnId: "turn-3",
      },
      purpose: "discord_meeting.conversation.answer",
    });
    expect(reconstructed.task.controls).toMatchObject({
      allowedTools: [],
      disableTools: true,
      executionProfile: "stateless-completion",
      maxOutputTokens: 512,
      model: "gpt-5.6-luna",
      outputSchemaName: conversationAnswerOutputSchemaName,
      reasoningEffort: "low",
    });
    expect(reconstructed.task.controls.outputSchema).toEqual(
      providerConversationAnswerJsonSchema,
    );
  });

  it("reconstructs only the two dedicated Sol/medium knowledge profiles", () => {
    const answer = reconstructCanonicalRequest(
      grpcRequest(knowledgeAnswerCanonicalRequest),
      options,
    );
    const coverage = reconstructCanonicalRequest(
      grpcRequest(knowledgeCoverageCanonicalRequest),
      options,
    );

    expect(answer).toEqual(knowledgeAnswerCanonicalRequest);
    expect(answer.context).toMatchObject({
      metadata: { locale: "en" },
      purpose: "discord_meeting.knowledge.answer.v1",
    });
    expect(answer.task.controls).toMatchObject({
      maxOutputTokens: 2_048,
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    expect(answer.task.controls.outputSchema).toEqual(
      providerKnowledgeAnswerJsonSchema,
    );
    expect(coverage).toEqual(knowledgeCoverageCanonicalRequest);
    expect(coverage.context.purpose).toBe(
      "discord_meeting.knowledge.coverage_extract.v1",
    );
    expect(coverage.task.controls.outputSchema).toEqual(
      providerKnowledgeCoverageExtractJsonSchema,
    );
  });

  it.each([
    ["unknown purpose", { purpose: "discord_meeting.other" }],
    ["wrong provider", { provider: "AGENT_RUNTIME_PROVIDER_CLAUDE" }],
    ["wrong workspace", { workspaceId: "meeting-other" }],
    ["non-isolated cwd", { cwd: "/tmp" }],
  ])("rejects %s before execution", (_label, override) => {
    expect(() =>
      reconstructCanonicalRequest({ ...grpcRequest(), ...override }, options),
    ).toThrow();
  });

  it("rejects conflicting controls and JSON schema", () => {
    const request = grpcRequest();
    const controls = JSON.parse(String(request.controlsJson)) as Record<
      string,
      unknown
    >;
    controls.model = "gpt-other";
    expect(() =>
      reconstructCanonicalRequest(
        { ...request, controlsJson: JSON.stringify(controls) },
        options,
      ),
    ).toThrow("policy");

    expect(() =>
      reconstructCanonicalRequest(
        { ...request, outputSchemaJson: '{"type":"string"}' },
        options,
      ),
    ).toThrow("output schema");
  });

  it("rejects purpose/metadata profile mismatches before execution", () => {
    const request = grpcRequest(incrementalCanonicalRequest);

    expect(() => reconstructCanonicalRequest(
      { ...request, purpose: "discord_meeting.summary.generate" },
      options,
    )).toThrow("output schema");
  });

  it("rejects swapped final and incremental output schemas before execution", () => {
    const incremental = grpcRequest(incrementalCanonicalRequest);
    const incrementalControls = JSON.parse(String(incremental.controlsJson)) as Record<
      string,
      unknown
    >;
    incrementalControls.outputSchema = providerMeetingSummaryJsonSchema;
    incrementalControls.outputSchemaName = "discord_meeting_summary_v4";
    expect(() => reconstructCanonicalRequest(
      {
        ...incremental,
        controlsJson: JSON.stringify(incrementalControls),
        outputSchemaJson: JSON.stringify(providerMeetingSummaryJsonSchema),
      },
      options,
    )).toThrow("output schema");

    const final = grpcRequest(canonicalRequest);
    const finalControls = JSON.parse(String(final.controlsJson)) as Record<
      string,
      unknown
    >;
    finalControls.outputSchema = providerIncrementalMeetingSummaryJsonSchema;
    finalControls.outputSchemaName = incrementalMeetingSummaryOutputSchemaName;
    expect(() => reconstructCanonicalRequest(
      {
        ...final,
        controlsJson: JSON.stringify(finalControls),
        outputSchemaJson: JSON.stringify(providerIncrementalMeetingSummaryJsonSchema),
      },
      options,
    )).toThrow("output schema");
  });

  it("rejects conversation profile and schema swaps before execution", () => {
    const conversation = grpcRequest(conversationCanonicalRequest);
    const profileControls = JSON.parse(String(conversation.controlsJson)) as Record<
      string,
      unknown
    >;
    profileControls.model = "gpt-5.6-sol";
    expect(() => reconstructCanonicalRequest(
      { ...conversation, controlsJson: JSON.stringify(profileControls) },
      options,
    )).toThrow("profile");

    const schemaControls = JSON.parse(String(conversation.controlsJson)) as Record<
      string,
      unknown
    >;
    schemaControls.outputSchema = providerIncrementalMeetingSummaryJsonSchema;
    schemaControls.outputSchemaName = incrementalMeetingSummaryOutputSchemaName;
    expect(() => reconstructCanonicalRequest(
      {
        ...conversation,
        controlsJson: JSON.stringify(schemaControls),
        outputSchemaJson: JSON.stringify(providerIncrementalMeetingSummaryJsonSchema),
      },
      options,
    )).toThrow("output schema");
  });

  it("rejects answer/coverage profile and schema swaps before execution", () => {
    const answer = grpcRequest(knowledgeAnswerCanonicalRequest);
    const controls = JSON.parse(String(answer.controlsJson)) as Record<string, unknown>;
    controls.outputSchema = providerKnowledgeCoverageExtractJsonSchema;
    controls.outputSchemaName = knowledgeCoverageCanonicalRequest.task.outputSchemaName;
    expect(() => reconstructCanonicalRequest({
      ...answer,
      controlsJson: JSON.stringify(controls),
      outputSchemaJson: JSON.stringify(providerKnowledgeCoverageExtractJsonSchema),
    }, options)).toThrow("output schema");
  });

  it("fails closed for stale incremental policy and output-budget profiles", () => {
    const request = grpcRequest(incrementalCanonicalRequest);
    const controls = JSON.parse(String(request.controlsJson)) as Record<string, unknown>;
    controls.maxOutputTokens = 4_096;
    expect(() => reconstructCanonicalRequest(
      { ...request, controlsJson: JSON.stringify(controls) },
      options,
    )).toThrow("profile");

    const swappedModelControls = JSON.parse(String(request.controlsJson)) as Record<string, unknown>;
    swappedModelControls.model = "gpt-5.6-sol";
    expect(() => reconstructCanonicalRequest(
      { ...request, controlsJson: JSON.stringify(swappedModelControls) },
      options,
    )).toThrow("profile");

    const metadata = request.metadata as Record<string, unknown>;
    expect(() => reconstructCanonicalRequest(
      {
        ...request,
        metadata: {
          ...metadata,
          policyVersion: "meeting-summary.incremental.subscription-runtime.v1",
        },
      },
      options,
    )).toThrow("policy");
  });
});
