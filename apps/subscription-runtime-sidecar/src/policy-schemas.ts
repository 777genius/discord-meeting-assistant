import {
  conversationAnswerOutputSchemaName,
  conversationAnswerPolicyVersion,
  incrementalMeetingSummaryOutputSchemaName,
  incrementalMeetingSummaryPolicyVersion,
  knowledgeAnswerOutputSchemaName,
  knowledgeAnswerPolicyVersion,
  knowledgeCoverageOutputSchemaName,
  knowledgeCoveragePolicyVersion,
  meetingSummaryOutputSchemaName,
  meetingSummaryPolicyVersion,
  subscriptionRuntimeConversationModel,
  subscriptionRuntimeConversationPurpose,
  subscriptionRuntimeConversationReasoningEffort,
  subscriptionRuntimeIncrementalModel,
  subscriptionRuntimeIncrementalPurpose,
  subscriptionRuntimeIncrementalReasoningEffort,
  subscriptionRuntimeKnowledgeAnswerPurpose,
  subscriptionRuntimeKnowledgeCoveragePurpose,
  subscriptionRuntimeModel,
  subscriptionRuntimeProtocolVersion,
  subscriptionRuntimePurpose,
  subscriptionRuntimeReasoningEffort,
} from "@discord-meeting/subscription-runtime-adapter";
import { z } from "zod";

import {
  applicationName,
  grpcProviderCodex,
  providerInstanceId,
  tenantId,
} from "./constants.js";

const nonEmptyText = z.string().trim().min(1).max(1_024);
export const jsonObjectSchema = z.record(z.string(), z.unknown());

export const controlsSchema = z
  .object({
    allowedTools: z.array(z.never()).length(0),
    disableTools: z.literal(true),
    executionProfile: z.literal("stateless-completion"),
    interactive: z.literal(false),
    maxOutputTokens: z.number().int().min(256).max(32_768),
    maxTurns: z.literal(1),
    model: z.union([
      z.literal(subscriptionRuntimeModel),
      z.literal(subscriptionRuntimeIncrementalModel),
      z.literal(subscriptionRuntimeConversationModel),
    ]),
    outputKind: z.literal("structured_output"),
    outputSchema: jsonObjectSchema,
    outputSchemaName: z.union([
      z.literal(meetingSummaryOutputSchemaName),
      z.literal(incrementalMeetingSummaryOutputSchemaName),
      z.literal(conversationAnswerOutputSchemaName),
      z.literal(knowledgeAnswerOutputSchemaName),
      z.literal(knowledgeCoverageOutputSchemaName),
    ]),
    permissionMode: z.literal("read-only"),
    reasoningEffort: z.union([
      z.literal(subscriptionRuntimeReasoningEffort),
      z.literal(subscriptionRuntimeIncrementalReasoningEffort),
      z.literal(subscriptionRuntimeConversationReasoningEffort),
    ]),
    responseFormat: z.literal("json"),
    runtimeOutput: z.literal("structured_output"),
    selectedOutputKind: z.literal("structured_output"),
  })
  .strict();

export const finalTransportMetadataSchema = z
  .object({
    application: z.literal(applicationName),
    executionProfile: z.literal("stateless-completion"),
    meetingId: nonEmptyText,
    model: z.literal(subscriptionRuntimeModel),
    policyVersion: z.literal(meetingSummaryPolicyVersion),
    reasoningEffort: z.literal(subscriptionRuntimeReasoningEffort),
    runtimeOutput: z.literal("structured_output"),
    toolsDisabled: z.literal("true"),
    transcriptId: nonEmptyText,
    transcriptVersion: nonEmptyText,
  })
  .strict();

export const incrementalTransportMetadataSchema = z
  .object({
    application: z.literal(applicationName),
    executionProfile: z.literal("stateless-completion"),
    meetingId: nonEmptyText,
    model: z.literal(subscriptionRuntimeIncrementalModel),
    policyVersion: z.literal(incrementalMeetingSummaryPolicyVersion),
    reasoningEffort: z.literal(subscriptionRuntimeIncrementalReasoningEffort),
    runtimeOutput: z.literal("structured_output"),
    summaryRevision: nonEmptyText,
    throughTurnCount: nonEmptyText,
    toolsDisabled: z.literal("true"),
  })
  .strict();

export const conversationTransportMetadataSchema = z
  .object({
    application: z.literal(applicationName),
    executionProfile: z.literal("stateless-completion"),
    locale: nonEmptyText,
    meetingId: nonEmptyText,
    model: z.literal(subscriptionRuntimeConversationModel),
    policyVersion: z.literal(conversationAnswerPolicyVersion),
    reasoningEffort: z.literal(subscriptionRuntimeConversationReasoningEffort),
    recordingId: nonEmptyText,
    runtimeOutput: z.literal("structured_output"),
    toolsDisabled: z.literal("true"),
    turnId: nonEmptyText,
  })
  .strict();

export const knowledgeAnswerTransportMetadataSchema = z
  .object({
    application: z.literal(applicationName),
    executionProfile: z.literal("stateless-completion"),
    locale: nonEmptyText,
    meetingId: nonEmptyText,
    model: z.literal(subscriptionRuntimeModel),
    policyVersion: z.literal(knowledgeAnswerPolicyVersion),
    reasoningEffort: z.literal(subscriptionRuntimeReasoningEffort),
    runtimeOutput: z.literal("structured_output"),
    toolsDisabled: z.literal("true"),
    transcriptId: nonEmptyText,
    transcriptVersion: nonEmptyText,
  })
  .strict();

export const knowledgeCoverageTransportMetadataSchema = z
  .object({
    application: z.literal(applicationName),
    executionProfile: z.literal("stateless-completion"),
    meetingId: nonEmptyText,
    model: z.literal(subscriptionRuntimeModel),
    policyVersion: z.literal(knowledgeCoveragePolicyVersion),
    reasoningEffort: z.literal(subscriptionRuntimeReasoningEffort),
    runtimeOutput: z.literal("structured_output"),
    toolsDisabled: z.literal("true"),
    transcriptId: nonEmptyText,
    transcriptVersion: nonEmptyText,
  })
  .strict();

const transportMetadataSchema = z.union([
  finalTransportMetadataSchema,
  incrementalTransportMetadataSchema,
  conversationTransportMetadataSchema,
  knowledgeAnswerTransportMetadataSchema,
  knowledgeCoverageTransportMetadataSchema,
]);

export const finalContextMetadataSchema = z
  .object({
    meetingId: nonEmptyText,
    policyVersion: z.literal(meetingSummaryPolicyVersion),
    transcriptId: nonEmptyText,
    transcriptVersion: nonEmptyText,
  })
  .strict();

export const incrementalContextMetadataSchema = z
  .object({
    meetingId: nonEmptyText,
    policyVersion: z.literal(incrementalMeetingSummaryPolicyVersion),
    summaryRevision: nonEmptyText,
    throughTurnCount: nonEmptyText,
  })
  .strict();

export const conversationContextMetadataSchema = z
  .object({
    locale: nonEmptyText,
    meetingId: nonEmptyText,
    policyVersion: z.literal(conversationAnswerPolicyVersion),
    recordingId: nonEmptyText,
    turnId: nonEmptyText,
  })
  .strict();

export const knowledgeAnswerContextMetadataSchema = z
  .object({
    locale: nonEmptyText,
    meetingId: nonEmptyText,
    policyVersion: z.literal(knowledgeAnswerPolicyVersion),
    transcriptId: nonEmptyText,
    transcriptVersion: nonEmptyText,
  })
  .strict();

export const knowledgeCoverageContextMetadataSchema = z
  .object({
    meetingId: nonEmptyText,
    policyVersion: z.literal(knowledgeCoveragePolicyVersion),
    transcriptId: nonEmptyText,
    transcriptVersion: nonEmptyText,
  })
  .strict();

const contextMetadataSchema = z.union([
  finalContextMetadataSchema,
  incrementalContextMetadataSchema,
  conversationContextMetadataSchema,
  knowledgeAnswerContextMetadataSchema,
  knowledgeCoverageContextMetadataSchema,
]);

const canonicalTaskMetadataSchema = z.union([
  finalTransportMetadataSchema.omit({ application: true, meetingId: true, transcriptId: true, transcriptVersion: true }),
  incrementalTransportMetadataSchema.omit({ application: true, meetingId: true, summaryRevision: true, throughTurnCount: true }),
  conversationTransportMetadataSchema.omit({ application: true, locale: true, meetingId: true, recordingId: true, turnId: true }),
  knowledgeAnswerTransportMetadataSchema.omit({ application: true, locale: true, meetingId: true, transcriptId: true, transcriptVersion: true }),
  knowledgeCoverageTransportMetadataSchema.omit({ application: true, meetingId: true, transcriptId: true, transcriptVersion: true }),
]);

export const canonicalRequestSchema = z
  .object({
    context: z
      .object({
        application: z.literal(applicationName),
        correlationId: nonEmptyText,
        metadata: contextMetadataSchema,
        purpose: z.union([
          z.literal(subscriptionRuntimePurpose),
          z.literal(subscriptionRuntimeIncrementalPurpose),
          z.literal(subscriptionRuntimeConversationPurpose),
          z.literal(subscriptionRuntimeKnowledgeAnswerPurpose),
          z.literal(subscriptionRuntimeKnowledgeCoveragePurpose),
        ]),
      })
      .strict(),
    cwd: z.string().min(1),
    protocolVersion: z.literal(subscriptionRuntimeProtocolVersion),
    runId: nonEmptyText,
    task: z
      .object({
        controls: controlsSchema,
        kind: z.literal("structured-prompt"),
        metadata: canonicalTaskMetadataSchema,
        outputSchemaName: z.union([
          z.literal(meetingSummaryOutputSchemaName),
          z.literal(incrementalMeetingSummaryOutputSchemaName),
          z.literal(conversationAnswerOutputSchemaName),
          z.literal(knowledgeAnswerOutputSchemaName),
          z.literal(knowledgeCoverageOutputSchemaName),
        ]),
        prompt: z.string().min(1),
        systemPrompt: z.string().min(1),
      })
      .strict(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();

export const rawGrpcRequestSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(subscriptionRuntimeProtocolVersion),
      z.literal(String(subscriptionRuntimeProtocolVersion)),
    ]),
    requestId: nonEmptyText,
    tenantId: z.literal(tenantId),
    workspaceId: nonEmptyText,
    correlationId: nonEmptyText,
    provider: z.union([z.literal(grpcProviderCodex), z.literal("1"), z.literal(1)]),
    providerInstanceId: z.literal(providerInstanceId),
    purpose: z.union([
      z.literal(subscriptionRuntimePurpose),
      z.literal(subscriptionRuntimeIncrementalPurpose),
      z.literal(subscriptionRuntimeConversationPurpose),
      z.literal(subscriptionRuntimeKnowledgeAnswerPurpose),
      z.literal(subscriptionRuntimeKnowledgeCoveragePurpose),
    ]),
    systemPrompt: z.string().min(1),
    prompt: z.string().min(1),
    outputSchemaJson: z.string().min(2),
    controlsJson: z.string().min(2),
    timeoutMs: z.number().int().positive(),
    cwd: z.string().min(1),
    metadata: transportMetadataSchema,
  })
  .strict();
