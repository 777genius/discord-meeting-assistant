import type {
  SubscriptionRuntimeEngine,
  SubscriptionRuntimeAgentTaskRequest,
  SubscriptionRuntimeHealthResult,
  SubscriptionRuntimeTaskResult,
} from "@discord-meeting/subscription-runtime-adapter";

export interface SidecarExecutorPort {
  checkHealth(): Promise<SubscriptionRuntimeHealthResult>;

  execute(
    request: SubscriptionRuntimeAgentTaskRequest,
    signal?: AbortSignal,
  ): Promise<SubscriptionRuntimeTaskResult>;
}

export interface InstallationIdentity {
  readonly executableRealpath: string;
  readonly launcherSha256: string;
  readonly packageManifestRealpath: string;
  readonly packageRootRealpath: string;
  readonly runtimePackageVersion: string;
}

export interface InstallationInspectorPort {
  inspect(): Promise<InstallationIdentity>;
}

export interface RuntimeReadinessInspectorPort {
  inspect(): Promise<void>;
}

export interface ProcessRunRequest {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly killGraceMs: number;
  readonly maxStderrBytes: number;
  readonly maxStdoutBytes: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface ProcessRunResult {
  readonly exitCode: number | null;
  readonly cancelled?: boolean;
  readonly outputLimitExceeded: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface ProcessRunnerPort {
  readonly runtimeEngine: SubscriptionRuntimeEngine;

  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}
