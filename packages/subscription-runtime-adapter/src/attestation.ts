import { canonicalJsonSha256 } from "./canonical-json.js";
import { SubscriptionRuntimeAdapterError } from "./errors.js";
import {
  subscriptionRuntimeProfileForPurpose,
  subscriptionRuntimeProvider,
  type SubscriptionRuntimeEngine,
  type SubscriptionRuntimeExecutionProfile,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTaskResult,
} from "./subscription-runtime-contract.js";

export interface AttestationExpectation {
  readonly executionProfile?: SubscriptionRuntimeExecutionProfile;
  readonly launcherSha256: string;
  readonly runtimeEngine: SubscriptionRuntimeEngine;
  readonly runtimePackageVersion: string;
}

export function verifySubscriptionRuntimeAttestation(
  request: SubscriptionRuntimeAgentTaskRequest,
  result: Extract<SubscriptionRuntimeTaskResult, { readonly status: "completed" }>,
  expectation: AttestationExpectation,
): void {
  const attestation = result.executionAttestation;
  const profile = expectation.executionProfile ??
    subscriptionRuntimeProfileForPurpose(request.context.purpose);
  if (
    profile === undefined ||
    !requestMatchesExecutionProfile(request, profile) ||
    attestation.schemaVersion !== 1 ||
    attestation.requestId !== request.runId ||
    attestation.purpose !== profile.purpose ||
    attestation.provider !== subscriptionRuntimeProvider ||
    attestation.model !== profile.model ||
    attestation.reasoningEffort !== profile.reasoningEffort ||
    attestation.serviceTier !== profile.serviceTier ||
    attestation.runtimeEngine !== expectation.runtimeEngine ||
    attestation.runtimePackageVersion !== expectation.runtimePackageVersion ||
    attestation.launcherSha256 !== expectation.launcherSha256 ||
    attestation.selectedOutputKind !== "structured_output" ||
    attestation.canonicalRequestSha256 !== canonicalJsonSha256(request) ||
    attestation.selectedOutputSha256 !==
      canonicalJsonSha256(result.structuredOutput)
  ) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_attestation",
      "Subscription runtime execution attestation did not match the request and result",
    );
  }
}

function requestMatchesExecutionProfile(request: SubscriptionRuntimeAgentTaskRequest,
  profile: SubscriptionRuntimeExecutionProfile): boolean {
  return request.context.purpose === profile.purpose &&
    request.task.controls.maxOutputTokens === profile.maxOutputTokens &&
    request.task.controls.model === profile.model &&
    request.task.metadata.model === profile.model &&
    request.task.controls.outputSchemaName === profile.outputSchemaName &&
    request.task.metadata.policyVersion === profile.policyVersion &&
    request.task.controls.reasoningEffort === profile.reasoningEffort &&
    request.task.metadata.reasoningEffort === profile.reasoningEffort &&
    request.task.controls.serviceTier === profile.serviceTier &&
    request.task.metadata.serviceTier === profile.serviceTier;
}
