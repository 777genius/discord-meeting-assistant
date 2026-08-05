import {
  buildSubscriptionRuntimeConversationRequest,
  canonicalJsonSha256,
  providerConversationAnswerJsonSchema,
  providerConversationAnswerSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const requestInput = {
  idempotencyKey: "conversation:meeting-1:turn-3",
  locale: "auto",
  meetingId: "meeting-1",
  prompt: "When is the next release?",
  recordingId: "recording-1",
  systemPrompt: "Answer briefly in the participant's language.",
  turnId: "turn-3",
} as const;

const requestOptions = {
  isolatedCwd: "/runtime/workspace",
  maxOutputTokens: 512,
  maxPromptBytes: 1_024 * 1_024,
  timeoutMs: 15_000,
} as const;

describe("subscription runtime conversation request contract", () => {
  it("is deterministic and pins the stateless no-tools Luna profile", () => {
    const first = buildSubscriptionRuntimeConversationRequest(
      requestInput,
      requestOptions,
    );
    const second = buildSubscriptionRuntimeConversationRequest(
      requestInput,
      requestOptions,
    );

    expect(second).toEqual(first);
    expect(canonicalJsonSha256(second)).toBe(canonicalJsonSha256(first));
    expect(first.runId).toMatch(/^conversation-answer-request-[0-9a-f]{32}$/u);
    expect(first.context).toEqual({
      application: "discord-meeting",
      correlationId: first.runId,
      metadata: {
        locale: "auto",
        meetingId: "meeting-1",
        policyVersion: "meeting-conversation.subscription-runtime.v1",
        recordingId: "recording-1",
        turnId: "turn-3",
      },
      purpose: "discord_meeting.conversation.answer",
    });
    expect(first.task.controls).toEqual({
      allowedTools: [],
      disableTools: true,
      executionProfile: "stateless-completion",
      interactive: false,
      maxOutputTokens: 512,
      maxTurns: 1,
      model: "gpt-5.6-luna",
      outputKind: "structured_output",
      outputSchema: providerConversationAnswerJsonSchema,
      outputSchemaName: "discord_meeting_conversation_answer_v1",
      permissionMode: "read-only",
      reasoningEffort: "low",
      responseFormat: "json",
      runtimeOutput: "structured_output",
      selectedOutputKind: "structured_output",
    });
    expect(first.task.metadata).toEqual({
      executionProfile: "stateless-completion",
      model: "gpt-5.6-luna",
      policyVersion: "meeting-conversation.subscription-runtime.v1",
      reasoningEffort: "low",
      runtimeOutput: "structured_output",
      toolsDisabled: "true",
    });
  });

  it("keeps the answer schema strict at one through 2,000 characters", () => {
    expect(providerConversationAnswerSchema.safeParse({ answer: "x" }).success).toBe(true);
    expect(
      providerConversationAnswerSchema.safeParse({ answer: "x".repeat(2_000) }).success,
    ).toBe(true);
    expect(providerConversationAnswerSchema.safeParse({ answer: " " }).success).toBe(false);
    expect(
      providerConversationAnswerSchema.safeParse({ answer: "x".repeat(2_001) }).success,
    ).toBe(false);
    expect(
      providerConversationAnswerSchema.safeParse({
        answer: "valid",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("rejects conversation inputs outside admitted bounds", () => {
    expect(() =>
      buildSubscriptionRuntimeConversationRequest(requestInput, {
        ...requestOptions,
        maxOutputTokens: 511,
      }),
    ).toThrow("maxOutputTokens must match the admitted conversation profile value 512");
    expect(() =>
      buildSubscriptionRuntimeConversationRequest(
        { ...requestInput, locale: " " },
        requestOptions,
      ),
    ).toThrow("locale is invalid");
    expect(() =>
      buildSubscriptionRuntimeConversationRequest(
        { ...requestInput, turnId: "x".repeat(129) },
        requestOptions,
      ),
    ).toThrow("turnId is invalid");
    expect(() =>
      buildSubscriptionRuntimeConversationRequest(
        { ...requestInput, prompt: "x".repeat(8_001) },
        requestOptions,
      ),
    ).toThrow("conversation prompt is invalid");
    expect(() =>
      buildSubscriptionRuntimeConversationRequest(requestInput, {
        ...requestOptions,
        maxPromptBytes: 1,
      }),
    ).toThrow("conversation prompt exceeds the configured byte limit");
  });
});
