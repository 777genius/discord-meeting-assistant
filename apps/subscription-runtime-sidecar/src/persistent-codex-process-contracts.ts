import type {
  JsonObject,
  SubscriptionRuntimeExecutionProfile,
} from "@discord-meeting/subscription-runtime-adapter";

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

export interface RuntimeWorkerModule {
  readonly FileBackendCodexWorker: RuntimeWorkerConstructor;
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

export interface PersistentCodexWorkerSlot {
  readonly profile: PersistentCodexProfile;
  readonly worker: RuntimeWorker;
}
