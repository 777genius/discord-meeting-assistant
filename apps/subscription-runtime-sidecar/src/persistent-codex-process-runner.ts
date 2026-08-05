import { readFile, realpath } from "node:fs/promises";

import { subscriptionRuntimeEngine } from "@discord-meeting/subscription-runtime-adapter";

import type {
  PersistentCodexProcessRunnerOptions,
  PersistentCodexProfile,
  PersistentCodexWorkerSlot,
} from "./persistent-codex-process-contracts.js";
import {
  persistentCodexArgumentValue,
  assertSamePersistentCodexProfile,
  loadPersistentCodexLauncherPolicy,
  parsePersistentCodexRequest,
  profileForPersistentCodexRequest,
  requiredPersistentCodexEnvironment,
  structuredPersistentCodexOutputSystemPrompt,
} from "./persistent-codex-request.js";
import {
  persistentCodexBoundedResult,
  persistentCodexCancelledResult,
  persistentCodexSafeErrorChain,
  persistentCodexSafeRuntimeFailure,
  persistentCodexSignalAborted,
  persistentCodexTimedOutResult,
} from "./persistent-codex-run-result.js";
import { createPersistentCodexWorkerSlot } from "./persistent-codex-worker.js";
import type {
  ProviderTaskStreamObserver,
  ProcessRunRequest,
  ProcessRunResult,
  StreamingProcessRunnerPort,
} from "./types.js";

export type {
  PersistentCodexProcessRunnerOptions,
  PersistentCodexProfile,
} from "./persistent-codex-process-contracts.js";

/**
 * Keeps the provider-neutral sidecar contract while reusing Subscription
 * Runtime's app-server worker and clean-thread prewarm between requests.
 * The pinned runtime itself owns app-server -> packaged-exec fallback.
 */
export class PersistentCodexProcessRunner implements StreamingProcessRunnerPort {
  public readonly runtimeEngine = subscriptionRuntimeEngine;

  private readonly slots = new Map<string, Promise<PersistentCodexWorkerSlot>>();
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
    return await this.runRequest(request);
  }

  public async runStreaming(
    request: ProcessRunRequest,
    observer: ProviderTaskStreamObserver,
  ): Promise<ProcessRunResult> {
    return await this.runRequest(request, observer);
  }

  private async runRequest(
    request: ProcessRunRequest,
    observer?: ProviderTaskStreamObserver,
  ): Promise<ProcessRunResult> {
    if (this.disposed) {
      throw new Error("Persistent Codex runner is disposed");
    }
    if (request.signal?.aborted === true) {
      return persistentCodexCancelledResult();
    }
    if (await realpath(request.command) !== await realpath(this.options.launcherPath)) {
      throw new Error("Runtime launcher conflicts with persistent runner policy");
    }
    const inputPath = persistentCodexArgumentValue(request.args, "--input");
    const canonical = parsePersistentCodexRequest(
      JSON.parse(await readFile(inputPath, "utf8")) as unknown,
    );
    const launcherPolicy = await (
      this.options.launcherPolicyLoader ?? loadPersistentCodexLauncherPolicy
    )(request.command);
    launcherPolicy.admitMeetingSummaryRequest({
      model: persistentCodexArgumentValue(request.args, "--model"),
      provider: "codex",
      reasoningEffort: requiredPersistentCodexEnvironment(
        request.env,
        "AGENT_RUNTIME_REASONING_EFFORT",
      ),
      request: canonical,
    });
    const slot = await this.slot(
      profileForPersistentCodexRequest(canonical),
      request.env,
    );
    return await this.runWorker(slot, canonical, request, observer);
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

  private async runWorker(
    slot: PersistentCodexWorkerSlot,
    canonical: ReturnType<typeof parsePersistentCodexRequest>,
    request: ProcessRunRequest,
    observer?: ProviderTaskStreamObserver,
  ): Promise<ProcessRunResult> {
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
      const result = await slot.worker.run(
        {
          abortSignal: cancellation.signal,
          controls: canonical.task.controls,
          kind: "structured-prompt",
          metadata: canonical.task.metadata,
          outputSchemaName: canonical.task.outputSchemaName,
          prompt: canonical.task.prompt,
          runId: canonical.runId,
          systemPrompt: structuredPersistentCodexOutputSystemPrompt(
            canonical.task.systemPrompt,
            slot.profile,
          ),
        },
        {
          abortSignal: cancellation.signal,
          ...(observer === undefined
            ? {}
            : {
                onProviderTaskStarted: async () => {
                  await observer.onProviderTaskStarted();
                },
                onProviderTextDelta: (text: string) => {
                  observer.onProviderTextDelta(text);
                },
              }),
        },
      );
      if (timing.timedOut) {
        return persistentCodexTimedOutResult();
      }
      if (persistentCodexSignalAborted(request.signal)) {
        return persistentCodexCancelledResult();
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
      return persistentCodexBoundedResult(stdout, request.maxStdoutBytes);
    } catch (error: unknown) {
      if (timing.timedOut) {
        return persistentCodexTimedOutResult();
      }
      if (persistentCodexSignalAborted(request.signal) || cancellation.signal.aborted) {
        return persistentCodexCancelledResult();
      }
      const reason = persistentCodexSafeErrorChain(error);
      process.stderr.write(`Subscription runtime conversation worker failed: ${reason}\n`);
      const stdout = JSON.stringify({
        protocolVersion: 1,
        status: "failed",
        failure: persistentCodexSafeRuntimeFailure(error),
        warnings: [],
      });
      return persistentCodexBoundedResult(stdout, request.maxStdoutBytes, 1);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
    }
  }

  private async slot(
    profile: PersistentCodexProfile,
    environment: Readonly<Record<string, string>>,
  ): Promise<PersistentCodexWorkerSlot> {
    const key = profile.execution.purpose;
    const existing = this.slots.get(key);
    if (existing !== undefined) {
      const slot = await existing;
      assertSamePersistentCodexProfile(slot.profile, profile);
      return slot;
    }
    const pending = createPersistentCodexWorkerSlot(this.options, profile, environment);
    this.slots.set(key, pending);
    try {
      return await pending;
    } catch (error: unknown) {
      this.slots.delete(key);
      throw error;
    }
  }
}
