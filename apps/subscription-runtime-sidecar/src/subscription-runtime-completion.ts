import {
  auditedSubscriptionRuntimePackageVersion,
  canonicalJsonSha256,
  subscriptionRuntimeConversationPurpose,
  subscriptionRuntimeProvider,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeEngine,
  type SubscriptionRuntimeExecutionProfile,
  type SubscriptionRuntimeFailureCode,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTelemetry,
  type SubscriptionRuntimeUsage,
} from "@discord-meeting/subscription-runtime-adapter";

import {
  parseCliResult,
  validateStructuredOutput,
  type ParsedCliResult,
} from "./subscription-runtime-cli-protocol.js";
import {
  failedResult,
  normalizeFailureCode,
} from "./subscription-runtime-failure.js";
import {
  readTelemetry,
  withLunaCostRange,
  type TelemetryResult,
} from "./subscription-runtime-telemetry.js";
import type { InstallationIdentity, ProcessRunResult } from "./types.js";

export interface ProcessCompletionInput {
  readonly completedInstallation: InstallationIdentity;
  readonly execution: ProcessRunResult;
  readonly profile: SubscriptionRuntimeExecutionProfile;
  readonly request: SubscriptionRuntimeAgentTaskRequest;
  readonly runtimeEngine: SubscriptionRuntimeEngine;
}

interface TelemetryEvidence {
  readonly telemetry?: SubscriptionRuntimeTelemetry;
  readonly usage?: SubscriptionRuntimeUsage;
}

export function resolveProcessCompletion(
  input: ProcessCompletionInput,
): SubscriptionRuntimeTaskResult {
  const immediateFailure = processExecutionFailure(input.execution);
  if (immediateFailure !== undefined) {
    return failedResult(immediateFailure);
  }
  const parsed = parseCliResult(input.execution.stdout);
  if (parsed === undefined) {
    return failedResult(parseFailureCode(input.execution.exitCode));
  }
  return resolveParsedCliResult(input, parsed);
}

function resolveParsedCliResult(
  input: ProcessCompletionInput,
  parsed: ParsedCliResult,
): SubscriptionRuntimeTaskResult {
  const telemetry = readTelemetry(parsed.telemetry?.usage);
  if (telemetry.status === "invalid") {
    return failedResult("provider_output_invalid");
  }
  const evidence = telemetryEvidence(telemetry, input.profile);
  const exitCodeFailure = invalidExitCodeFailure(input.execution, parsed.status);
  if (exitCodeFailure !== undefined) {
    return failedWithEvidence(exitCodeFailure, evidence);
  }
  if (parsed.status === "failed") {
    return failedWithEvidence(normalizeFailureCode(parsed.failure.code), evidence);
  }
  return resolveCompletedCliResult(input, parsed, telemetry, evidence);
}

function resolveCompletedCliResult(
  input: ProcessCompletionInput,
  parsed: Extract<ParsedCliResult, { readonly status: "completed" }>,
  telemetry: Exclude<TelemetryResult, { readonly status: "invalid" }>,
  evidence: TelemetryEvidence,
): SubscriptionRuntimeTaskResult {
  if (input.execution.serviceTier !== input.profile.serviceTier) {
    return failedResult("provider_output_invalid");
  }
  if (
    telemetry.status === "missing" &&
    input.profile.purpose !== subscriptionRuntimeConversationPurpose
  ) {
    return failedResult("telemetry_unavailable");
  }
  if (telemetry.status === "available") {
    if (telemetry.value.outputTokens.availability !== "measured") {
      return failedWithEvidence("telemetry_unavailable", evidence);
    }
    if (telemetry.value.outputTokens.value > input.profile.maxOutputTokens) {
      return failedWithEvidence("provider_output_invalid", evidence);
    }
  }
  const structuredOutput = validateStructuredOutput(
    input.profile,
    parsed.structuredOutput,
  );
  if (structuredOutput === undefined) {
    return failedWithEvidence("provider_output_invalid", evidence);
  }
  return completedResult(input, structuredOutput, evidence);
}

function processExecutionFailure(
  execution: ProcessRunResult,
): SubscriptionRuntimeFailureCode | undefined {
  if (execution.timedOut) {
    return "task_timeout";
  }
  return execution.outputLimitExceeded ? "provider_output_invalid" : undefined;
}

function parseFailureCode(
  exitCode: ProcessRunResult["exitCode"],
): SubscriptionRuntimeFailureCode {
  return exitCode === 0 ? "provider_output_invalid" : "backend_unavailable";
}

function invalidExitCodeFailure(
  execution: ProcessRunResult,
  status: ParsedCliResult["status"],
): SubscriptionRuntimeFailureCode | undefined {
  const expectedExitCode = status === "completed" ? 0 : 1;
  return execution.exitCode === expectedExitCode
    ? undefined
    : parseFailureCode(execution.exitCode);
}

function telemetryEvidence(
  telemetry: Exclude<TelemetryResult, { readonly status: "invalid" }>,
  profile: SubscriptionRuntimeExecutionProfile,
): TelemetryEvidence {
  if (telemetry.status !== "available") {
    return {};
  }
  const partialTelemetry = withLunaCostRange(telemetry.value, profile);
  return {
    ...(telemetry.usage === undefined ? {} : { usage: telemetry.usage }),
    telemetry: partialTelemetry,
  };
}

function failedWithEvidence(
  code: SubscriptionRuntimeFailureCode,
  evidence: TelemetryEvidence,
): Extract<SubscriptionRuntimeTaskResult, { readonly status: "failed" }> {
  return failedResult(code, evidence.usage, evidence.telemetry);
}

function completedResult(
  input: ProcessCompletionInput,
  structuredOutput: JsonObject,
  evidence: TelemetryEvidence,
): Extract<SubscriptionRuntimeTaskResult, { readonly status: "completed" }> {
  return {
    executionAttestation: {
      canonicalRequestSha256: canonicalJsonSha256(input.request),
      launcherSha256: input.completedInstallation.launcherSha256,
      model: input.profile.model,
      provider: subscriptionRuntimeProvider,
      purpose: input.profile.purpose,
      reasoningEffort: input.profile.reasoningEffort,
      requestId: input.request.runId,
      runtimeEngine: input.runtimeEngine,
      runtimePackageVersion: auditedSubscriptionRuntimePackageVersion,
      schemaVersion: 1,
      selectedOutputKind: "structured_output",
      selectedOutputSha256: canonicalJsonSha256(structuredOutput),
      ...(input.profile.serviceTier === undefined
        ? {}
        : { serviceTier: input.profile.serviceTier }),
    },
    protocolVersion: 1,
    status: "completed",
    structuredOutput,
    ...(evidence.telemetry === undefined ? {} : { telemetry: evidence.telemetry }),
    ...(evidence.usage === undefined ? {} : { usage: evidence.usage }),
  };
}
