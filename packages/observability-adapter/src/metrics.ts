import type {
  DeadLetterCause,
  DependencyHealth,
  DiscordPublicationOutcome,
  IngressOutcome,
  IngressReason,
  Metrics,
  ProcessingStage,
  ProviderDependency,
  QueueRetryCause,
  QueueState,
  StageOutcome,
} from "./contracts.js";

export type MetricsExpositionFormat = "openmetrics" | "prometheus";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
export const OPENMETRICS_CONTENT_TYPE =
  "application/openmetrics-text; version=1.0.0; charset=utf-8";

const INGRESS_OUTCOMES = ["accepted", "dropped"] as const;
const INGRESS_REASONS = [
  "accepted",
  "duplicate",
  "invalid",
  "over-capacity",
  "shutting-down",
  "unknown",
] as const;
const QUEUE_STATES = ["active", "delayed", "failed", "paused", "waiting"] as const;
const QUEUE_RETRY_CAUSES = [
  "rate-limit",
  "stalled",
  "timeout",
  "transient",
  "unknown",
] as const;
const DEAD_LETTER_CAUSES = [
  "attempts-exhausted",
  "invalid-payload",
  "non-retryable",
  "unknown",
] as const;
const PROCESSING_STAGES = ["publication", "summary", "transcription"] as const;
const STAGE_OUTCOMES = [
  "retryable-failure",
  "succeeded",
  "terminal-failure",
] as const;
const DISCORD_PUBLICATION_OUTCOMES = [
  "duplicate",
  "reconciled",
  "retryable-failure",
  "succeeded",
  "terminal-failure",
] as const;
const PROVIDER_DEPENDENCIES = [
  "database",
  "discord",
  "object-storage",
  "queue",
  "stt",
  "summary-provider",
] as const;
const DEPENDENCY_HEALTH = ["degraded", "healthy", "unhealthy"] as const;

const STAGE_DURATION_BUCKETS = [
  0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
] as const;

type Labels = Readonly<Record<string, string>>;

interface MetricDefinition {
  readonly help: string;
  readonly name: string;
  readonly type: "counter" | "gauge" | "histogram";
}

interface HistogramSample {
  count: number;
  readonly counts: number[];
  sum: number;
}

function requireAllowed<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new RangeError(`${field} has an unsupported bounded label value`);
  }

  return value as T;
}

function requireNonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite non-negative number`);
  }

  return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }

  return value;
}

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .toSorted()
    .map((name) => `${name}\u0000${labels[name]}`)
    .join("\u0001");
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const merged = { ...labels, ...extra };
  const entries = Object.keys(merged)
    .toSorted()
    .map((name) => `${name}="${escapeLabel(merged[name] ?? "")}"`);
  return entries.length === 0 ? "" : `{${entries.join(",")}}`;
}

function renderNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : String(value);
}

class ScalarMetric {
  private readonly labels = new Map<string, Labels>();
  private readonly values = new Map<string, number>();

  public constructor(public readonly definition: MetricDefinition) {}

  public add(labels: Labels, value: number): void {
    const key = labelKey(labels);
    this.labels.set(key, Object.freeze({ ...labels }));
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  public set(labels: Labels, value: number): void {
    const key = labelKey(labels);
    this.labels.set(key, Object.freeze({ ...labels }));
    this.values.set(key, value);
  }

  public render(): readonly string[] {
    return [...this.values.keys()].toSorted().map((key) => {
      const labels = this.labels.get(key) ?? {};
      return `${this.definition.name}${renderLabels(labels)} ${renderNumber(this.values.get(key) ?? 0)}`;
    });
  }
}

class HistogramMetric {
  private readonly labels = new Map<string, Labels>();
  private readonly samples = new Map<string, HistogramSample>();

  public constructor(
    public readonly definition: MetricDefinition,
    private readonly buckets: readonly number[],
  ) {}

  public observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    this.labels.set(key, Object.freeze({ ...labels }));
    const sample = this.samples.get(key) ?? {
      count: 0,
      counts: this.buckets.map(() => 0),
      sum: 0,
    };
    sample.count += 1;
    sample.sum += value;
    for (const [index, upperBound] of this.buckets.entries()) {
      if (value <= upperBound) {
        sample.counts[index] = (sample.counts[index] ?? 0) + 1;
      }
    }
    this.samples.set(key, sample);
  }

  public render(): readonly string[] {
    return [...this.samples.keys()].toSorted().flatMap((key) => {
      const labels = this.labels.get(key) ?? {};
      const sample = this.samples.get(key);
      if (sample === undefined) {
        return [];
      }

      const buckets = this.buckets.map(
        (upperBound, index) =>
          `${this.definition.name}_bucket${renderLabels(labels, { le: renderNumber(upperBound) })} ${sample.counts[index] ?? 0}`,
      );
      buckets.push(
        `${this.definition.name}_bucket${renderLabels(labels, { le: "+Inf" })} ${sample.count}`,
        `${this.definition.name}_sum${renderLabels(labels)} ${renderNumber(sample.sum)}`,
        `${this.definition.name}_count${renderLabels(labels)} ${sample.count}`,
      );
      return buckets;
    });
  }
}

const INGRESS = {
  help: "Ingress requests admitted or dropped by bounded admission control.",
  name: "discord_meeting_ingress_total",
  type: "counter",
} as const;
const QUEUE_JOBS = {
  help: "Current post-call jobs by queue state.",
  name: "discord_meeting_queue_jobs",
  type: "gauge",
} as const;
const QUEUE_RETRIES = {
  help: "Post-call queue retries by bounded cause.",
  name: "discord_meeting_queue_retries_total",
  type: "counter",
} as const;
const DEAD_LETTERS = {
  help: "Post-call jobs moved to dead letter storage by bounded cause.",
  name: "discord_meeting_queue_dead_letters_total",
  type: "counter",
} as const;
const STAGE_DURATION = {
  help: "Post-call stage duration in seconds by stage and outcome.",
  name: "discord_meeting_stage_duration_seconds",
  type: "histogram",
} as const;
const STAGE_OUTCOMES_METRIC = {
  help: "Post-call stage completions by stage and outcome.",
  name: "discord_meeting_stage_outcomes_total",
  type: "counter",
} as const;
const DISCORD_PUBLICATIONS = {
  help: "Discord publication attempts by bounded outcome.",
  name: "discord_meeting_discord_publications_total",
  type: "counter",
} as const;
const PROVIDER_HEALTH = {
  help: "Whether a bounded external dependency is healthy (1 healthy, 0 otherwise).",
  name: "discord_meeting_provider_health",
  type: "gauge",
} as const;

export class PrometheusMetrics implements Metrics {
  private readonly ingress = new ScalarMetric(INGRESS);
  private readonly queueJobs = new ScalarMetric(QUEUE_JOBS);
  private readonly queueRetries = new ScalarMetric(QUEUE_RETRIES);
  private readonly deadLetters = new ScalarMetric(DEAD_LETTERS);
  private readonly stageDuration = new HistogramMetric(
    STAGE_DURATION,
    STAGE_DURATION_BUCKETS,
  );
  private readonly stageOutcomes = new ScalarMetric(STAGE_OUTCOMES_METRIC);
  private readonly discordPublications = new ScalarMetric(DISCORD_PUBLICATIONS);
  private readonly providerHealth = new ScalarMetric(PROVIDER_HEALTH);

  public observeStage(
    stage: ProcessingStage,
    outcome: StageOutcome,
    durationSeconds: number,
  ): void {
    const labels = {
      outcome: requireAllowed(outcome, STAGE_OUTCOMES, "outcome"),
      stage: requireAllowed(stage, PROCESSING_STAGES, "stage"),
    };
    this.stageDuration.observe(
      labels,
      requireNonNegativeFinite(durationSeconds, "durationSeconds"),
    );
    this.stageOutcomes.add(labels, 1);
  }

  public recordDeadLetter(cause: DeadLetterCause): void {
    this.deadLetters.add(
      { cause: requireAllowed(cause, DEAD_LETTER_CAUSES, "cause") },
      1,
    );
  }

  public recordDiscordPublication(outcome: DiscordPublicationOutcome): void {
    this.discordPublications.add(
      {
        outcome: requireAllowed(
          outcome,
          DISCORD_PUBLICATION_OUTCOMES,
          "outcome",
        ),
      },
      1,
    );
  }

  public recordIngress(outcome: IngressOutcome, reason: IngressReason): void {
    const safeOutcome = requireAllowed(outcome, INGRESS_OUTCOMES, "outcome");
    const safeReason = requireAllowed(reason, INGRESS_REASONS, "reason");
    if (
      (safeOutcome === "accepted" && safeReason !== "accepted") ||
      (safeOutcome === "dropped" && safeReason === "accepted")
    ) {
      throw new RangeError("ingress outcome and reason are inconsistent");
    }
    this.ingress.add({ outcome: safeOutcome, reason: safeReason }, 1);
  }

  public recordQueueRetry(cause: QueueRetryCause): void {
    this.queueRetries.add(
      { cause: requireAllowed(cause, QUEUE_RETRY_CAUSES, "cause") },
      1,
    );
  }

  public render(format: MetricsExpositionFormat = "prometheus"): string {
    const safeFormat = requireAllowed(
      format,
      ["openmetrics", "prometheus"],
      "format",
    );

    const metrics: readonly (ScalarMetric | HistogramMetric)[] = [
      this.ingress,
      this.queueJobs,
      this.queueRetries,
      this.deadLetters,
      this.stageDuration,
      this.stageOutcomes,
      this.discordPublications,
      this.providerHealth,
    ];
    const lines = metrics.flatMap((metric) => [
      `# HELP ${metric.definition.name} ${metric.definition.help}`,
      `# TYPE ${metric.definition.name} ${metric.definition.type}`,
      ...metric.render(),
    ]);
    if (safeFormat === "openmetrics") {
      lines.push("# EOF");
    }

    return `${lines.join("\n")}\n`;
  }

  public setProviderHealth(
    dependency: ProviderDependency,
    health: DependencyHealth,
  ): void {
    const safeDependency = requireAllowed(
      dependency,
      PROVIDER_DEPENDENCIES,
      "dependency",
    );
    const safeHealth = requireAllowed(health, DEPENDENCY_HEALTH, "health");
    this.providerHealth.set(
      { dependency: safeDependency },
      safeHealth === "healthy" ? 1 : 0,
    );
  }

  public setQueueState(state: QueueState, jobs: number): void {
    this.queueJobs.set(
      { state: requireAllowed(state, QUEUE_STATES, "state") },
      requireNonNegativeInteger(jobs, "jobs"),
    );
  }
}
