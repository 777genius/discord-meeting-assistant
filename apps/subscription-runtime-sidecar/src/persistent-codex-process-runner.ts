import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  JsonObject,
  SubscriptionRuntimeExecutionProfile,
} from "@discord-meeting/subscription-runtime-adapter";
import { subscriptionRuntimeEngine } from "@discord-meeting/subscription-runtime-adapter";

import type {
  ProcessRunnerPort,
  ProcessRunRequest,
  ProcessRunResult,
} from "./types.js";

interface RuntimeWorkerResult {
  readonly outputText: string;
  readonly status?: "completed" | "waiting_for_input";
  readonly structuredOutput?: unknown;
  readonly usage?: Readonly<Record<string, number>>;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
}

interface RuntimeWorker {
  dispose(): Promise<void>;
  prewarm(): Promise<unknown>;
  run(input: {
    readonly abortSignal: AbortSignal;
    readonly controls: JsonObject;
    readonly kind: "structured-prompt";
    readonly metadata: Readonly<Record<string, string>>;
    readonly outputSchemaName: string;
    readonly prompt: string;
    readonly runId: string;
    readonly systemPrompt: string;
  }): Promise<RuntimeWorkerResult>;
  seedCodexAuthJsonFile(path: string): Promise<void>;
  start(): Promise<void>;
}

interface RuntimeWorkerConstructor {
  new (options: Readonly<Record<string, unknown>>): RuntimeWorker;
}

interface RuntimeWorkerModule {
  readonly FileBackendCodexWorker: RuntimeWorkerConstructor;
}

interface LauncherPolicyModule {
  readonly admitMeetingSummaryRequest: (input: {
    readonly model: string;
    readonly provider: "codex";
    readonly reasoningEffort: string;
    readonly request: unknown;
  }) => unknown;
}

export interface PersistentCodexProfile {
  readonly execution: SubscriptionRuntimeExecutionProfile;
  readonly outputSchema: JsonObject;
}

export interface PersistentCodexProcessRunnerOptions {
  readonly authJsonPath: string;
  readonly codexBinaryPath?: string;
  readonly launcherPath: string;
  readonly packageManifestPath: string;
  readonly providerInstanceId: string;
  readonly stateRoot: string;
  readonly workspacePath: string;
  readonly launcherPolicyLoader?: (path: string) => Promise<LauncherPolicyModule>;
  readonly workerModuleLoader?: (path: string) => Promise<RuntimeWorkerModule>;
}

interface WorkerSlot {
  readonly profile: PersistentCodexProfile;
  readonly worker: RuntimeWorker;
}

/**
 * Keeps the provider-neutral sidecar contract while reusing Subscription
 * Runtime's app-server worker and clean-thread prewarm between requests.
 * The pinned runtime itself owns app-server -> packaged-exec fallback.
 */
export class PersistentCodexProcessRunner implements ProcessRunnerPort {
  public readonly runtimeEngine = subscriptionRuntimeEngine;

  private readonly slots = new Map<string, Promise<WorkerSlot>>();
  private disposed = false;

  public constructor(
    private readonly options: PersistentCodexProcessRunnerOptions,
  ) {}

  public async prewarm(
    profile: PersistentCodexProfile,
    environment: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.slot(profile, environment);
  }

  public async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    if (this.disposed) {
      throw new Error("Persistent Codex runner is disposed");
    }
    if (request.signal?.aborted === true) {
      return cancelledResult();
    }
    if (await realpath(request.command) !== await realpath(this.options.launcherPath)) {
      throw new Error("Runtime launcher conflicts with persistent runner policy");
    }
    const inputPath = argumentValue(request.args, "--input");
    const canonical = parseCanonicalRequest(
      JSON.parse(await readFile(inputPath, "utf8")) as unknown,
    );
    const launcherPolicy = await (
      this.options.launcherPolicyLoader ?? loadLauncherPolicy
    )(request.command);
    launcherPolicy.admitMeetingSummaryRequest({
      model: argumentValue(request.args, "--model"),
      provider: "codex",
      reasoningEffort: requiredEnvironment(
        request.env,
        "AGENT_RUNTIME_REASONING_EFFORT",
      ),
      request: canonical,
    });
    const profile: PersistentCodexProfile = {
      execution: {
        maxOutputTokens: canonical.task.controls.maxOutputTokens as SubscriptionRuntimeExecutionProfile["maxOutputTokens"],
        model: canonical.task.controls.model as SubscriptionRuntimeExecutionProfile["model"],
        outputSchemaName: canonical.task.controls.outputSchemaName as SubscriptionRuntimeExecutionProfile["outputSchemaName"],
        policyVersion: canonical.task.metadata.policyVersion as SubscriptionRuntimeExecutionProfile["policyVersion"],
        purpose: canonical.context.purpose as SubscriptionRuntimeExecutionProfile["purpose"],
        reasoningEffort: canonical.task.controls.reasoningEffort as SubscriptionRuntimeExecutionProfile["reasoningEffort"],
      },
      outputSchema: canonical.task.controls.outputSchema,
    };
    const slot = await this.slot(profile, request.env);
    const cancellation = new AbortController();
    const timing = { timedOut: false };
    const abort = (): void => {
      cancellation.abort();
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timing.timedOut = true;
      cancellation.abort();
    }, request.timeoutMs);
    timeout.unref();
    try {
      const result = await slot.worker.run({
        abortSignal: cancellation.signal,
        controls: canonical.task.controls,
        kind: "structured-prompt",
        metadata: canonical.task.metadata,
        outputSchemaName: canonical.task.outputSchemaName,
        prompt: canonical.task.prompt,
        runId: canonical.runId,
        systemPrompt: structuredOutputSystemPrompt(
          canonical.task.systemPrompt,
          profile,
        ),
      });
      if (timing.timedOut) {
        return timedOutResult();
      }
      if (signalAborted(request.signal)) {
        return cancelledResult();
      }
      const stdout = JSON.stringify({
        protocolVersion: 1,
        status: result.status ?? "completed",
        outputText: result.outputText,
        ...(result.structuredOutput === undefined
          ? {}
          : { structuredOutput: result.structuredOutput }),
        ...(result.usage === undefined
          ? {}
          : { telemetry: { usage: result.usage } }),
        warnings: result.warnings,
      });
      return boundedResult(stdout, request.maxStdoutBytes);
    } catch (error: unknown) {
      if (timing.timedOut) {
        return timedOutResult();
      }
      if (signalAborted(request.signal) || cancellation.signal.aborted) {
        return cancelledResult();
      }
      const reason = safeErrorChain(error);
      process.stderr.write(`Subscription runtime conversation worker failed: ${reason}\n`);
      const stdout = JSON.stringify({
        protocolVersion: 1,
        status: "failed",
        failure: safeRuntimeFailure(error),
        warnings: [],
      });
      return boundedResult(stdout, request.maxStdoutBytes, 1);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const slots = await Promise.allSettled(this.slots.values());
    await Promise.allSettled(
      slots.flatMap((slot) =>
        slot.status === "fulfilled" ? [slot.value.worker.dispose()] : [],
      ),
    );
    this.slots.clear();
  }

  private async slot(
    profile: PersistentCodexProfile,
    environment: Readonly<Record<string, string>>,
  ): Promise<WorkerSlot> {
    const key = profile.execution.purpose;
    const existing = this.slots.get(key);
    if (existing !== undefined) {
      const slot = await existing;
      assertSameProfile(slot.profile, profile);
      return slot;
    }
    const pending = this.createSlot(profile, environment);
    this.slots.set(key, pending);
    try {
      return await pending;
    } catch (error: unknown) {
      this.slots.delete(key);
      throw error;
    }
  }

  private async createSlot(
    profile: PersistentCodexProfile,
    environment: Readonly<Record<string, string>>,
  ): Promise<WorkerSlot> {
    const encryptionKey = requiredEnvironment(
      environment,
      "SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY",
    );
    const modulePath = join(
      dirname(await realpath(this.options.packageManifestPath)),
      "dist/worker-codex/index.js",
    );
    const runtime = await (this.options.workerModuleLoader ?? loadWorkerModule)(
      modulePath,
    );
    const sourceEnvironment = { ...environment };
    delete sourceEnvironment.SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY;
    delete sourceEnvironment.AGENT_RUNTIME_REASONING_EFFORT;
    const worker = new runtime.FileBackendCodexWorker({
      cleanThreadPrewarm: true,
      codexBinaryPath: this.options.codexBinaryPath ?? "codex",
      encryptionKey,
      executionEngine: "app-server",
      executionProfile: "stateless-completion",
      model: profile.execution.model,
      outputSchemas: {
        [profile.execution.outputSchemaName]: profile.outputSchema,
      },
      providerInstanceId: this.options.providerInstanceId,
      reasoningEffort: profile.execution.reasoningEffort,
      sessionCacheSlots: 1,
      sourceEnv: sourceEnvironment,
      stateRootDir: this.options.stateRoot,
      taskTimeoutMs: 600_000,
      warmupPrompt: "Return exactly OK.",
      workerId: `discord-meeting-${profile.execution.purpose.replaceAll(".", "-")}`,
      workspacePath: this.options.workspacePath,
    });
    await worker.start();
    try {
      await worker.seedCodexAuthJsonFile(this.options.authJsonPath);
      await worker.prewarm();
      return { profile, worker };
    } catch (error: unknown) {
      await worker.dispose().catch(() => null);
      throw error;
    }
  }
}

function safeErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    parts.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return (parts.length === 0 ? "unknown worker failure" : parts.join(" <- "))
    .replaceAll(/[\r\n]+/gu, " ")
    .slice(0, 2_000);
}

async function loadWorkerModule(path: string): Promise<RuntimeWorkerModule> {
  return await import(pathToFileURL(path).href) as RuntimeWorkerModule;
}

async function loadLauncherPolicy(path: string): Promise<LauncherPolicyModule> {
  return await import(pathToFileURL(path).href) as LauncherPolicyModule;
}

function parseCanonicalRequest(value: unknown): {
  readonly context: { readonly purpose: string };
  readonly runId: string;
  readonly task: {
    readonly controls: JsonObject & {
      readonly maxOutputTokens: number;
      readonly model: string;
      readonly outputSchema: JsonObject;
      readonly outputSchemaName: string;
      readonly reasoningEffort: string;
    };
    readonly metadata: Readonly<Record<string, string>> & {
      readonly policyVersion: string;
    };
    readonly outputSchemaName: string;
    readonly prompt: string;
    readonly systemPrompt: string;
  };
} {
  if (!isRecord(value) || !isRecord(value.context) || !isRecord(value.task)) {
    throw new Error("Persistent runtime request is malformed");
  }
  const controls = value.task.controls;
  const metadata = value.task.metadata;
  if (
    !isRecord(controls) ||
    !isRecord(controls.outputSchema) ||
    !isString(value.context.purpose) ||
    !isString(value.runId) ||
    !isRecord(metadata) ||
    !isString(metadata.policyVersion) ||
    !isString(value.task.outputSchemaName) ||
    !isString(value.task.prompt) ||
    !isString(value.task.systemPrompt) ||
    !isString(controls.model) ||
    !isString(controls.outputSchemaName) ||
    !isString(controls.reasoningEffort) ||
    !Number.isSafeInteger(controls.maxOutputTokens)
  ) {
    throw new Error("Persistent runtime request conflicts with its admitted profile");
  }
  return value as ReturnType<typeof parseCanonicalRequest>;
}

function assertSameProfile(
  left: PersistentCodexProfile,
  right: PersistentCodexProfile,
): void {
  if (
    JSON.stringify(left.execution) !== JSON.stringify(right.execution) ||
    JSON.stringify(left.outputSchema) !== JSON.stringify(right.outputSchema)
  ) {
    throw new Error("Persistent worker profile changed after prewarm");
  }
}

function structuredOutputSystemPrompt(
  systemPrompt: string,
  profile: PersistentCodexProfile,
): string {
  return [
    systemPrompt,
    "",
    "Output contract:",
    "Return only one JSON value with no markdown or commentary.",
    `It must match JSON Schema ${profile.execution.outputSchemaName}:`,
    JSON.stringify(profile.outputSchema),
  ].join("\n");
}

function safeRuntimeFailure(error: unknown): Readonly<Record<string, unknown>> {
  const code = runtimeFailureCode(error);
  return {
    causeCategory: "subscription_runtime",
    code,
    reconnectRequired: code === "needs_reconnect",
    retryable: new Set([
      "backend_unavailable",
      "needs_reconnect",
      "quota_limited",
      "task_timeout",
    ]).has(code),
    safeMessage: "Subscription runtime worker could not complete the task",
  };
}

function runtimeFailureCode(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : "";
  if (/quota|usage.?limit/iu.test(text)) {
    return "quota_limited";
  }
  if (/reconnect|refresh.?token|auth.?expired/iu.test(text)) {
    return "needs_reconnect";
  }
  if (/permission/iu.test(text)) {
    return "permission_required";
  }
  if (/timeout|timed.?out/iu.test(text)) {
    return "task_timeout";
  }
  return "backend_unavailable";
}

function argumentValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} is required by persistent runner policy`);
  }
  return value;
}

function requiredEnvironment(
  environment: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required by persistent runner policy`);
  }
  return value;
}

function boundedResult(
  stdout: string,
  maximumBytes: number,
  exitCode = 0,
): ProcessRunResult {
  const encoded = Buffer.from(stdout, "utf8");
  return {
    exitCode,
    outputLimitExceeded: encoded.length > maximumBytes,
    signal: null,
    stderr: "",
    stdout: encoded.length > maximumBytes
      ? encoded.subarray(0, maximumBytes).toString("utf8")
      : stdout,
    timedOut: false,
  };
}

function cancelledResult(): ProcessRunResult {
  return {
    cancelled: true,
    exitCode: null,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

function timedOutResult(): ProcessRunResult {
  return {
    exitCode: null,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: "",
    timedOut: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
