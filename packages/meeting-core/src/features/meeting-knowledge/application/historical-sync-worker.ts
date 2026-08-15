import {
  buildHistoricalIndexPlan,
  DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
  HistoricalIndexPlanError,
  type HistoricalEvidenceBlockPolicyV1,
} from "./historical-index-plan.js";
import type {
  HistoricalMemoryPort,
  HistoricalOpaqueIdPort,
} from "./ports/historical-memory.js";
import type {
  HistoricalEvidenceAuthority,
  HistoricalSyncLeaseV1,
  HistoricalSyncStore,
} from "./ports/historical-state.js";
import type { HistoricalReleaseBindingV1 } from "../domain/historical-evidence.js";

export interface HistoricalSyncPolicyV1 {
  readonly blockPolicy: HistoricalEvidenceBlockPolicyV1;
  readonly leaseDurationMs: number;
  readonly maximumIndexAttempts: number;
  readonly retryBackoffMs: readonly number[];
  readonly version: "meeting-knowledge.historical-sync.v1";
}

type HistoricalSyncPolicyInputV1 = Omit<HistoricalSyncPolicyV1, "version"> & {
  readonly version: string;
};

export const DEFAULT_HISTORICAL_SYNC_POLICY: HistoricalSyncPolicyV1 = Object.freeze({
  blockPolicy: DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
  leaseDurationMs: 30_000,
  maximumIndexAttempts: 5,
  retryBackoffMs: Object.freeze([1_000, 5_000, 30_000, 120_000]),
  version: "meeting-knowledge.historical-sync.v1",
});

export type HistoricalSyncWorkerResultV1 =
  | { readonly status: "idle" }
  | {
      readonly operation: HistoricalSyncLeaseV1["operation"];
      readonly releaseId: string;
      readonly status: "applied" | "dead_lettered" | "deleted" | "retry_scheduled";
    };

function retryDelay(policy: HistoricalSyncPolicyV1, attempt: number): number {
  const index = Math.max(0, Math.min(attempt - 1, policy.retryBackoffMs.length - 1));
  return policy.retryBackoffMs[index] ?? 120_000;
}

function assertPolicy(policy: HistoricalSyncPolicyInputV1): HistoricalSyncPolicyV1 {
  if (
    policy.version !== "meeting-knowledge.historical-sync.v1" ||
    !Number.isSafeInteger(policy.leaseDurationMs) ||
    policy.leaseDurationMs < 1_000 ||
    policy.leaseDurationMs > 300_000 ||
    !Number.isSafeInteger(policy.maximumIndexAttempts) ||
    policy.maximumIndexAttempts < 1 ||
    policy.maximumIndexAttempts > 20 ||
    policy.retryBackoffMs.length < 1 ||
    policy.retryBackoffMs.length > 16 ||
    policy.retryBackoffMs.some((delay) =>
      !Number.isSafeInteger(delay) || delay < 0 || delay > 86_400_000
    )
  ) {
    throw new RangeError("historical sync policy is outside its qualified bounds");
  }
  return Object.freeze({ ...policy, version: "meeting-knowledge.historical-sync.v1" });
}

function deletionMutationId(
  lease: HistoricalSyncLeaseV1,
  ids: HistoricalOpaqueIdPort,
): string {
  return lease.plan?.deleteMutationId ??
    `mkmutation1.${ids.keyedId("historical-delete-mutation", [lease.binding.releaseId])}`;
}

function sameBinding(
  left: HistoricalReleaseBindingV1,
  right: HistoricalReleaseBindingV1,
): boolean {
  return left.acceptedMeetingRevision === right.acceptedMeetingRevision &&
    left.desiredGeneration === right.desiredGeneration &&
    left.meetingId === right.meetingId &&
    left.releaseId === right.releaseId &&
    left.roomId === right.roomId &&
    left.scopeId === right.scopeId &&
    left.transcriptId === right.transcriptId &&
    left.transcriptVersion === right.transcriptVersion;
}

export class HistoricalSyncWorker {
  readonly #policy: HistoricalSyncPolicyV1;

  public constructor(
    private readonly dependencies: {
      readonly authority: HistoricalEvidenceAuthority;
      readonly ids: HistoricalOpaqueIdPort;
      readonly memory: HistoricalMemoryPort;
      readonly store: HistoricalSyncStore;
    },
    policy: HistoricalSyncPolicyV1 = DEFAULT_HISTORICAL_SYNC_POLICY,
  ) {
    this.#policy = assertPolicy(policy);
  }

  /** Serving flags never prevent a previously authorized deletion from draining. */
  public async executeOnce(input: {
    readonly indexingEnabled: boolean;
  }): Promise<HistoricalSyncWorkerResultV1> {
    const lease = await this.dependencies.store.claimNext({
      allowIndex: input.indexingEnabled,
      leaseDurationMs: this.#policy.leaseDurationMs,
    });
    if (lease === null) {
      return { status: "idle" };
    }
    return lease.operation === "index"
      ? this.index(lease)
      : this.delete(lease);
  }

  private async index(
    lease: HistoricalSyncLeaseV1,
  ): Promise<HistoricalSyncWorkerResultV1> {
    const accepted = await this.dependencies.authority.loadAcceptedFinalMeeting(
      lease.binding,
    );
    if (accepted === null) {
      await this.dependencies.store.recordDeadLetter(
        lease,
        "authoritative_release_unavailable",
      );
      return this.result(lease, "dead_lettered");
    }

    let plan = lease.plan;
    if (plan === null) {
      try {
        plan = buildHistoricalIndexPlan(
          accepted,
          this.dependencies.ids,
          this.#policy.blockPolicy,
        );
      } catch (error) {
        await this.dependencies.store.recordDeadLetter(
          lease,
          error instanceof HistoricalIndexPlanError
            ? `historical_index_plan.${error.code.toLowerCase()}`
            : "historical_index_plan.invalid",
        );
        return this.result(lease, "dead_lettered");
      }
    } else if (!sameBinding(plan.binding, lease.binding)) {
      await this.dependencies.store.recordDeadLetter(
        lease,
        "historical_index_plan.binding_conflict",
      );
      return this.result(lease, "dead_lettered");
    }
    await this.dependencies.store.recordPlan(lease, plan);
    let result;
    try {
      result = await this.dependencies.memory.indexFinalMeeting(plan);
    } catch {
      result = {
        code: "memory.port_exception",
        retryable: true,
        status: "outcome_unknown" as const,
      };
    }
    if (result.status === "applied") {
      await this.dependencies.store.recordApplied(
        lease,
        plan,
        result.remoteDocumentIds,
      );
      return this.result(lease, "applied");
    }

    if (result.retryable && lease.attempt < this.#policy.maximumIndexAttempts) {
      await this.dependencies.store.recordRetry(lease, {
        code: result.code,
        retryAfterMs: retryDelay(this.#policy, lease.attempt),
      });
      return this.result(lease, "retry_scheduled");
    }
    await this.dependencies.store.recordDeadLetter(lease, result.code);
    return this.result(lease, "dead_lettered");
  }

  private async delete(
    lease: HistoricalSyncLeaseV1,
  ): Promise<HistoricalSyncWorkerResultV1> {
    if (lease.plan === null) {
      // The plan is stored before the first remote byte can be sent. No plan
      // therefore proves that this release never reached Infinity, including
      // when its whole local meeting is withdrawn before the first index pass.
      await this.dependencies.store.recordDeleted(lease);
      return this.result(lease, "deleted");
    }
    let result;
    try {
      const topology = lease.plan.topology;
      result = await this.dependencies.memory.deleteMeeting({
        deleteMutationId: deletionMutationId(lease, this.dependencies.ids),
        documentExternalIds: Object.freeze(
          lease.plan.documents.map(({ manifest }) => manifest.documentExternalId),
        ),
        mode: lease.operation === "delete_meeting" ? "meeting" : "release",
        remoteDocumentIds: lease.remoteDocumentIds,
        schemaVersion: 1,
        topology,
      });
    } catch {
      result = {
        code: "memory.port_exception",
        retryable: true,
        status: "absence_unverified" as const,
      };
    }
    if (result.status === "verified_absent") {
      await this.dependencies.store.recordDeleted(lease);
      return this.result(lease, "deleted");
    }

    // Authorized cleanup has no abandoned terminal state. Even a capability
    // mismatch remains visible and retryable until absence can be proven.
    await this.dependencies.store.recordRetry(lease, {
      code: result.code,
      retryAfterMs: retryDelay(this.#policy, lease.attempt),
    });
    return this.result(lease, "retry_scheduled");
  }

  private result(
    lease: HistoricalSyncLeaseV1,
    status: Exclude<HistoricalSyncWorkerResultV1["status"], "idle">,
  ): HistoricalSyncWorkerResultV1 {
    return {
      operation: lease.operation,
      releaseId: lease.binding.releaseId,
      status,
    };
  }
}
