import type {
  LiveFinalizedMemoryLeaseV1,
  LiveFinalizedMemoryProjectionPort,
  LiveFinalizedMemoryProjectionResultV1,
  LiveFinalizedMemoryProjectionV1,
  LiveFinalizedMemoryTelemetryPort,
  LiveFinalizedMemorySyncStore,
} from "./ports/live-finalized-memory.js";
import type { CanonicalEvidenceTurnHashPort } from "./ports/final-reply.js";

export interface LiveFinalizedMemoryPolicyV1 {
  readonly leaseDurationMs: number;
  readonly maximumAttempts: number;
  readonly maximumHotTailTurns: number;
  readonly retryAfterMs: number;
  readonly version: string;
}

export const DEFAULT_LIVE_FINALIZED_MEMORY_POLICY: LiveFinalizedMemoryPolicyV1 =
  Object.freeze({
    leaseDurationMs: 30_000,
    maximumAttempts: 8,
    maximumHotTailTurns: 64,
    retryAfterMs: 1_000,
    version: "meeting-knowledge.live-finalized-worker.v1",
  });

export type LiveFinalizedMemoryWorkerResultV1 =
  | { readonly status: "idle" }
  | {
      readonly meetingId: string;
      readonly mutationId: string;
      readonly status: "applied" | "dead_letter" | "retry_wait";
    };

export class LiveFinalizedMemoryWorker {
  public constructor(
    private readonly store: LiveFinalizedMemorySyncStore,
    private readonly hashes: CanonicalEvidenceTurnHashPort,
    private readonly projection?: LiveFinalizedMemoryProjectionPort,
    private readonly policy: LiveFinalizedMemoryPolicyV1 =
      DEFAULT_LIVE_FINALIZED_MEMORY_POLICY,
    private readonly telemetry?: LiveFinalizedMemoryTelemetryPort,
  ) {
    if (
      policy.version !== "meeting-knowledge.live-finalized-worker.v1" ||
      !Number.isSafeInteger(policy.leaseDurationMs) ||
      policy.leaseDurationMs < 1_000 ||
      policy.leaseDurationMs > 300_000 ||
      !Number.isSafeInteger(policy.maximumAttempts) ||
      policy.maximumAttempts < 1 ||
      policy.maximumAttempts > 100 ||
      !Number.isSafeInteger(policy.maximumHotTailTurns) ||
      policy.maximumHotTailTurns < 1 ||
      policy.maximumHotTailTurns > 256 ||
      !Number.isSafeInteger(policy.retryAfterMs) ||
      policy.retryAfterMs < 1 ||
      policy.retryAfterMs > 300_000
    ) {
      throw new RangeError("live finalized memory policy is outside its bounds");
    }
  }

  public async executeOnce(
    input: { readonly meetingId?: string; readonly signal?: AbortSignal } = {},
  ): Promise<LiveFinalizedMemoryWorkerResultV1> {
    const lease = await this.store.claimNext({
      leaseDurationMs: this.policy.leaseDurationMs,
      ...(input.meetingId === undefined ? {} : { meetingId: input.meetingId }),
    });
    if (lease === null) {
      return { status: "idle" };
    }
    try {
      input.signal?.throwIfAborted();
      const turn = await this.store.loadCanonicalTurn(lease);
      if (turn === null || this.hashes.hash(turn) !== lease.turnHash) {
        await this.store.recordDeadLetter(lease, "canonical_turn_mismatch");
        return {
          meetingId: lease.meetingId,
          mutationId: lease.mutationId,
          status: "dead_letter",
        };
      }
      const projectionOutcome = await this.projectLease(lease, input.signal);
      if (projectionOutcome !== null) {
        return projectionOutcome;
      }
      if (lease.operation === "delete") {
        await this.store.settleRemoval(lease);
        return {
          meetingId: lease.meetingId,
          mutationId: lease.mutationId,
          status: "applied",
        };
      }
      const applied = await this.store.apply(lease, {
        maximumHotTailTurns: this.policy.maximumHotTailTurns,
      });
      this.telemetry?.observe({
        ingestToAppliedMs: Math.max(0, applied.appliedAtMs - lease.enqueuedAtMs),
        outcome: lease.requiresReconciliation ? "reconciled" : "applied",
      });
      return {
        meetingId: lease.meetingId,
        mutationId: lease.mutationId,
        status: "applied",
      };
    } catch (error) {
      const code = error instanceof Error ? error.name : "live_memory_failure";
      if (lease.attempt >= this.policy.maximumAttempts) {
        await this.store.recordDeadLetter(lease, code);
        return {
          meetingId: lease.meetingId,
          mutationId: lease.mutationId,
          status: "dead_letter",
        };
      }
      await this.store.recordRetry(lease, {
        code,
        retryAfterMs: this.policy.retryAfterMs,
      });
      return {
        meetingId: lease.meetingId,
        mutationId: lease.mutationId,
        status: "retry_wait",
      };
    }
  }

  private async projectLease(
    lease: LiveFinalizedMemoryLeaseV1,
    signal?: AbortSignal,
  ): Promise<LiveFinalizedMemoryWorkerResultV1 | null> {
    if (this.projection === undefined) {
      return null;
    }
    const projected = await this.store.loadProjection(lease);
    if (projected === null || projected.turnHash !== lease.turnHash ||
      this.hashes.hash(projected.turn) !== lease.turnHash) {
      await this.store.recordDeadLetter(lease, "projection_payload_mismatch");
      return this.workerResult(lease, "dead_letter");
    }
    let result;
    try {
      result = await this.requestProjection(lease, projected, signal);
    } catch (error) {
      return this.recordProjectionAmbiguity(lease, error);
    }
    if (result.status === "not_found" && lease.requiresReconciliation) {
      try {
        result = await this.mutateProjection(lease, projected, signal);
      } catch (error) {
        return this.recordProjectionAmbiguity(lease, error);
      }
    }
    return result.status === "applied"
      ? null
      : this.settleProjectionFailure(lease, result);
  }

  private requestProjection(
    lease: LiveFinalizedMemoryLeaseV1,
    projected: LiveFinalizedMemoryProjectionV1,
    signal?: AbortSignal,
  ): Promise<LiveFinalizedMemoryProjectionResultV1> {
    if (!lease.requiresReconciliation) {
      return this.mutateProjection(lease, projected, signal);
    }
    const operation = signal === undefined ? {} : { signal };
    return lease.operation === "delete"
      ? this.requireProjection().reconcileRemoval(projected, operation)
      : this.requireProjection().reconcile(projected, operation);
  }

  private mutateProjection(
    lease: LiveFinalizedMemoryLeaseV1,
    projected: LiveFinalizedMemoryProjectionV1,
    signal?: AbortSignal,
  ): Promise<LiveFinalizedMemoryProjectionResultV1> {
    const operation = signal === undefined ? {} : { signal };
    return lease.operation === "delete"
      ? this.requireProjection().remove(projected, operation)
      : this.requireProjection().upsert(projected, operation);
  }

  private requireProjection(): LiveFinalizedMemoryProjectionPort {
    if (this.projection === undefined) {
      throw new Error("live finalized memory projection is unavailable");
    }
    return this.projection;
  }

  private async recordProjectionAmbiguity(
    lease: LiveFinalizedMemoryLeaseV1,
    error: unknown,
  ): Promise<LiveFinalizedMemoryWorkerResultV1> {
    await this.store.recordOutcomeUnknown(lease, {
      code: error instanceof Error ? error.name : "projection.outcome_unknown",
      retryAfterMs: this.policy.retryAfterMs,
    });
    return this.workerResult(lease, "retry_wait");
  }

  private workerResult(
    lease: LiveFinalizedMemoryLeaseV1,
    status: "applied" | "dead_letter" | "retry_wait",
  ): LiveFinalizedMemoryWorkerResultV1 {
    return { meetingId: lease.meetingId, mutationId: lease.mutationId, status };
  }

  private async settleProjectionFailure(
    lease: LiveFinalizedMemoryLeaseV1,
    result: Exclude<
      Awaited<ReturnType<LiveFinalizedMemoryProjectionPort["upsert"]>>,
      { readonly status: "applied" | "not_found" }
    > | { readonly status: "not_found" },
  ): Promise<LiveFinalizedMemoryWorkerResultV1> {
    if (result.status === "outcome_unknown" || result.status === "not_found") {
      await this.store.recordOutcomeUnknown(lease, {
        code: result.status === "not_found" ? "projection.reconcile_not_found" : result.code,
        retryAfterMs: this.policy.retryAfterMs,
      });
      return {
        meetingId: lease.meetingId,
        mutationId: lease.mutationId,
        status: "retry_wait",
      };
    }
    if (!result.retryable || lease.attempt >= this.policy.maximumAttempts) {
      await this.store.recordDeadLetter(lease, result.code);
      return {
        meetingId: lease.meetingId,
        mutationId: lease.mutationId,
        status: "dead_letter",
      };
    }
    await this.store.recordRetry(lease, {
      code: result.code,
      retryAfterMs: this.policy.retryAfterMs,
    });
    return {
      meetingId: lease.meetingId,
      mutationId: lease.mutationId,
      status: "retry_wait",
    };
  }
}
