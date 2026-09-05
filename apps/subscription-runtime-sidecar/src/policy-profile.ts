import {
  canonicalJsonSha256,
  conversationAnswerPolicyVersion,
  focusedEvidenceSelectorJsonSchema,
  incrementalMeetingSummaryPolicyVersion,
  knowledgeAnswerPolicyVersion,
  knowledgeCoveragePolicyVersion,
  knowledgeEvidenceSelectorPolicyVersion,
  meetingSummaryPolicyVersion,
  providerConversationAnswerJsonSchema,
  providerIncrementalMeetingSummaryJsonSchema,
  providerKnowledgeAnswerJsonSchema,
  providerKnowledgeCoverageExtractJsonSchema,
  providerMeetingSummaryJsonSchema,
  subscriptionRuntimeConversationModel,
  subscriptionRuntimeConversationPurpose,
  subscriptionRuntimeConversationReasoningEffort,
  subscriptionRuntimeDefaultServiceTier,
  subscriptionRuntimeIncrementalModel,
  subscriptionRuntimeIncrementalPurpose,
  subscriptionRuntimeIncrementalReasoningEffort,
  subscriptionRuntimeKnowledgeAnswerPurpose,
  subscriptionRuntimeKnowledgeCoveragePurpose,
  subscriptionRuntimeKnowledgeEvidenceSelectorPurpose,
  subscriptionRuntimeModel,
  subscriptionRuntimeProfileForPurpose,
  subscriptionRuntimePurpose,
  subscriptionRuntimeReasoningEffort,
  type SubscriptionRuntimeAgentTaskRequest,
} from "@discord-meeting/subscription-runtime-adapter";
import { z } from "zod";

import { applicationName } from "./constants.js";
import { RequestPolicyError } from "./policy-error.js";
import {
  canonicalRequestSchema,
  conversationContextMetadataSchema,
  conversationTransportMetadataSchema,
  finalContextMetadataSchema,
  finalTransportMetadataSchema,
  incrementalContextMetadataSchema,
  incrementalTransportMetadataSchema,
  knowledgeAnswerContextMetadataSchema,
  knowledgeAnswerTransportMetadataSchema,
  knowledgeCoverageContextMetadataSchema,
  knowledgeCoverageTransportMetadataSchema,
  knowledgeEvidenceSelectorContextMetadataSchema,
  knowledgeEvidenceSelectorTransportMetadataSchema,
} from "./policy-schemas.js";

interface PolicyParser {
  <T>(schema: z.ZodType<T>, value: unknown): T;
}

export function reconstructProfileMetadata(
  purpose: string,
  metadata: unknown,
  parseWithPolicy: PolicyParser,
): {
  readonly context: SubscriptionRuntimeAgentTaskRequest["context"]["metadata"];
  readonly task: SubscriptionRuntimeAgentTaskRequest["task"]["metadata"];
} {
  if (purpose === subscriptionRuntimePurpose) {
    const parsed = parseWithPolicy(finalTransportMetadataSchema, metadata);
    return {
      context: {
        meetingId: parsed.meetingId,
        policyVersion: meetingSummaryPolicyVersion,
        transcriptId: parsed.transcriptId,
        transcriptVersion: parsed.transcriptVersion,
      },
      task: fixedTaskMetadata(
        subscriptionRuntimeModel,
        meetingSummaryPolicyVersion,
        subscriptionRuntimeReasoningEffort,
      ),
    };
  }
  if (purpose === subscriptionRuntimeIncrementalPurpose) {
    const parsed = parseWithPolicy(incrementalTransportMetadataSchema, metadata);
    return {
      context: {
        meetingId: parsed.meetingId,
        policyVersion: incrementalMeetingSummaryPolicyVersion,
        summaryRevision: parsed.summaryRevision,
        throughTurnCount: parsed.throughTurnCount,
      },
      task: fixedTaskMetadata(
        subscriptionRuntimeIncrementalModel,
        incrementalMeetingSummaryPolicyVersion,
        subscriptionRuntimeIncrementalReasoningEffort,
      ),
    };
  }
  if (purpose === subscriptionRuntimeConversationPurpose) {
    const parsed = parseWithPolicy(conversationTransportMetadataSchema, metadata);
    return {
      context: {
        locale: parsed.locale,
        meetingId: parsed.meetingId,
        policyVersion: conversationAnswerPolicyVersion,
        recordingId: parsed.recordingId,
        turnId: parsed.turnId,
      },
      task: fixedTaskMetadata(
        subscriptionRuntimeConversationModel,
        conversationAnswerPolicyVersion,
        subscriptionRuntimeConversationReasoningEffort,
      ),
    };
  }
  if (purpose === subscriptionRuntimeKnowledgeAnswerPurpose) {
    const parsed = parseWithPolicy(knowledgeAnswerTransportMetadataSchema, metadata);
    return {
      context: {
        locale: parsed.locale,
        meetingId: parsed.meetingId,
        policyVersion: knowledgeAnswerPolicyVersion,
        transcriptId: parsed.transcriptId,
        transcriptVersion: parsed.transcriptVersion,
      },
      task: fixedTaskMetadata(
        subscriptionRuntimeModel,
        knowledgeAnswerPolicyVersion,
        subscriptionRuntimeReasoningEffort,
        subscriptionRuntimeDefaultServiceTier,
      ),
    };
  }
  if (
    purpose === subscriptionRuntimeKnowledgeCoveragePurpose ||
    purpose === subscriptionRuntimeKnowledgeEvidenceSelectorPurpose
  ) {
    const parsed = purpose === subscriptionRuntimeKnowledgeCoveragePurpose
      ? parseWithPolicy(knowledgeCoverageTransportMetadataSchema, metadata)
      : parseWithPolicy(
          knowledgeEvidenceSelectorTransportMetadataSchema,
          metadata,
        );
    const policyVersion = purpose === subscriptionRuntimeKnowledgeCoveragePurpose
      ? knowledgeCoveragePolicyVersion
      : knowledgeEvidenceSelectorPolicyVersion;
    return {
      context: {
        meetingId: parsed.meetingId,
        policyVersion,
        transcriptId: parsed.transcriptId,
        transcriptVersion: parsed.transcriptVersion,
      },
      task: fixedTaskMetadata(
        subscriptionRuntimeModel,
        policyVersion,
        subscriptionRuntimeReasoningEffort,
      ),
    };
  }
  throw new RequestPolicyError("request purpose is not admitted");
}

export function assertCanonicalProfile(
  request: z.infer<typeof canonicalRequestSchema>,
  parseWithPolicy: PolicyParser,
): void {
  const profile = subscriptionRuntimeProfileForPurpose(request.context.purpose);
  if (
    profile === undefined ||
    request.context.metadata.policyVersion !== profile.policyVersion ||
    valuesDiffer(request.task.controls.maxOutputTokens, profile.maxOutputTokens) ||
    valuesDiffer(request.task.controls.model, profile.model) ||
    valuesDiffer(request.task.controls.reasoningEffort, profile.reasoningEffort) ||
    request.task.controls.serviceTier !== optionalServiceTier(profile) ||
    request.task.controls.outputSchemaName !== profile.outputSchemaName ||
    valuesDiffer(request.task.metadata.model, profile.model) ||
    request.task.metadata.policyVersion !== profile.policyVersion ||
    valuesDiffer(request.task.metadata.reasoningEffort, profile.reasoningEffort) ||
    optionalServiceTier(request.task.metadata) !== optionalServiceTier(profile) ||
    request.task.outputSchemaName !== profile.outputSchemaName
  ) {
    throw new RequestPolicyError("canonical request profile is not admitted");
  }
  const commonMetadata = {
    application: applicationName,
    executionProfile: request.task.metadata.executionProfile,
    meetingId: request.context.metadata.meetingId,
    model: request.task.metadata.model,
    policyVersion: request.task.metadata.policyVersion,
    reasoningEffort: request.task.metadata.reasoningEffort,
    runtimeOutput: request.task.metadata.runtimeOutput,
    ...("serviceTier" in request.task.metadata
      ? { serviceTier: request.task.metadata.serviceTier }
      : {}),
    toolsDisabled: request.task.metadata.toolsDisabled,
  };
  if (request.context.purpose === subscriptionRuntimePurpose) {
    const metadata = parseWithPolicy(finalContextMetadataSchema, request.context.metadata);
    reconstructProfileMetadata(request.context.purpose, {
      ...commonMetadata,
      transcriptId: metadata.transcriptId,
      transcriptVersion: metadata.transcriptVersion,
    }, parseWithPolicy);
    return;
  }
  if (request.context.purpose === subscriptionRuntimeConversationPurpose) {
    const metadata = parseWithPolicy(conversationContextMetadataSchema, request.context.metadata);
    reconstructProfileMetadata(request.context.purpose, {
      ...commonMetadata,
      locale: metadata.locale,
      recordingId: metadata.recordingId,
      turnId: metadata.turnId,
    }, parseWithPolicy);
    return;
  }
  if (request.context.purpose === subscriptionRuntimeKnowledgeAnswerPurpose) {
    const metadata = parseWithPolicy(
      knowledgeAnswerContextMetadataSchema,
      request.context.metadata,
    );
    reconstructProfileMetadata(request.context.purpose, {
      ...commonMetadata,
      locale: metadata.locale,
      transcriptId: metadata.transcriptId,
      transcriptVersion: metadata.transcriptVersion,
    }, parseWithPolicy);
    return;
  }
  if (
    request.context.purpose === subscriptionRuntimeKnowledgeCoveragePurpose ||
    request.context.purpose === subscriptionRuntimeKnowledgeEvidenceSelectorPurpose
  ) {
    const metadata =
      request.context.purpose === subscriptionRuntimeKnowledgeCoveragePurpose
        ? parseWithPolicy(
            knowledgeCoverageContextMetadataSchema,
            request.context.metadata,
          )
        : parseWithPolicy(
            knowledgeEvidenceSelectorContextMetadataSchema,
            request.context.metadata,
          );
    reconstructProfileMetadata(request.context.purpose, {
      ...commonMetadata,
      transcriptId: metadata.transcriptId,
      transcriptVersion: metadata.transcriptVersion,
    }, parseWithPolicy);
    return;
  }
  const metadata = parseWithPolicy(incrementalContextMetadataSchema, request.context.metadata);
  reconstructProfileMetadata(request.context.purpose, {
    ...commonMetadata,
    summaryRevision: metadata.summaryRevision,
    throughTurnCount: metadata.throughTurnCount,
  }, parseWithPolicy);
}

export function assertExactOutputSchema(
  value: Record<string, unknown>,
  purpose: string,
): void {
  const expectedSchema = purpose === subscriptionRuntimePurpose
    ? providerMeetingSummaryJsonSchema
    : purpose === subscriptionRuntimeIncrementalPurpose
      ? providerIncrementalMeetingSummaryJsonSchema
      : purpose === subscriptionRuntimeConversationPurpose
        ? providerConversationAnswerJsonSchema
        : purpose === subscriptionRuntimeKnowledgeAnswerPurpose
          ? providerKnowledgeAnswerJsonSchema
          : purpose === subscriptionRuntimeKnowledgeCoveragePurpose
            ? providerKnowledgeCoverageExtractJsonSchema
            : purpose === subscriptionRuntimeKnowledgeEvidenceSelectorPurpose
              ? focusedEvidenceSelectorJsonSchema
              : undefined;
  if (
    expectedSchema === undefined ||
    canonicalJsonSha256(value) !== canonicalJsonSha256(expectedSchema)
  ) {
    throw new RequestPolicyError("task output schema is not admitted");
  }
}

function fixedTaskMetadata(
  model: SubscriptionRuntimeAgentTaskRequest["task"]["metadata"]["model"],
  policyVersion: SubscriptionRuntimeAgentTaskRequest["task"]["metadata"]["policyVersion"],
  reasoningEffort: SubscriptionRuntimeAgentTaskRequest["task"]["metadata"]["reasoningEffort"],
  serviceTier?: typeof subscriptionRuntimeDefaultServiceTier,
): SubscriptionRuntimeAgentTaskRequest["task"]["metadata"] {
  return {
    executionProfile: "stateless-completion",
    model,
    policyVersion,
    reasoningEffort,
    runtimeOutput: "structured_output",
    ...(serviceTier === undefined ? {} : { serviceTier }),
    toolsDisabled: "true",
  };
}

function valuesDiffer<T extends number | string>(actual: T, expected: T): boolean {
  return actual !== expected;
}

function optionalServiceTier(value: object): string | undefined {
  return "serviceTier" in value && typeof value.serviceTier === "string"
    ? value.serviceTier
    : undefined;
}
