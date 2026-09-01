export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  child(context: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  flush(): Promise<void>;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
}

export type IngressOutcome = "accepted" | "dropped";
export type IngressReason =
  | "accepted"
  | "duplicate"
  | "invalid"
  | "over-capacity"
  | "shutting-down"
  | "unknown";
export type DerivedLiveFailurePhase = "lifecycle" | "prepare-final" | "voice";
export type QueueState = "active" | "delayed" | "failed" | "paused" | "waiting";
export type QueueRetryCause =
  | "rate-limit"
  | "stalled"
  | "timeout"
  | "transient"
  | "unknown";
export type DeadLetterCause =
  | "attempts-exhausted"
  | "invalid-payload"
  | "non-retryable"
  | "unknown";
export type ProcessingStage = "publication" | "summary" | "transcription";
export type StageOutcome =
  | "retryable-failure"
  | "succeeded"
  | "terminal-failure";
export type DiscordPublicationOutcome =
  | "duplicate"
  | "reconciled"
  | "retryable-failure"
  | "succeeded"
  | "terminal-failure";
export type ProviderDependency =
  | "database"
  | "discord"
  | "object-storage"
  | "queue"
  | "stt"
  | "summary-provider";
export type DependencyHealth = "degraded" | "healthy" | "unhealthy";

export interface ProcessingStageMetrics {
  observeStage(
    stage: ProcessingStage,
    outcome: StageOutcome,
    durationSeconds: number,
  ): void;
}

export interface DeadLetterMetrics {
  recordDeadLetter(cause: DeadLetterCause): void;
}

export interface DiscordPublicationMetrics {
  recordDiscordPublication(outcome: DiscordPublicationOutcome): void;
}

export type LiveMemoryProjectionOutcome = "applied" | "reconciled";

export interface LiveMemoryProjectionMetrics {
  observeLiveMemoryProjection(
    outcome: LiveMemoryProjectionOutcome,
    ingestToQuerySeconds: number,
  ): void;
}

export interface IngressMetrics {
  recordIngress(outcome: IngressOutcome, reason: IngressReason): void;
  recordDerivedLiveFailure(phase: DerivedLiveFailurePhase): void;
}

export interface QueueMetrics {
  recordQueueRetry(cause: QueueRetryCause): void;
  setQueueState(state: QueueState, jobs: number): void;
}

export interface ProviderHealthMetrics {
  setProviderHealth(
    dependency: ProviderDependency,
    health: DependencyHealth,
  ): void;
}

export interface Metrics
  extends DeadLetterMetrics,
    DiscordPublicationMetrics,
    IngressMetrics,
    LiveMemoryProjectionMetrics,
    ProcessingStageMetrics,
    ProviderHealthMetrics,
    QueueMetrics {}

export interface HealthProbeResult {
  readonly code?: string;
  readonly status: DependencyHealth;
}

export interface HealthProbe {
  readonly critical: boolean;
  readonly name: string;
  check(signal: AbortSignal): Promise<HealthProbeResult>;
}

export interface DependencyHealthSnapshot {
  readonly code?: string;
  readonly critical: boolean;
  readonly name: string;
  readonly status: DependencyHealth;
}

export interface HealthSnapshot {
  readonly checkedAt: string;
  readonly dependencies: readonly DependencyHealthSnapshot[];
  readonly ready: boolean;
  readonly status: DependencyHealth;
}

export interface HealthReporter {
  snapshot(): Promise<HealthSnapshot>;
}
