import type { CanonicalEvidenceTurnHashPort } from "./same-room-focused-memory.js";
import type {
  LiveFinalizedMemorySyncStore,
} from "./ports/live-finalized-memory.js";

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
    private readonly policy: LiveFinalizedMemoryPolicyV1 =
      DEFAULT_LIVE_FINALIZED_MEMORY_POLICY,
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
    input: { readonly meetingId?: string } = {},
  ): Promise<LiveFinalizedMemoryWorkerResultV1> {
    const lease = await this.store.claimNext({
      leaseDurationMs: this.policy.leaseDurationMs,
      ...(input.meetingId === undefined ? {} : { meetingId: input.meetingId }),
    });
    if (lease === null) {
      return { status: "idle" };
    }
    try {
      const turn = await this.store.loadCanonicalTurn(lease);
      if (turn === null || this.hashes.hash(turn) !== lease.turnHash) {
        await this.store.recordDeadLetter(lease, "canonical_turn_mismatch");
        return {
          meetingId: lease.meetingId,
          mutationId: lease.mutationId,
          status: "dead_letter",
        };
      }
      await this.store.apply(lease, {
        maximumHotTailTurns: this.policy.maximumHotTailTurns,
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
}
