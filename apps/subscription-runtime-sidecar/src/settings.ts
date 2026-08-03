import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  auditedSubscriptionRuntimePackageVersion,
  incrementalMeetingSummaryOutputSchemaName,
  incrementalMeetingSummaryPolicyVersion,
  meetingSummaryOutputSchemaName,
  meetingSummaryPolicyVersion,
  subscriptionRuntimeIncrementalMaxOutputTokens,
  subscriptionRuntimeModel,
  subscriptionRuntimeIncrementalModel,
  subscriptionRuntimeIncrementalPurpose,
  subscriptionRuntimeIncrementalReasoningEffort,
  subscriptionRuntimePurpose,
  subscriptionRuntimeReasoningEffort,
  subscriptionRuntimeSummaryMaxOutputTokens,
} from "@discord-meeting/subscription-runtime-adapter";

import {
  applicationName,
  providerInstanceId,
  runtimePackageName,
} from "./constants.js";

const defaultProtoPath = fileURLToPath(
  new URL("../../meeting-platform/proto/agent_runtime.proto", import.meta.url),
);

const deploymentPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolVersion: z.literal(1),
    runtime: z.object({
      packageName: z.literal(runtimePackageName),
      packageVersion: z.literal(auditedSubscriptionRuntimePackageVersion),
    }),
    transport: z.object({
      bind: z.string().min(1),
      publishHostPort: z.literal(false),
      serviceTokenFile: z.string().min(1),
    }),
    custody: z.object({
      authJsonPath: z.string().min(1),
      stateRoot: z.string().min(1),
      localEncryptionKeyFile: z.string().min(1),
      sharedMutableStateAllowed: z.literal(false),
    }),
    purposeProfiles: z.record(
      z.string(),
      z.object({
        provider: z.literal("codex"),
        model: z.union([
          z.literal(subscriptionRuntimeModel),
          z.literal(subscriptionRuntimeIncrementalModel),
        ]),
        policyVersion: z.union([
          z.literal(meetingSummaryPolicyVersion),
          z.literal(incrementalMeetingSummaryPolicyVersion),
        ]),
        maxOutputTokens: z.union([
          z.literal(subscriptionRuntimeSummaryMaxOutputTokens),
          z.literal(subscriptionRuntimeIncrementalMaxOutputTokens),
        ]),
        reasoningEffort: z.union([
          z.literal(subscriptionRuntimeReasoningEffort),
          z.literal(subscriptionRuntimeIncrementalReasoningEffort),
        ]),
        taskKind: z.literal("structured-prompt"),
        executionProfile: z.literal("stateless-completion"),
        disableTools: z.literal(true),
        permissionMode: z.literal("read-only"),
        interactive: z.literal(false),
        responseFormat: z.literal("json"),
        selectedOutputKind: z.literal("structured_output"),
        outputSchemaName: z.union([
          z.literal(meetingSummaryOutputSchemaName),
          z.literal(incrementalMeetingSummaryOutputSchemaName),
        ]),
        isolatedCwd: z.string().min(1),
      }),
    ),
    environment: z.object({
      inheritHostEnvironment: z.literal(false),
      denyKeySuffixes: z.array(z.string()),
    }),
  })
  .loose();

export interface SidecarSettings {
  readonly authJsonPath: string;
  readonly bindAddress: string;
  readonly expectedLauncherSha256: string;
  readonly isolatedCwd: string;
  readonly killGraceMs: number;
  readonly launcherPath: string;
  readonly localEncryptionKeyFile: string;
  readonly maxPromptBytes: number;
  readonly maxStderrBytes: number;
  readonly maxStdoutBytes: number;
  readonly maxTaskTimeoutMs: number;
  readonly packageManifestPath: string;
  readonly protoPath: string;
  readonly serviceToken: string;
  readonly stateRoot: string;
}

export async function resolveSidecarSettings(
  env: NodeJS.ProcessEnv,
): Promise<SidecarSettings> {
  assertFrozenEnvironment(env);
  const settings: SidecarSettings = {
    authJsonPath: requiredAbsolutePath(
      env.SUBSCRIPTION_RUNTIME_AUTH_JSON_PATH,
      "SUBSCRIPTION_RUNTIME_AUTH_JSON_PATH",
    ),
    bindAddress: requiredText(
      env.SUBSCRIPTION_RUNTIME_GRPC_BIND,
      "SUBSCRIPTION_RUNTIME_GRPC_BIND",
    ),
    expectedLauncherSha256: sha256(
      env.SUBSCRIPTION_RUNTIME_EXPECTED_LAUNCHER_SHA256,
    ),
    isolatedCwd: requiredAbsolutePath(
      env.SUBSCRIPTION_RUNTIME_ISOLATED_CWD,
      "SUBSCRIPTION_RUNTIME_ISOLATED_CWD",
    ),
    killGraceMs: positiveInteger(
      env.SUBSCRIPTION_RUNTIME_KILL_GRACE_MS,
      2_000,
      100,
      30_000,
    ),
    launcherPath: requiredAbsolutePath(
      env.SUBSCRIPTION_RUNTIME_LAUNCHER_PATH,
      "SUBSCRIPTION_RUNTIME_LAUNCHER_PATH",
    ),
    localEncryptionKeyFile: requiredAbsolutePath(
      env.SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY_FILE,
      "SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY_FILE",
    ),
    maxPromptBytes: positiveInteger(
      env.SUBSCRIPTION_RUNTIME_MAX_PROMPT_BYTES,
      2 * 1_024 * 1_024,
      1_024,
      16 * 1_024 * 1_024,
    ),
    maxStderrBytes: positiveInteger(
      env.SUBSCRIPTION_RUNTIME_MAX_STDERR_BYTES,
      64 * 1_024,
      1_024,
      1_024 * 1_024,
    ),
    maxStdoutBytes: positiveInteger(
      env.SUBSCRIPTION_RUNTIME_MAX_STDOUT_BYTES,
      2 * 1_024 * 1_024,
      1_024,
      16 * 1_024 * 1_024,
    ),
    maxTaskTimeoutMs: positiveInteger(
      env.SUBSCRIPTION_RUNTIME_MAX_TASK_TIMEOUT_MS,
      600_000,
      1_000,
      3_600_000,
    ),
    packageManifestPath: requiredAbsolutePath(
      env.SUBSCRIPTION_RUNTIME_PACKAGE_MANIFEST_PATH,
      "SUBSCRIPTION_RUNTIME_PACKAGE_MANIFEST_PATH",
    ),
    protoPath: requiredAbsolutePath(
      env.SUBSCRIPTION_RUNTIME_PROTO_PATH ?? defaultProtoPath,
      "SUBSCRIPTION_RUNTIME_PROTO_PATH",
    ),
    serviceToken: await readSecretFile(
      requiredAbsolutePath(
        env.SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE,
        "SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE",
      ),
      16,
    ),
    stateRoot: requiredAbsolutePath(
      env.SUBSCRIPTION_RUNTIME_STATE_ROOT,
      "SUBSCRIPTION_RUNTIME_STATE_ROOT",
    ),
  };
  await assertDeploymentPolicy(
    requiredAbsolutePath(
      env.SUBSCRIPTION_RUNTIME_PURPOSE_POLICY_FILE,
      "SUBSCRIPTION_RUNTIME_PURPOSE_POLICY_FILE",
    ),
    env,
    settings,
  );
  return settings;
}

async function assertDeploymentPolicy(
  policyPath: string,
  env: NodeJS.ProcessEnv,
  settings: SidecarSettings,
): Promise<void> {
  const policy = deploymentPolicySchema.safeParse(
    JSON.parse(await readFile(policyPath, "utf8")) as unknown,
  );
  const finalProfile = policy.success
    ? policy.data.purposeProfiles[subscriptionRuntimePurpose]
    : undefined;
  const incrementalProfile = policy.success
    ? policy.data.purposeProfiles[subscriptionRuntimeIncrementalPurpose]
    : undefined;
  const admittedPurposeNames = policy.success
    ? Object.keys(policy.data.purposeProfiles).toSorted()
    : [];
  if (
    !policy.success ||
    finalProfile === undefined ||
    incrementalProfile === undefined ||
    admittedPurposeNames.length !== 2 ||
    admittedPurposeNames[0] !== subscriptionRuntimePurpose ||
    admittedPurposeNames[1] !== subscriptionRuntimeIncrementalPurpose ||
    valuesDiffer(finalProfile.model, subscriptionRuntimeModel) ||
    valuesDiffer(finalProfile.policyVersion, meetingSummaryPolicyVersion) ||
    valuesDiffer(
      finalProfile.maxOutputTokens,
      subscriptionRuntimeSummaryMaxOutputTokens,
    ) ||
    valuesDiffer(finalProfile.reasoningEffort, subscriptionRuntimeReasoningEffort) ||
    finalProfile.outputSchemaName !== meetingSummaryOutputSchemaName ||
    valuesDiffer(incrementalProfile.model, subscriptionRuntimeIncrementalModel) ||
    valuesDiffer(
      incrementalProfile.policyVersion,
      incrementalMeetingSummaryPolicyVersion,
    ) ||
    valuesDiffer(
      incrementalProfile.maxOutputTokens,
      subscriptionRuntimeIncrementalMaxOutputTokens,
    ) ||
    valuesDiffer(
      incrementalProfile.reasoningEffort,
      subscriptionRuntimeIncrementalReasoningEffort,
    ) ||
    incrementalProfile.outputSchemaName !==
      incrementalMeetingSummaryOutputSchemaName ||
    policy.data.transport.bind !== settings.bindAddress ||
    policy.data.transport.serviceTokenFile !==
      env.SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE ||
    policy.data.custody.authJsonPath !== settings.authJsonPath ||
    policy.data.custody.stateRoot !== settings.stateRoot ||
    policy.data.custody.localEncryptionKeyFile !==
      settings.localEncryptionKeyFile ||
    finalProfile.isolatedCwd !== settings.isolatedCwd ||
    incrementalProfile.isolatedCwd !== settings.isolatedCwd ||
    !policy.data.environment.denyKeySuffixes.includes("_API_KEY") ||
    !policy.data.environment.denyKeySuffixes.includes("_API_KEY_FILE")
  ) {
    throw new Error("Deployment policy conflicts with executable sidecar policy");
  }
}

function valuesDiffer<T extends number | string>(actual: T, expected: T): boolean {
  return actual !== expected;
}

async function readSecretFile(path: string, minimumLength: number): Promise<string> {
  const fileStat = await lstat(path);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("Sidecar secret input must be a regular non-symlink file");
  }
  if ((fileStat.mode & 0o077) !== 0) {
    throw new Error("Sidecar secret file permissions are too broad");
  }
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < minimumLength || /\s/u.test(value)) {
    throw new Error("Sidecar service token is malformed");
  }
  return value;
}

function assertFrozenEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [key, value, expected] of [
    ["SUBSCRIPTION_RUNTIME_EXPECTED_PACKAGE_VERSION", env.SUBSCRIPTION_RUNTIME_EXPECTED_PACKAGE_VERSION, auditedSubscriptionRuntimePackageVersion],
    ["SUBSCRIPTION_RUNTIME_PROVIDER", env.SUBSCRIPTION_RUNTIME_PROVIDER, "codex"],
    ["SUBSCRIPTION_RUNTIME_PROVIDER_INSTANCE_ID", env.SUBSCRIPTION_RUNTIME_PROVIDER_INSTANCE_ID, providerInstanceId],
    ["SUBSCRIPTION_RUNTIME_EXECUTION_PROFILE", env.SUBSCRIPTION_RUNTIME_EXECUTION_PROFILE, "stateless-completion"],
    ["SUBSCRIPTION_RUNTIME_DISABLE_TOOLS", env.SUBSCRIPTION_RUNTIME_DISABLE_TOOLS, "1"],
  ] as const) {
    if (value !== undefined && value.trim() !== expected) {
      throw new Error(`${key} conflicts with executable sidecar policy`);
    }
  }
  for (const key of [
    "SUBSCRIPTION_RUNTIME_MODEL",
    "SUBSCRIPTION_RUNTIME_REASONING_EFFORT",
  ] as const) {
    if (env[key] !== undefined) {
      throw new Error(`${key} must be selected per admitted request profile`);
    }
  }
  if (env.SUBSCRIPTION_RUNTIME_APPLICATION !== undefined && env.SUBSCRIPTION_RUNTIME_APPLICATION !== applicationName) {
    throw new Error("SUBSCRIPTION_RUNTIME_APPLICATION conflicts with policy");
  }
}

function requiredText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (text === undefined || text.length === 0 || text.includes("\0")) {
    throw new Error(`${name} is required`);
  }
  return text;
}

function requiredAbsolutePath(value: string | undefined, name: string): string {
  const path = requiredText(value, name);
  if (!path.startsWith("/")) {
    throw new Error(`${name} must be absolute`);
  }
  return path;
}

function sha256(value: string | undefined): string {
  const digest = requiredText(
    value,
    "SUBSCRIPTION_RUNTIME_EXPECTED_LAUNCHER_SHA256",
  );
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("Expected launcher SHA-256 must be lowercase hexadecimal");
  }
  return digest;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Sidecar numeric setting is outside its admitted bound");
  }
  return parsed;
}
