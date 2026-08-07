import {
  buildSubscriptionRuntimeConversationRequest,
  buildSubscriptionRuntimeIncrementalSummaryRequest,
  buildSubscriptionRuntimeSummaryRequest,
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
