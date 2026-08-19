import {
  buildHistoricalIndexPlan,
  buildHistoricalIndexPlanFromPreparedWindows,
  DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
  HistoricalIndexPlanError,
  type HistoricalEvidenceBlockPolicyV1,
} from "./historical-index-plan.js";
import type {
  HistoricalIndexPlanV1, HistoricalMemoryPort, HistoricalOpaqueIdPort,
} from "./ports/historical-memory.js";
import type {
  HistoricalEvidenceAuthority, HistoricalSyncLeaseV1, HistoricalSyncStore,
} from "./ports/historical-state.js";
import type { AcceptedFinalMeetingV1 } from "../domain/historical-evidence.js";
import { historicalPlanProjectionMatches } from "./historical-embedding-windows.js";
import type { HistoricalEmbeddingTokenizerPort } from
  "./ports/historical-embedding-tokenizer.js";
import { HistoricalIndexPlannerUnavailableError, type HistoricalIndexPlannerPort,
  type HistoricalReceiptDigestPort } from "./ports/historical-index-planner.js";
import {
  historicalBindingsMatch as sameBinding,
  historicalDeletionMutationId as deletionMutationId,
  historicalOperationOptions as operationOptions,
} from "./historical-sync-support.js";

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

export const DEFAULT_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS = 300_000;
export const MAXIMUM_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS = 600_000;
export const HISTORICAL_SYNC_LEASE_SAFETY_MARGIN_MS = 30_000;
/** Maximum composed lease: maximum provider operation plus its safety margin. */
export const MAXIMUM_HISTORICAL_SYNC_LEASE_DURATION_MS =
  MAXIMUM_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS +
  HISTORICAL_SYNC_LEASE_SAFETY_MARGIN_MS;

export function historicalSyncLeaseDurationMs(operationTimeoutMs: number): number {
  if (
    !Number.isSafeInteger(operationTimeoutMs) ||
    operationTimeoutMs < 1_000 ||
    operationTimeoutMs > MAXIMUM_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS
  ) {
    throw new RangeError("historical memory operation timeout is outside its qualified bounds");
  }
  return Math.max(
    DEFAULT_HISTORICAL_SYNC_POLICY.leaseDurationMs,
    operationTimeoutMs + HISTORICAL_SYNC_LEASE_SAFETY_MARGIN_MS,
  );
}

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
    policy.leaseDurationMs > MAXIMUM_HISTORICAL_SYNC_LEASE_DURATION_MS ||
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

type PreparedIndexPlan =
  | { readonly plan: HistoricalIndexPlanV1 }
  | { readonly outcome: HistoricalSyncWorkerResultV1 };
type PlanBuildAttempt =
  | { readonly status: "ok"; readonly plan: HistoricalIndexPlanV1 }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "unavailable" };

export class HistoricalSyncWorker {
  readonly #indexProfileId: string;
  readonly #policy: HistoricalSyncPolicyV1;

  public constructor(
    private readonly dependencies: {
      readonly authority: HistoricalEvidenceAuthority;
      readonly ids: HistoricalOpaqueIdPort;
      readonly indexProfileId?: string;
      readonly planner?: HistoricalIndexPlannerPort;
      readonly receiptDigest?: HistoricalReceiptDigestPort;
      readonly memory: HistoricalMemoryPort;
      readonly store: HistoricalSyncStore;
      readonly tokenizer?: () => HistoricalEmbeddingTokenizerPort | undefined;
    },
    policy: HistoricalSyncPolicyV1 = DEFAULT_HISTORICAL_SYNC_POLICY,
  ) {
    this.#policy = assertPolicy(policy);
    this.#indexProfileId = dependencies.indexProfileId ??
      "meeting-knowledge.unqualified-index-profile.v1";
    if (
      this.#indexProfileId.trim().length === 0 ||
      new TextEncoder().encode(this.#indexProfileId).byteLength > 1_000
    ) {
      throw new RangeError("historical index profile identity is outside its bounds");
    }
  }

  /** Serving flags never prevent a previously authorized deletion from draining. */
  public async executeOnce(input: {
    readonly indexingEnabled: boolean;
    readonly signal?: AbortSignal;
  }): Promise<HistoricalSyncWorkerResultV1> {
    const lease = await this.dependencies.store.claimNext({
      allowIndex: input.indexingEnabled,
      leaseDurationMs: this.#policy.leaseDurationMs,
    }, operationOptions(input.signal));
    if (lease === null) {
      return { status: "idle" };
    }
    return lease.operation === "index"
      ? this.index(lease, input.signal)
      : this.delete(lease, input.signal);
  }

  private async index(
    lease: HistoricalSyncLeaseV1,
    signal?: AbortSignal,
  ): Promise<HistoricalSyncWorkerResultV1> {
    const accepted = await this.dependencies.authority.loadAcceptedFinalMeeting(
      lease.binding,
      operationOptions(signal),
    );
    if (accepted === null) {
      return this.deadLetter(lease, "authoritative_release_unavailable", signal);
    }
    const prepared = await this.prepareIndexPlan(lease, accepted, signal);
    if ("outcome" in prepared) {
      return prepared.outcome;
    }
    const { plan } = prepared;
    await this.dependencies.store.recordPlan(lease, plan, operationOptions(signal));
    let result;
    try {
      result = signal === undefined
        ? await this.dependencies.memory.indexFinalMeeting(plan)
        : await this.dependencies.memory.indexFinalMeeting(plan, { signal });
    } catch {
      signal?.throwIfAborted();
      result = {
        code: "memory.port_exception",
        retryable: true,
        status: "outcome_unknown" as const,
      };
    }
    signal?.throwIfAborted();
    if (result.status === "applied") {
      await this.dependencies.store.recordApplied(
        lease,
        plan,
        result.remoteDocumentIds,
        this.#indexProfileId,
        operationOptions(signal),
      );
      return this.result(lease, "applied");
    }
    if (result.status === "outcome_unknown") {
      return this.scheduleRetry(lease, result.code, "outcome_unknown", signal);
    }
    if (result.retryable && lease.attempt < this.#policy.maximumIndexAttempts) {
      return this.scheduleRetry(lease, result.code, "known_failure", signal);
    }
    return this.deadLetter(lease, result.code, signal);
  }

  private async prepareIndexPlan(
    lease: HistoricalSyncLeaseV1,
    accepted: AcceptedFinalMeetingV1,
    signal?: AbortSignal,
  ): Promise<PreparedIndexPlan> {
    const exactPlanningConfigured = this.dependencies.planner !== undefined ||
      this.dependencies.tokenizer !== undefined;
    const planningRequired = planNeeded(
      lease.plan,
      lease.appliedIndexProfileId,
      lease.profileRebuildRequired,
      exactPlanningConfigured,
    );
    const tokenizer = planningRequired
      ? this.dependencies.tokenizer?.()
      : undefined;
    const canonical = planningRequired
      ? await this.tryBuildPlan(accepted, tokenizer, signal)
      : undefined;
    if (canonical?.status === "unavailable") {
      return { outcome: await this.scheduleRetry(
        lease,
        "historical_index_planner.unavailable",
        "known_failure",
        signal,
      ) };
    }
    if (canonical?.status === "invalid") {
      return { outcome: await this.deadLetter(lease, canonical.reason, signal) };
    }
    let plan = lease.plan;
    if (plan === null) {
      if (canonical === undefined || canonical.status !== "ok") {
        throw new Error("historical canonical plan was not prepared");
      }
      plan = canonical.plan;
    } else if (!sameBinding(plan.binding, lease.binding)) {
      return { outcome: await this.deadLetter(
        lease,
        "historical_index_plan.binding_conflict",
        signal,
      ) };
    } else if (
      canonical?.status === "ok" &&
      (lease.profileRebuildRequired ||
        JSON.stringify(canonical.plan) !== JSON.stringify(plan))
    ) {
      const stalePlan = plan;
      let deletion;
      try {
        deletion = await this.dependencies.memory.deleteMeeting({
          deleteMutationId: `mkmutation1.${this.dependencies.ids.keyedId(
            "historical-profile-migration",
            [stalePlan.planDigest],
          )}`,
          documentExternalIds: stalePlan.documents.map(
            ({ manifest }) => manifest.documentExternalId,
          ),
          mode: "release",
          remoteDocumentIds: lease.remoteDocumentIds,
          schemaVersion: 1,
          topology: stalePlan.topology,
        }, operationOptions(signal));
      } catch {
        deletion = { code: "memory.port_exception", status: "absence_unverified" } as const;
      }
      if (deletion.status !== "verified_absent") {
        return { outcome: await this.scheduleRetry(
          lease,
          deletion.code,
          "outcome_unknown",
          signal,
        ) };
      }
      plan = canonical.plan;
    } else if (!historicalPlanProjectionMatches(accepted, plan, (turnId) =>
      `turn1.${this.dependencies.ids.keyedId("historical-turn", [
        accepted.binding.scopeId,
        accepted.binding.roomId,
        accepted.binding.meetingId,
        accepted.binding.transcriptId,
        String(accepted.binding.transcriptVersion),
        turnId,
      ])}`
    )) {
      return { outcome: await this.deadLetter(
        lease,
        "historical_index_plan.stale_plan",
        signal,
      ) };
    }
    return { plan };
  }

  private async tryBuildPlan(
    meeting: AcceptedFinalMeetingV1,
    tokenizer: HistoricalEmbeddingTokenizerPort | undefined,
    signal: AbortSignal | undefined,
  ): Promise<PlanBuildAttempt> {
    try {
      if (this.dependencies.planner !== undefined) {
        if (this.dependencies.receiptDigest === undefined) {
          return { status: "unavailable" };
        }
        const prepared = await this.dependencies.planner.prepareWindows(
          meeting, this.#policy.blockPolicy, operationOptions(signal),
        );
        signal?.throwIfAborted();
        return {
          plan: buildHistoricalIndexPlanFromPreparedWindows(
            meeting,
            this.dependencies.ids,
            this.#policy.blockPolicy,
            prepared,
            this.dependencies.receiptDigest!,
          ),
          status: "ok",
        };
      }
      return {
        plan: buildHistoricalIndexPlan(
          meeting, this.dependencies.ids, this.#policy.blockPolicy, tokenizer,
        ),
        status: "ok",
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof HistoricalIndexPlannerUnavailableError) {
        return { status: "unavailable" };
      }
      return {
        reason: error instanceof HistoricalIndexPlanError
          ? `historical_index_plan.${error.code.toLowerCase()}`
          : "historical_index_plan.invalid",
        status: "invalid",
      };
    }
  }

  private async deadLetter(
    lease: HistoricalSyncLeaseV1,
    code: string,
    signal: AbortSignal | undefined,
  ): Promise<HistoricalSyncWorkerResultV1> {
    await this.dependencies.store.recordDeadLetter(lease, code, operationOptions(signal));
    return this.result(lease, "dead_lettered");
  }

  private async scheduleRetry(
    lease: HistoricalSyncLeaseV1,
    code: string,
    outcome: "known_failure" | "outcome_unknown",
    signal: AbortSignal | undefined,
  ): Promise<HistoricalSyncWorkerResultV1> {
    await this.dependencies.store.recordRetry(lease, {
      code,
      outcome,
      retryAfterMs: retryDelay(this.#policy, lease.attempt),
    }, operationOptions(signal));
    return this.result(lease, "retry_scheduled");
  }

  private async delete(
    lease: HistoricalSyncLeaseV1,
    signal?: AbortSignal,
  ): Promise<HistoricalSyncWorkerResultV1> {
    if (lease.plan === null) {
      // The plan is stored before the first remote byte can be sent. No plan
      // therefore proves that this release never reached Infinity, including
      // when its whole local meeting is withdrawn before the first index pass.
      await this.dependencies.store.recordDeleted(lease, operationOptions(signal));
      return this.result(lease, "deleted");
    }
    let result;
    try {
      const topology = lease.plan.topology;
      const request = {
        deleteMutationId: deletionMutationId(lease, this.dependencies.ids),
        documentExternalIds: Object.freeze(
          lease.plan.documents.map(({ manifest }) => manifest.documentExternalId),
        ),
        mode: lease.operation === "delete_meeting" ? "meeting" : "release",
        remoteDocumentIds: lease.remoteDocumentIds,
        schemaVersion: 1,
        topology,
      } as const;
      result = signal === undefined
        ? await this.dependencies.memory.deleteMeeting(request)
        : await this.dependencies.memory.deleteMeeting(request, { signal });
    } catch {
      signal?.throwIfAborted();
      result = {
        code: "memory.port_exception",
        retryable: true,
        status: "absence_unverified" as const,
      };
    }
    signal?.throwIfAborted();
    if (result.status === "verified_absent") {
      await this.dependencies.store.recordDeleted(lease, operationOptions(signal));
      return this.result(lease, "deleted");
    }

    return this.scheduleRetry(lease, result.code, "known_failure", signal);
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

function planNeeded(
  persisted: HistoricalIndexPlanV1 | null,
  appliedIndexProfileId: string | null,
  profileRebuildRequired: boolean,
  exactPlanningConfigured: boolean,
): boolean {
  return persisted === null || profileRebuildRequired ||
    (exactPlanningConfigured && appliedIndexProfileId === null);
}
