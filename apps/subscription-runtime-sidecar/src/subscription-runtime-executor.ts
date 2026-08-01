import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditedSubscriptionRuntimePackageVersion,
  canonicalJsonSha256,
  providerMeetingSummarySchema,
  subscriptionRuntimeEngine,
  subscriptionRuntimeModel,
  subscriptionRuntimeProvider,
  subscriptionRuntimePurpose,
  subscriptionRuntimeReasoningEffort,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeFailureCode,
  type SubscriptionRuntimeHealthResult,
  type SubscriptionRuntimeTaskResult,
} from "@discord-meeting/subscription-runtime-adapter";
import { z } from "zod";

import { providerInstanceId } from "./constants.js";
import { installationIdentitiesEqual } from "./installation-inspector.js";
import {
  assertCanonicalRequestPolicy,
  type RequestPolicyOptions,
} from "./policy.js";
import type {
  InstallationInspectorPort,
  ProcessRunnerPort,
  RuntimeReadinessInspectorPort,
  SidecarExecutorPort,
} from "./types.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const failureCodes = new Set<SubscriptionRuntimeFailureCode>([
  "backend_unavailable",
  "needs_reconnect",
  "permission_required",
  "provider_output_invalid",
  "provider_session_invalid",
  "quota_limited",
  "stale_generation",
  "task_cancelled",
  "task_mode_unsupported",
  "task_timeout",
  "unknown_runtime_failure",
]);
const warningSchema = z
  .object({
    code: z.string().trim().min(1).max(128),
    safeMessage: z.string().optional(),
  })
  .loose();
const failureSchema = z
  .object({
    code: z.string(),
    safeMessage: z.string().optional(),
    retryable: z.boolean(),
    reconnectRequired: z.boolean(),
    causeCategory: z.string().optional(),
  })
  .loose();
const telemetrySchema = z
  .object({
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .optional(),
    cost: z
      .object({ amount: z.number().nonnegative(), currency: z.literal("USD") })
      .optional(),
  })
  .loose()
  .optional();
const cliResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("completed"),
      outputText: z.string(),
      structuredOutput: jsonObjectSchema,
      telemetry: telemetrySchema,
      warnings: z.array(warningSchema).max(100),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("failed"),
      failure: failureSchema,
      telemetry: telemetrySchema,
      warnings: z.array(warningSchema).max(100),
    })
    .strict(),
]);

export interface SubscriptionRuntimeExecutorOptions extends RequestPolicyOptions {
  readonly authJsonPath: string;
  readonly childSourceEnvironment: NodeJS.ProcessEnv;
  readonly installationInspector: InstallationInspectorPort;
  readonly killGraceMs: number;
  readonly localEncryptionKeyFile: string;
  readonly maxStderrBytes: number;
  readonly maxStdoutBytes: number;
  readonly processRunner: ProcessRunnerPort;
  readonly readinessInspector: RuntimeReadinessInspectorPort;
  readonly stateRoot: string;
}

export class SubscriptionRuntimeExecutor implements SidecarExecutorPort {
  public constructor(private readonly options: SubscriptionRuntimeExecutorOptions) {}

  public async execute(
    request: SubscriptionRuntimeAgentTaskRequest,
  ): Promise<SubscriptionRuntimeTaskResult> {
    try {
      assertCanonicalRequestPolicy(request, this.options);
    } catch {
      return failedResult("task_mode_unsupported");
    }

    let admittedInstallation;
    try {
      await this.options.readinessInspector.inspect();
      admittedInstallation = await this.options.installationInspector.inspect();
    } catch {
      return failedResult("backend_unavailable");
    }

    const tempRoot = await mkdtemp(
      join(tmpdir(), "discord-meeting-subscription-runtime-"),
    );
    const inputPath = join(tempRoot, "request.json");
    try {
      await writeFile(inputPath, JSON.stringify(request), {
        encoding: "utf8",
        mode: 0o600,
      });
      const encryptionKey = (await readFile(
        this.options.localEncryptionKeyFile,
        "utf8",
      )).trim();
      if (encryptionKey.length === 0) {
        return failedResult("backend_unavailable");
      }
      const execution = await this.options.processRunner.run({
        args: buildCliArgs(request, inputPath, this.options),
        command: admittedInstallation.executableRealpath,
        cwd: this.options.isolatedCwd,
        env: buildChildEnvironment(
          this.options.childSourceEnvironment,
          encryptionKey,
        ),
        killGraceMs: this.options.killGraceMs,
        maxStderrBytes: this.options.maxStderrBytes,
        maxStdoutBytes: this.options.maxStdoutBytes,
        timeoutMs: request.timeoutMs,
      });
      let completedInstallation;
      try {
        completedInstallation = await this.options.installationInspector.inspect();
      } catch {
        return failedResult("backend_unavailable");
      }
      if (
        !installationIdentitiesEqual(
          admittedInstallation,
          completedInstallation,
        )
      ) {
        return failedResult("provider_output_invalid");
      }
      if (execution.timedOut) {
        return failedResult("task_timeout");
      }
      if (execution.outputLimitExceeded) {
        return failedResult("provider_output_invalid");
      }

      const parsed = parseCliResult(execution.stdout);
      if (parsed === undefined || execution.exitCode !== (parsed.status === "completed" ? 0 : 1)) {
        return failedResult(
          execution.exitCode === 0
            ? "provider_output_invalid"
            : "backend_unavailable",
        );
      }
      if (parsed.status === "failed") {
        return failedResult(normalizeFailureCode(parsed.failure.code));
      }

      const validatedOutput = providerMeetingSummarySchema.safeParse(
        parsed.structuredOutput,
      );
      if (!validatedOutput.success) {
        return failedResult("provider_output_invalid");
      }
      const structuredOutput = validatedOutput.data as unknown as JsonObject;
      return {
        executionAttestation: {
          canonicalRequestSha256: canonicalJsonSha256(request),
          launcherSha256: completedInstallation.launcherSha256,
          model: subscriptionRuntimeModel,
          provider: subscriptionRuntimeProvider,
          purpose: subscriptionRuntimePurpose,
          reasoningEffort: subscriptionRuntimeReasoningEffort,
          requestId: request.runId,
          runtimeEngine: subscriptionRuntimeEngine,
          runtimePackageVersion: auditedSubscriptionRuntimePackageVersion,
          schemaVersion: 1,
          selectedOutputKind: "structured_output",
          selectedOutputSha256: canonicalJsonSha256(structuredOutput),
        },
        protocolVersion: 1,
        status: "completed",
        structuredOutput,
      };
    } catch {
      return failedResult("backend_unavailable");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  }

  public async checkHealth(): Promise<SubscriptionRuntimeHealthResult> {
    try {
      await this.options.readinessInspector.inspect();
      const installation = await this.options.installationInspector.inspect();
      return {
        launcherSha256: installation.launcherSha256,
        runtimeEngine: subscriptionRuntimeEngine,
        runtimeVersion: installation.runtimePackageVersion,
        status: "serving",
        warningCodes: [],
      };
    } catch {
      return {
        runtimeEngine: subscriptionRuntimeEngine,
        runtimeVersion: "unknown",
        status: "not_serving",
        warningCodes: ["subscription_runtime.identity_unavailable"],
      };
    }
  }
}

export function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  localEncryptionKey: string,
): Readonly<Record<string, string>> {
  const allowedExact = new Set([
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TMPDIR",
    "TZ",
    "https_proxy",
    "http_proxy",
    "no_proxy",
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const upperKey = key.toUpperCase();
    if (
      value === undefined ||
      upperKey.endsWith("_API_KEY") ||
      upperKey.endsWith("_API_KEY_FILE") ||
      (!allowedExact.has(key) && !key.startsWith("LC_"))
    ) {
      continue;
    }
    env[key] = value;
  }
  env.AGENT_RUNTIME_REASONING_EFFORT = subscriptionRuntimeReasoningEffort;
  env.SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY = localEncryptionKey;
  return env;
}

function buildCliArgs(
  request: SubscriptionRuntimeAgentTaskRequest,
  inputPath: string,
  options: SubscriptionRuntimeExecutorOptions,
): readonly string[] {
  return [
    "--provider",
    subscriptionRuntimeProvider,
    "--input",
    inputPath,
    "--format",
    "result-json",
    "--timeout-ms",
    String(request.timeoutMs),
    "--state-root",
    options.stateRoot,
    "--codex-auth-json",
    options.authJsonPath,
    "--provider-instance",
    providerInstanceId,
    "--model",
    subscriptionRuntimeModel,
  ];
}

function parseCliResult(value: string): z.infer<typeof cliResultSchema> | undefined {
  try {
    const parsed = cliResultSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFailureCode(code: string): SubscriptionRuntimeFailureCode {
  return failureCodes.has(code as SubscriptionRuntimeFailureCode)
    ? (code as SubscriptionRuntimeFailureCode)
    : "unknown_runtime_failure";
}

function failedResult(
  code: SubscriptionRuntimeFailureCode,
): Extract<SubscriptionRuntimeTaskResult, { readonly status: "failed" }> {
  const policy = failurePolicy(code);
  return {
    failure: {
      causeCategory: policy.causeCategory,
      code,
      reconnectRequired: policy.reconnectRequired,
      retryable: policy.retryable,
      safeMessage: policy.safeMessage,
    },
    protocolVersion: 1,
    status: "failed",
  };
}

function failurePolicy(code: SubscriptionRuntimeFailureCode): {
  readonly causeCategory: string;
  readonly reconnectRequired: boolean;
  readonly retryable: boolean;
  readonly safeMessage: string;
} {
  switch (code) {
    case "task_timeout":
      return {
        causeCategory: "deadline",
        reconnectRequired: false,
        retryable: true,
        safeMessage: "Subscription runtime task timed out",
      };
    case "needs_reconnect":
    case "provider_session_invalid":
      return {
        causeCategory: "subscription_session",
        reconnectRequired: true,
        retryable: true,
        safeMessage: "Subscription runtime session requires recovery",
      };
    case "quota_limited":
      return {
        causeCategory: "capacity",
        reconnectRequired: false,
        retryable: true,
        safeMessage: "Subscription runtime capacity is temporarily limited",
      };
    case "provider_output_invalid":
    case "task_mode_unsupported":
    case "permission_required":
      return {
        causeCategory: "policy",
        reconnectRequired: false,
        retryable: false,
        safeMessage: "Subscription runtime rejected an unsafe or invalid task result",
      };
    case "task_cancelled":
    case "stale_generation":
    case "backend_unavailable":
    case "unknown_runtime_failure":
      return {
        causeCategory: "subscription_runtime",
        reconnectRequired: false,
        retryable: true,
        safeMessage: "Subscription runtime task is temporarily unavailable",
      };
  }
}
