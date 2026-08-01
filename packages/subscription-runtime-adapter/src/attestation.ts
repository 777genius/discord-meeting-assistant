import { canonicalJsonSha256 } from "./canonical-json.js";
import { SubscriptionRuntimeAdapterError } from "./errors.js";
import {
  subscriptionRuntimeEngine,
  subscriptionRuntimeModel,
  subscriptionRuntimeProvider,
  subscriptionRuntimePurpose,
  subscriptionRuntimeReasoningEffort,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTaskResult,
} from "./subscription-runtime-contract.js";

export interface AttestationExpectation {
  readonly launcherSha256: string;
  readonly runtimePackageVersion: string;
}

export function verifySubscriptionRuntimeAttestation(
  request: SubscriptionRuntimeAgentTaskRequest,
  result: Extract<SubscriptionRuntimeTaskResult, { readonly status: "completed" }>,
  expectation: AttestationExpectation,
): void {
  const attestation = result.executionAttestation;
  if (
    attestation.schemaVersion !== 1 ||
    attestation.requestId !== request.runId ||
    attestation.purpose !== subscriptionRuntimePurpose ||
    attestation.provider !== subscriptionRuntimeProvider ||
    attestation.model !== subscriptionRuntimeModel ||
    attestation.reasoningEffort !== subscriptionRuntimeReasoningEffort ||
    attestation.runtimeEngine !== subscriptionRuntimeEngine ||
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
