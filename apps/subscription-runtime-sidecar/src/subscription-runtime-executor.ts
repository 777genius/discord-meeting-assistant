import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  subscriptionRuntimeConversationPurpose,
  subscriptionRuntimeProfileForPurpose,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeExecutionProfile,
  type SubscriptionRuntimeHealthResult,
  type SubscriptionRuntimeTaskResult,
} from "@discord-meeting/subscription-runtime-adapter";

import {
  resolveProcessCompletion,
} from "./subscription-runtime-completion.js";
import { failedResult } from "./subscription-runtime-failure.js";
import { installationIdentitiesEqual } from "./installation-inspector.js";
import {
  assertCanonicalRequestPolicy,
  type RequestPolicyOptions,
} from "./policy.js";
import {
  buildChildEnvironment,
  buildCliArgs,
} from "./subscription-runtime-process-request.js";
import type {
  InstallationInspectorPort,
  InstallationIdentity,
  ProcessRunnerPort,
  ProcessRunResult,
  RuntimeReadinessInspectorPort,
  SidecarExecutorPort,
} from "./types.js";

export { buildChildEnvironment } from "./subscription-runtime-process-request.js";

export interface SubscriptionRuntimeExecutorOptions extends RequestPolicyOptions {
  readonly authJsonPath: string;
  readonly childSourceEnvironment: NodeJS.ProcessEnv;
  readonly conversationProcessRunner?: ProcessRunnerPort;
  readonly installationInspector: InstallationInspectorPort;
  readonly killGraceMs: number;
  readonly localEncryptionKeyFile: string;
  readonly maxStderrBytes: number;
  readonly maxStdoutBytes: number;
  readonly processRunner: ProcessRunnerPort;
  readonly readinessInspector: RuntimeReadinessInspectorPort;
  readonly stateRoot: string;
}

interface ExecutionPlan {
  readonly processRunner: ProcessRunnerPort;
  readonly profile: SubscriptionRuntimeExecutionProfile;
}

interface AdmittedExecutionInput {
  readonly admittedInstallation: InstallationIdentity;
  readonly options: SubscriptionRuntimeExecutorOptions;
  readonly plan: ExecutionPlan;
  readonly request: SubscriptionRuntimeAgentTaskRequest;
  readonly signal?: AbortSignal;
}

interface CompletedExecutionInput extends AdmittedExecutionInput {
  readonly execution: ProcessRunResult;
}

export class SubscriptionRuntimeExecutor implements SidecarExecutorPort {
  public constructor(private readonly options: SubscriptionRuntimeExecutorOptions) {}

  public async execute(
    request: SubscriptionRuntimeAgentTaskRequest,
    signal?: AbortSignal,
  ): Promise<SubscriptionRuntimeTaskResult> {
    if (signalAborted(signal)) {
      return failedResult("task_cancelled");
    }
    const plan = createExecutionPlan(request, this.options);
    if (plan === undefined) {
      return failedResult("task_mode_unsupported");
    }
    const admittedInstallation = await admitRuntimeInstallation(this.options);
    if (admittedInstallation === undefined) {
      return failedResult("backend_unavailable");
    }
    return executeAdmittedRequest({
      admittedInstallation,
      options: this.options,
      plan,
      request,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async checkHealth(): Promise<SubscriptionRuntimeHealthResult> {
    try {
      await this.options.readinessInspector.inspect();
      const installation = await this.options.installationInspector.inspect();
      return {
        launcherSha256: installation.launcherSha256,
        runtimeEngine: this.options.processRunner.runtimeEngine,
        runtimeVersion: installation.runtimePackageVersion,
        status: "serving",
        warningCodes: [],
      };
    } catch {
      return {
        runtimeEngine: this.options.processRunner.runtimeEngine,
        runtimeVersion: "unknown",
        status: "not_serving",
        warningCodes: ["subscription_runtime.identity_unavailable"],
      };
    }
  }
}

function createExecutionPlan(
  request: SubscriptionRuntimeAgentTaskRequest,
  options: SubscriptionRuntimeExecutorOptions,
): ExecutionPlan | undefined {
  try {
    assertCanonicalRequestPolicy(request, options);
  } catch {
    return undefined;
  }
  const profile = subscriptionRuntimeProfileForPurpose(request.context.purpose);
  if (profile === undefined) {
    return undefined;
  }
  return {
    processRunner: profile.purpose === subscriptionRuntimeConversationPurpose
      ? options.conversationProcessRunner ?? options.processRunner
      : options.processRunner,
    profile,
  };
}

async function admitRuntimeInstallation(
  options: SubscriptionRuntimeExecutorOptions,
): Promise<InstallationIdentity | undefined> {
  try {
    await options.readinessInspector.inspect();
    return await options.installationInspector.inspect();
  } catch {
    return undefined;
  }
}

async function executeAdmittedRequest(
  input: AdmittedExecutionInput,
): Promise<SubscriptionRuntimeTaskResult> {
  const tempRoot = await mkdtemp(
    join(tmpdir(), "discord-meeting-subscription-runtime-"),
  );
  const inputPath = join(tempRoot, "request.json");
  try {
    const encryptionKey = await writePrivateInput(input, inputPath);
    if (encryptionKey.length === 0) {
      return failedResult("backend_unavailable");
    }
    const execution = await input.plan.processRunner.run({
      args: buildCliArgs(input.request, inputPath, input.options, input.plan.profile),
      command: input.admittedInstallation.executableRealpath,
      cwd: input.options.isolatedCwd,
      env: buildChildEnvironment(
        input.options.childSourceEnvironment,
        encryptionKey,
        input.plan.profile.reasoningEffort,
      ),
      killGraceMs: input.options.killGraceMs,
      maxStderrBytes: input.options.maxStderrBytes,
      maxStdoutBytes: input.options.maxStdoutBytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.request.timeoutMs,
    });
    return completeAdmittedExecution({ ...input, execution });
  } catch {
    return failedResult("backend_unavailable");
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function writePrivateInput(
  input: AdmittedExecutionInput,
  inputPath: string,
): Promise<string> {
  await writeFile(inputPath, JSON.stringify(input.request), {
    encoding: "utf8",
    mode: 0o600,
  });
  return (await readFile(input.options.localEncryptionKeyFile, "utf8")).trim();
}

async function completeAdmittedExecution(
  input: CompletedExecutionInput,
): Promise<SubscriptionRuntimeTaskResult> {
  if (input.execution.cancelled === true || signalAborted(input.signal)) {
    return failedResult("task_cancelled");
  }
  const completedInstallation = await inspectCompletedInstallation(input.options);
  if (completedInstallation === undefined) {
    return failedResult("backend_unavailable");
  }
  if (!installationIdentitiesEqual(input.admittedInstallation, completedInstallation)) {
    return failedResult("provider_output_invalid");
  }
  return resolveProcessCompletion({
    completedInstallation,
    execution: input.execution,
    profile: input.plan.profile,
    request: input.request,
    runtimeEngine: input.plan.processRunner.runtimeEngine,
  });
}

async function inspectCompletedInstallation(
  options: SubscriptionRuntimeExecutorOptions,
): Promise<InstallationIdentity | undefined> {
  try {
    return await options.installationInspector.inspect();
  } catch {
    return undefined;
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
