import { readFile, realpath } from "node:fs/promises";

import { subscriptionRuntimeEngine } from "@discord-meeting/subscription-runtime-adapter";

import type {
  PersistentCodexProcessRunnerOptions,
  PersistentCodexProfile,
  PersistentCodexWorkerGroup,
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
import { createPersistentCodexWorkerGroup } from "./persistent-codex-worker.js";
import type { SubscriptionRuntimeAccount } from "./subscription-account-pool.js";
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

export interface AccountPoolPrewarmResult {
  readonly failures: readonly {
    readonly code: string;
    readonly slotId: string;
  }[];
  readonly readyAccounts: number;
  readonly totalAccounts: number;
}

/**
 * Keeps the provider-neutral sidecar contract while reusing Subscription
 * Runtime's app-server worker and clean-thread prewarm between requests.
 * The pinned runtime itself owns app-server -> packaged-exec fallback.
 */
export class PersistentCodexProcessRunner implements StreamingProcessRunnerPort {
  public readonly runtimeEngine = subscriptionRuntimeEngine;

  private readonly groups = new Map<string, Promise<PersistentCodexWorkerGroup>>();
  private disposed = false;

  public constructor(
    private readonly options: PersistentCodexProcessRunnerOptions,
  ) {}

  public async prewarm(
    profile: PersistentCodexProfile,
    environment: Readonly<Record<string, string>>,
    accountId: string,
  ): Promise<void> {
    await this.group(profile, environment, this.accountById(accountId));
  }

  public async prewarmAccounts(
    profile: PersistentCodexProfile,
    environment: Readonly<Record<string, string>>,
  ): Promise<AccountPoolPrewarmResult> {
    const results = await Promise.allSettled(
      this.options.accounts.map(async (account) =>
        this.group(profile, environment, account)),
    );
    const failures = results.flatMap((result, index) => {
      if (result.status === "fulfilled") {
        return [];
      }
      const account = this.options.accounts[index];
      if (account === undefined) {
        throw new Error("Persistent Codex account prewarm result is invalid");
      }
      const failure = persistentCodexSafeRuntimeFailure(result.reason);
      return [{
        code: typeof failure.code === "string"
          ? failure.code
          : "backend_unavailable",
        slotId: account.id,
      }];
    });
    const readyAccounts = this.options.accounts.length - failures.length;
    if (readyAccounts === 0) {
      throw new Error(
        `Persistent Codex account pool prewarm failed: ${failures.map(
          (failure) => `${failure.slotId}=${failure.code}`,
        ).join(",")}`,
      );
    }
    return {
      failures,
      readyAccounts,
      totalAccounts: this.options.accounts.length,
    };
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
    const group = await this.group(
      profileForPersistentCodexRequest(canonical),
      request.env,
      this.accountForRequest(request),
    );
    return await this.runWorker(group, canonical, request, observer);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const groups = await Promise.allSettled(this.groups.values());
    await Promise.allSettled(
      groups.flatMap((group) =>
        group.status === "fulfilled" ? [group.value.group.dispose()] : [],
      ),
    );
    this.groups.clear();
  }

  private async runWorker(
    workerGroup: PersistentCodexWorkerGroup,
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
      const result = await workerGroup.group.run(
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
            workerGroup.profile,
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
      return {
        ...persistentCodexBoundedResult(stdout, request.maxStdoutBytes),
        ...(workerGroup.profile.execution.serviceTier === undefined
          ? {}
          : { serviceTier: workerGroup.profile.execution.serviceTier }),
      };
    } catch (error: unknown) {
      if (timing.timedOut) {
        return persistentCodexTimedOutResult();
      }
      if (persistentCodexSignalAborted(request.signal) || cancellation.signal.aborted) {
        return persistentCodexCancelledResult();
      }
      const reason = persistentCodexSafeErrorChain(error);
      process.stderr.write(`Subscription runtime persistent worker failed: ${reason}\n`);
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

  private async group(
    profile: PersistentCodexProfile,
    environment: Readonly<Record<string, string>>,
    account: SubscriptionRuntimeAccount,
  ): Promise<PersistentCodexWorkerGroup> {
    const key = `${account.id}:${profile.execution.purpose}`;
    const existing = this.groups.get(key);
    if (existing !== undefined) {
      const group = await existing;
      assertSamePersistentCodexProfile(group.profile, profile);
      return group;
    }
    const pending = createPersistentCodexWorkerGroup(
      this.options,
      profile,
      environment,
      account,
    );
    this.groups.set(key, pending);
    try {
      return await pending;
    } catch (error: unknown) {
      this.groups.delete(key);
      throw error;
    }
  }

  private accountForRequest(
    request: ProcessRunRequest,
  ): SubscriptionRuntimeAccount {
    const authJsonPath = persistentCodexArgumentValue(
      request.args,
      "--codex-auth-json",
    );
    const requestedProviderInstanceId = persistentCodexArgumentValue(
      request.args,
      "--provider-instance",
    );
    const requestedStateRoot = persistentCodexArgumentValue(
      request.args,
      "--state-root",
    );
    if (requestedStateRoot !== this.options.stateRoot) {
      throw new Error("Persistent worker state root conflicts with policy");
    }
    const account = this.options.accounts.find(
      (candidate) =>
        candidate.authJsonPath === authJsonPath &&
        candidate.providerInstanceId === requestedProviderInstanceId,
    );
    if (account === undefined) {
      throw new Error("Persistent worker account conflicts with policy");
    }
    return account;
  }

  private accountById(accountId: string): SubscriptionRuntimeAccount {
    const account = this.options.accounts.find(
      (candidate) => candidate.id === accountId,
    );
    if (account === undefined) {
      throw new Error("Persistent worker account is not admitted");
    }
    return account;
  }
}
