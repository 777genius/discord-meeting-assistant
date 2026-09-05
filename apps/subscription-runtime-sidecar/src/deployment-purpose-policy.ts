import {
  conversationAnswerOutputSchemaName,
  conversationAnswerPolicyVersion,
  incrementalMeetingSummaryOutputSchemaName,
  incrementalMeetingSummaryPolicyVersion,
  knowledgeAnswerOutputSchemaName,
  knowledgeAnswerPolicyVersion,
  knowledgeCoverageOutputSchemaName,
  knowledgeCoveragePolicyVersion,
  knowledgeEvidenceSelectorOutputSchemaName,
  knowledgeEvidenceSelectorPolicyVersion,
  meetingSummaryOutputSchemaName,
  meetingSummaryPolicyVersion,
  subscriptionRuntimeConversationMaxOutputTokens,
  subscriptionRuntimeConversationModel,
  subscriptionRuntimeConversationPurpose,
  subscriptionRuntimeConversationReasoningEffort,
  subscriptionRuntimeDefaultServiceTier,
  subscriptionRuntimeIncrementalMaxOutputTokens,
  subscriptionRuntimeIncrementalModel,
  subscriptionRuntimeIncrementalPurpose,
  subscriptionRuntimeIncrementalReasoningEffort,
  subscriptionRuntimeKnowledgeAnswerMaxOutputTokens,
  subscriptionRuntimeKnowledgeAnswerPurpose,
  subscriptionRuntimeKnowledgeCoverageMaxOutputTokens,
  subscriptionRuntimeKnowledgeCoveragePurpose,
  subscriptionRuntimeKnowledgeEvidenceSelectorMaxOutputTokens,
  subscriptionRuntimeKnowledgeEvidenceSelectorPurpose,
  subscriptionRuntimeModel,
  subscriptionRuntimePurpose,
  subscriptionRuntimeReasoningEffort,
  subscriptionRuntimeSummaryMaxOutputTokens,
} from "@discord-meeting/subscription-runtime-adapter";

interface DeploymentPurposeProfile {
  readonly isolatedCwd: string;
  readonly maxOutputTokens: number;
  readonly model: string;
  readonly outputSchemaName: string;
  readonly policyVersion: string;
  readonly reasoningEffort: string;
  readonly serviceTier?: string | undefined;
}

type PurposeProfiles = Readonly<Record<string, DeploymentPurposeProfile>>;

const expectedProfiles: PurposeProfiles = Object.freeze({
  [subscriptionRuntimeConversationPurpose]: Object.freeze({
    isolatedCwd: "",
    maxOutputTokens: subscriptionRuntimeConversationMaxOutputTokens,
    model: subscriptionRuntimeConversationModel,
    outputSchemaName: conversationAnswerOutputSchemaName,
    policyVersion: conversationAnswerPolicyVersion,
    reasoningEffort: subscriptionRuntimeConversationReasoningEffort,
  }),
  [subscriptionRuntimeKnowledgeAnswerPurpose]: Object.freeze({
    isolatedCwd: "",
    maxOutputTokens: subscriptionRuntimeKnowledgeAnswerMaxOutputTokens,
    model: subscriptionRuntimeModel,
    outputSchemaName: knowledgeAnswerOutputSchemaName,
    policyVersion: knowledgeAnswerPolicyVersion,
    reasoningEffort: subscriptionRuntimeReasoningEffort,
    serviceTier: subscriptionRuntimeDefaultServiceTier,
  }),
  [subscriptionRuntimeKnowledgeCoveragePurpose]: Object.freeze({
    isolatedCwd: "",
    maxOutputTokens: subscriptionRuntimeKnowledgeCoverageMaxOutputTokens,
    model: subscriptionRuntimeModel,
    outputSchemaName: knowledgeCoverageOutputSchemaName,
    policyVersion: knowledgeCoveragePolicyVersion,
    reasoningEffort: subscriptionRuntimeReasoningEffort,
  }),
  [subscriptionRuntimeKnowledgeEvidenceSelectorPurpose]: Object.freeze({
    isolatedCwd: "",
    maxOutputTokens: subscriptionRuntimeKnowledgeEvidenceSelectorMaxOutputTokens,
    model: subscriptionRuntimeModel,
    outputSchemaName: knowledgeEvidenceSelectorOutputSchemaName,
    policyVersion: knowledgeEvidenceSelectorPolicyVersion,
    reasoningEffort: subscriptionRuntimeReasoningEffort,
  }),
  [subscriptionRuntimePurpose]: Object.freeze({
    isolatedCwd: "",
    maxOutputTokens: subscriptionRuntimeSummaryMaxOutputTokens,
    model: subscriptionRuntimeModel,
    outputSchemaName: meetingSummaryOutputSchemaName,
    policyVersion: meetingSummaryPolicyVersion,
    reasoningEffort: subscriptionRuntimeReasoningEffort,
  }),
  [subscriptionRuntimeIncrementalPurpose]: Object.freeze({
    isolatedCwd: "",
    maxOutputTokens: subscriptionRuntimeIncrementalMaxOutputTokens,
    model: subscriptionRuntimeIncrementalModel,
    outputSchemaName: incrementalMeetingSummaryOutputSchemaName,
    policyVersion: incrementalMeetingSummaryPolicyVersion,
    reasoningEffort: subscriptionRuntimeIncrementalReasoningEffort,
  }),
});

export function assertDeploymentPurposeProfiles(
  profiles: PurposeProfiles,
  isolatedCwd: string,
): void {
  const names = Object.keys(profiles).toSorted();
  const expectedNames = Object.keys(expectedProfiles).toSorted();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    rejectDeploymentPurposePolicy();
  }
  for (const name of expectedNames) {
    const actual = profiles[name];
    const expected = expectedProfiles[name];
    if (
      actual === undefined ||
      expected === undefined ||
      actual.isolatedCwd !== isolatedCwd ||
      actual.maxOutputTokens !== expected.maxOutputTokens ||
      actual.model !== expected.model ||
      actual.outputSchemaName !== expected.outputSchemaName ||
      actual.policyVersion !== expected.policyVersion ||
      actual.reasoningEffort !== expected.reasoningEffort ||
      actual.serviceTier !== expected.serviceTier
    ) {
      rejectDeploymentPurposePolicy();
    }
  }
}

function rejectDeploymentPurposePolicy(): never {
  throw new Error("Deployment policy conflicts with executable sidecar policy");
}
