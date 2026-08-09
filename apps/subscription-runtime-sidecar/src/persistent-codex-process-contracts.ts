import type {
  JsonObject,
  SubscriptionRuntimeExecutionProfile,
} from "@discord-meeting/subscription-runtime-adapter";

import type { SubscriptionRuntimeAccount } from "./subscription-account-pool.js";

export interface RuntimeWorkerResult {
  readonly outputText: string;
  readonly status?: "completed" | "waiting_for_input";
  readonly structuredOutput?: unknown;
  readonly usage?: Readonly<Record<string, number>>;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
}

export interface RuntimeWorkerJob {
  readonly abortSignal: AbortSignal;
  readonly controls: JsonObject;
  readonly kind: "structured-prompt";
  readonly metadata: Readonly<Record<string, string>>;
  readonly outputSchemaName: string;
  readonly prompt: string;
  readonly runId: string;
  readonly systemPrompt: string;
}

export interface RuntimeWorkerRunOptions {
  readonly abortSignal?: AbortSignal;
  readonly onProviderTaskStarted?: () => Promise<void> | void;
  readonly onProviderTextDelta?: (text: string) => void;
}

export interface RuntimeWorker {
  readonly state: string;
  readonly workerId: string;
  dispose(): Promise<void>;
  health(): Promise<unknown>;
  prewarm(): Promise<unknown>;
  run(
    input: RuntimeWorkerJob,
    options?: RuntimeWorkerRunOptions,
  ): Promise<RuntimeWorkerResult>;
  start(): Promise<void>;
}

interface RuntimeCodexWorker extends RuntimeWorker {
  seedCodexAuthJsonFile(path: string): Promise<void>;
}

interface RuntimeWorkerConstructor {
  new (options: Readonly<Record<string, unknown>>): RuntimeCodexWorker;
}

export interface RuntimeWorkerModule {
  readonly FileBackendCodexWorker: RuntimeWorkerConstructor;
}

interface RuntimeWorkerPool {
  dispose(): Promise<void>;
  run(
    input: RuntimeWorkerJob,
    options?: RuntimeWorkerRunOptions,
  ): Promise<RuntimeWorkerResult>;
  start(): Promise<void>;
}

interface RuntimeWorkerPoolConstructor {
  new (options: {
    readonly maxQueueSize: number;
    readonly poolId: string;
    readonly prewarmOnStart: boolean;
    readonly slots: number;
    readonly workerFactory: (input: {
      readonly slotIndex: number;
      readonly workerId: string;
    }) => RuntimeWorker;
  }): RuntimeWorkerPool;
}

export interface RuntimeWorkerPoolModule {
  readonly BoundedSubscriptionWorkerPool: RuntimeWorkerPoolConstructor;
}

export interface LauncherPolicyModule {
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
  readonly accounts: readonly SubscriptionRuntimeAccount[];
  readonly codexBinaryPath?: string;
  readonly launcherPath: string;
  readonly packageManifestPath: string;
  readonly stateRoot: string;
  readonly workspacePath: string;
  readonly maximumConcurrentTasksPerAccount: number;
  readonly maximumQueuedTasks: number;
  readonly launcherPolicyLoader?: (path: string) => Promise<LauncherPolicyModule>;
  readonly workerPoolModuleLoader?: (path: string) => Promise<RuntimeWorkerPoolModule>;
  readonly workerModuleLoader?: (path: string) => Promise<RuntimeWorkerModule>;
}

export interface PersistentCodexWorkerPool {
  readonly accountId: string;
  readonly profile: PersistentCodexProfile;
  readonly pool: RuntimeWorkerPool;
}
