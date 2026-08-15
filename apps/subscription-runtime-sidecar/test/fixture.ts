import {
  buildSubscriptionRuntimeConversationRequest,
  buildSubscriptionRuntimeIncrementalSummaryRequest,
  buildSubscriptionRuntimeSummaryRequest,
  knowledgeAnswerExecutionProfile,
  knowledgeCoverageExecutionProfile,
  providerKnowledgeAnswerJsonSchema,
  providerKnowledgeCoverageExtractJsonSchema,
  subscriptionRuntimeProtocolVersion,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
} from "@discord-meeting/subscription-runtime-adapter";

export const isolatedCwd = "/run/discord-meeting-subscription-runtime/workspace";

export const canonicalRequest = buildSubscriptionRuntimeSummaryRequest(
  {
    idempotencyKey: "meeting-1:transcript-1:policy-1",
    meetingId: "meeting-1",
    transcript: {
      recordingId: "recording-1",
      transcriptId: "transcript-1",
      turns: [
        {
          endMs: 2_000,
          speakerId: "speaker-1",
          startMs: 0,
          text: "Решили выпустить релиз в пятницу.",
          turnId: "turn-1",
        },
      ],
      version: 1,
    },
  },
  {
    isolatedCwd,
    maxOutputTokens: 8_192,
    maxPromptBytes: 2 * 1_024 * 1_024,
    timeoutMs: 10_000,
  },
);

export const structuredOutput: JsonObject = {
  actionItems: [],
  decisions: [
    {
      evidenceTurnIds: ["turn-1"],
      text: "Выпустить релиз в пятницу",
    },
  ],
  openQuestions: [],
  overview: "Команда согласовала выпуск.",
  title: "Выпуск релиза",
  topics: [
    {
      evidenceTurnIds: ["turn-1"],
      points: ["Релиз запланирован на пятницу"],
      title: "План релиза",
    },
  ],
};

export const incrementalCanonicalRequest = buildSubscriptionRuntimeIncrementalSummaryRequest(
  {
    idempotencyKey: "meeting-1:live-summary:2",
    knownSpeakerIds: ["speaker-1"],
    knownTurnIds: ["turn-1", "turn-2"],
    meetingId: "meeting-1",
    newTurns: [
      {
        endMs: 4_000,
        speakerId: "speaker-1",
        startMs: 2_000,
        text: "Я подготовлю релиз к пятнице.",
        turnId: "turn-2",
      },
    ],
    previousSummary: {
      actionItems: [],
      decisions: [
        {
          decisionId: "decision-1",
          evidenceTurnIds: ["turn-1"],
          text: "Выпустить релиз",
        },
      ],
      openQuestions: [],
      overview: "Команда согласовала релиз.",
      revision: 1,
      title: "Релиз",
      topics: [],
    },
    previousSummaryEvidenceTurns: [
      {
        endMs: 2_000,
        speakerId: "speaker-1",
        startMs: 0,
        text: "Решили выпустить релиз в пятницу.",
        turnId: "turn-1",
      },
    ],
    recentContextTurns: [],
    revision: 2,
    throughTurnCount: 2,
  },
  {
    isolatedCwd,
    maxOutputTokens: 2_048,
    maxPromptBytes: 2 * 1_024 * 1_024,
    maxRecentContextTurns: 256,
    timeoutMs: 10_000,
  },
);

export const conversationCanonicalRequest = buildSubscriptionRuntimeConversationRequest(
  {
    idempotencyKey: "conversation:meeting-1:turn-3",
    locale: "auto",
    meetingId: "meeting-1",
    prompt: "Ботик, когда следующий релиз?",
    recordingId: "recording-1",
    systemPrompt: "Answer briefly in the participant's language.",
    turnId: "turn-3",
  },
  {
    isolatedCwd,
    maxOutputTokens: 512,
    maxPromptBytes: 2 * 1_024 * 1_024,
    timeoutMs: 15_000,
  },
);

export const conversationStructuredOutput: JsonObject = {
  answer: "Следующий релиз запланирован на пятницу.",
};

export const knowledgeAnswerCanonicalRequest: SubscriptionRuntimeAgentTaskRequest = {
  context: {
    application: "discord-meeting",
    correlationId: "knowledge-answer-correlation-1",
    metadata: {
      locale: "en",
      meetingId: "a".repeat(64),
      policyVersion: knowledgeAnswerExecutionProfile.policyVersion,
      transcriptId: "a".repeat(64),
      transcriptVersion: "1",
    },
    purpose: knowledgeAnswerExecutionProfile.purpose,
  },
  cwd: isolatedCwd,
  protocolVersion: subscriptionRuntimeProtocolVersion,
  runId: "knowledge-answer-request-1",
  task: {
    controls: {
      allowedTools: [],
      disableTools: true,
      executionProfile: "stateless-completion",
      interactive: false,
      maxOutputTokens: knowledgeAnswerExecutionProfile.maxOutputTokens,
      maxTurns: 1,
      model: knowledgeAnswerExecutionProfile.model,
      outputKind: "structured_output",
      outputSchema: providerKnowledgeAnswerJsonSchema,
      outputSchemaName: knowledgeAnswerExecutionProfile.outputSchemaName,
      permissionMode: "read-only",
      reasoningEffort: knowledgeAnswerExecutionProfile.reasoningEffort,
      responseFormat: "json",
      runtimeOutput: "structured_output",
      selectedOutputKind: "structured_output",
    },
    kind: "structured-prompt",
    metadata: {
      executionProfile: "stateless-completion",
      model: knowledgeAnswerExecutionProfile.model,
      policyVersion: knowledgeAnswerExecutionProfile.policyVersion,
      reasoningEffort: knowledgeAnswerExecutionProfile.reasoningEffort,
      runtimeOutput: "structured_output",
      toolsDisabled: "true",
    },
    outputSchemaName: knowledgeAnswerExecutionProfile.outputSchemaName,
    prompt: JSON.stringify({
      evidence: [{ evidenceId: "evidence-000001", text: "Release is Monday." }],
      locale: "en",
      question: "When is the release?",
    }),
    systemPrompt: "Answer only from selected canonical evidence.",
  },
  timeoutMs: 180_000,
};

export const knowledgeCoverageCanonicalRequest: SubscriptionRuntimeAgentTaskRequest = {
  ...knowledgeAnswerCanonicalRequest,
  context: {
    ...knowledgeAnswerCanonicalRequest.context,
    correlationId: "knowledge-coverage-correlation-1",
    metadata: {
      meetingId: "a".repeat(64),
      policyVersion: knowledgeCoverageExecutionProfile.policyVersion,
      transcriptId: "a".repeat(64),
      transcriptVersion: "1",
    },
    purpose: knowledgeCoverageExecutionProfile.purpose,
  },
  runId: "knowledge-coverage-request-1",
  task: {
    ...knowledgeAnswerCanonicalRequest.task,
    controls: {
      ...knowledgeAnswerCanonicalRequest.task.controls,
      maxOutputTokens: knowledgeCoverageExecutionProfile.maxOutputTokens,
      model: knowledgeCoverageExecutionProfile.model,
      outputSchema: providerKnowledgeCoverageExtractJsonSchema,
      outputSchemaName: knowledgeCoverageExecutionProfile.outputSchemaName,
      reasoningEffort: knowledgeCoverageExecutionProfile.reasoningEffort,
    },
    metadata: {
      ...knowledgeAnswerCanonicalRequest.task.metadata,
      model: knowledgeCoverageExecutionProfile.model,
      policyVersion: knowledgeCoverageExecutionProfile.policyVersion,
      reasoningEffort: knowledgeCoverageExecutionProfile.reasoningEffort,
    },
    outputSchemaName: knowledgeCoverageExecutionProfile.outputSchemaName,
    prompt: JSON.stringify({ evidenceIds: ["evidence-000001"] }),
    systemPrompt: "Extract coverage only from selected canonical evidence.",
  },
};

export const knowledgeAnswerStructuredOutput: JsonObject = {
  claims: [{ evidenceIds: ["evidence-000001"], text: "Release is Monday." }],
  locale: "en",
  status: "answered",
};

export const knowledgeCoverageStructuredOutput: JsonObject = {
  claims: [{ evidenceIds: ["evidence-000001"], relevance: "direct" }],
  reviewedEvidenceIds: ["evidence-000001"],
  status: "claims",
};

export function grpcRequest(
  request: SubscriptionRuntimeAgentTaskRequest = canonicalRequest,
): Record<string, unknown> {
  return {
    schemaVersion: request.protocolVersion,
    requestId: request.runId,
    tenantId: "discord-meeting",
    workspaceId: request.context.metadata.meetingId,
    correlationId: request.context.correlationId,
    provider: "AGENT_RUNTIME_PROVIDER_CODEX",
    providerInstanceId: "discord-meeting-summary-v3",
    purpose: request.context.purpose,
    systemPrompt: request.task.systemPrompt,
    prompt: request.task.prompt,
    outputSchemaJson: JSON.stringify(request.task.controls.outputSchema),
    controlsJson: JSON.stringify(request.task.controls),
    timeoutMs: request.timeoutMs,
    cwd: request.cwd,
    metadata: {
      ...request.task.metadata,
      application: request.context.application,
      ...request.context.metadata,
    },
  };
}
