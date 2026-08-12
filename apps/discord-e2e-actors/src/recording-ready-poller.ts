import type {
  CurrentDeploymentProvenance,
  DeploymentRevisionExpectation,
} from "./e2e-evidence.js";
import {
  deriveRecordingReadyReceipt,
  RecordingReadyNotObservedError,
  type RecordingReadyReceiptV1,
} from "./recording-ready-receipt.js";

export interface RecordingCompletionReceiptProbe {
  collectRecordingCompletionReceipts(): Promise<readonly unknown[]>;
}

export interface RecordingReadyClock {
  nowEpochMs(): number;
}

export interface RecordingReadyDelay {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface RecordingReadyPollingPolicy {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
}

export class RecordingReadyPollingTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`Recording readiness was not stable within ${timeoutMs}ms`);
    this.name = "RecordingReadyPollingTimeoutError";
  }
}

export async function waitForStableRecordingReadyReceipt(input: {
  readonly actorRun: unknown;
  readonly clock: RecordingReadyClock;
  readonly delay: RecordingReadyDelay;
  readonly expectedRevisions: DeploymentRevisionExpectation;
  readonly policy: RecordingReadyPollingPolicy;
  readonly probe: RecordingCompletionReceiptProbe;
  readonly provenance: CurrentDeploymentProvenance;
  readonly signal: AbortSignal;
}): Promise<RecordingReadyReceiptV1> {
  assertPollingPolicy(input.policy);
  const startedAt = input.clock.nowEpochMs();
  const deadline = startedAt + input.policy.timeoutMs;
  let previousStableKey: string | undefined;

  while (true) {
    input.signal.throwIfAborted();
    const sampledAt = input.clock.nowEpochMs();
    if (sampledAt > deadline) {
      throw new RecordingReadyPollingTimeoutError(input.policy.timeoutMs);
    }

    try {
      const receipt = deriveRecordingReadyReceipt({
        actorRun: input.actorRun,
        completionReceipts: await input.probe.collectRecordingCompletionReceipts(),
        expectedRevisions: input.expectedRevisions,
        observedAt: new Date(sampledAt).toISOString(),
        provenance: input.provenance,
      });
      const stableKey = recordingReadyStableKey(receipt);
      if (stableKey === previousStableKey) {
        return receipt;
      }
      previousStableKey = stableKey;
    } catch (error) {
      if (!(error instanceof RecordingReadyNotObservedError)) {
        throw error;
      }
      previousStableKey = undefined;
    }

    const remainingMs = deadline - input.clock.nowEpochMs();
    if (remainingMs <= 0) {
      throw new RecordingReadyPollingTimeoutError(input.policy.timeoutMs);
    }
    await input.delay.wait(Math.min(input.policy.pollIntervalMs, remainingMs), input.signal);
  }
}

function assertPollingPolicy(policy: RecordingReadyPollingPolicy): void {
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new Error("Recording-ready timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(policy.pollIntervalMs) || policy.pollIntervalMs <= 0 ||
    policy.pollIntervalMs > policy.timeoutMs) {
    throw new Error("Recording-ready poll interval must be a positive safe integer within timeout");
  }
}

function recordingReadyStableKey(receipt: RecordingReadyReceiptV1): string {
  const { observedAt: _observedAt, ...stable } = receipt;
  return JSON.stringify(stable);
}
