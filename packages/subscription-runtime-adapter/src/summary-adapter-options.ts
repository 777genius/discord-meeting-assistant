import type { AttestationExpectation } from "./attestation.js";
import { SubscriptionRuntimeAdapterError } from "./errors.js";
import type { SubscriptionRuntimeSummaryRequestOptions } from "./request-mapper.js";
import { auditedSubscriptionRuntimePackageVersion } from "./subscription-runtime-contract.js";

const defaultIsolatedCwd = "/run/discord-meeting-subscription-runtime/workspace";
const defaultMaxOutputTokens = 4_096;
const defaultMaxPromptBytes = 2 * 1_024 * 1_024;
const defaultTimeoutMs = 600_000;

export interface BaseSubscriptionRuntimeSummaryAdapterOptions {
  readonly expectedLauncherSha256: string;
  readonly expectedRuntimePackageVersion?: string;
  readonly isolatedCwd?: string;
  readonly maxOutputTokens?: number;
  readonly maxPromptBytes?: number;
  readonly outputLanguage?: string;
  readonly timeoutMs?: number;
}

export function validateAttestationExpectation(
  options: BaseSubscriptionRuntimeSummaryAdapterOptions,
): AttestationExpectation {
  if (!/^[0-9a-f]{64}$/u.test(options.expectedLauncherSha256)) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      "expectedLauncherSha256 must be a lowercase SHA-256 digest",
    );
  }
  const runtimePackageVersion =
    options.expectedRuntimePackageVersion ??
    auditedSubscriptionRuntimePackageVersion;
  if (runtimePackageVersion !== auditedSubscriptionRuntimePackageVersion) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      `Only audited subscription runtime ${auditedSubscriptionRuntimePackageVersion} is admitted`,
    );
  }
  return {
    launcherSha256: options.expectedLauncherSha256,
    runtimePackageVersion,
  };
}

export function validateSummaryRequestOptions(
  options: BaseSubscriptionRuntimeSummaryAdapterOptions,
): SubscriptionRuntimeSummaryRequestOptions {
  const isolatedCwd = options.isolatedCwd ?? defaultIsolatedCwd;
  if (!isolatedCwd.startsWith("/") || isolatedCwd.includes("\0")) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      "isolatedCwd must be an absolute safe path",
    );
  }
  const outputLanguage = options.outputLanguage?.trim();
  if (options.outputLanguage !== undefined && outputLanguage?.length === 0) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      "outputLanguage must not be empty",
    );
  }
  return {
    isolatedCwd,
    maxOutputTokens: positiveIntegerOption(
      options.maxOutputTokens,
      defaultMaxOutputTokens,
      256,
      32_768,
      "maxOutputTokens",
    ),
    maxPromptBytes: positiveIntegerOption(
      options.maxPromptBytes,
      defaultMaxPromptBytes,
      1_024,
      16 * 1_024 * 1_024,
      "maxPromptBytes",
    ),
    timeoutMs: positiveIntegerOption(
      options.timeoutMs,
      defaultTimeoutMs,
      1_000,
      3_600_000,
      "timeoutMs",
    ),
    ...(outputLanguage === undefined ? {} : { outputLanguage }),
  };
}

export function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      `${field} must be a safe integer from ${minimum} through ${maximum}`,
    );
  }
  return resolved;
}
