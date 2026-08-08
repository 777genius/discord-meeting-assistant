import { providerInstanceId } from "./constants.js";

export interface SubscriptionRuntimeAccount {
  readonly authJsonPath: string;
  readonly id: string;
  readonly providerInstanceId: string;
}

export interface SubscriptionRuntimeAccountLease {
  readonly account: SubscriptionRuntimeAccount;
  release(): void;
}

interface PendingLease {
  readonly excludedAccountIds: ReadonlySet<string>;
  readonly reject: (reason: Error) => void;
  readonly resolve: (lease: SubscriptionRuntimeAccountLease | undefined) => void;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
}

interface AccountSlot {
  readonly account: SubscriptionRuntimeAccount;
  busy: boolean;
}

const defaultMaximumQueueSize = 256;

export class SubscriptionAccountPool {
  private readonly slots: AccountSlot[];
  private readonly queue: PendingLease[] = [];
  private cursor = 0;

  public constructor(
    accounts: readonly SubscriptionRuntimeAccount[],
    private readonly maximumQueueSize = defaultMaximumQueueSize,
  ) {
    if (accounts.length === 0) {
      throw new Error("Subscription account pool must contain an account");
    }
    if (!Number.isInteger(maximumQueueSize) || maximumQueueSize < 1) {
      throw new Error("Subscription account pool queue size is invalid");
    }
    this.slots = accounts.map((account) => ({ account, busy: false }));
  }

  public get accounts(): readonly SubscriptionRuntimeAccount[] {
    return this.slots.map((slot) => slot.account);
  }

  public async acquire(
    excludedAccountIds: ReadonlySet<string> = new Set(),
    signal?: AbortSignal,
  ): Promise<SubscriptionRuntimeAccountLease | undefined> {
    if (signal?.aborted === true) {
      throw accountAcquisitionAborted();
    }
    const available = this.takeAvailable(excludedAccountIds);
    if (available !== undefined || this.allExcluded(excludedAccountIds)) {
      return available;
    }
    if (this.queue.length >= this.maximumQueueSize) {
      throw new Error("Subscription account pool queue is full");
    }
    return await new Promise<SubscriptionRuntimeAccountLease | undefined>(
      (resolve, reject) => {
        const pending: PendingLease = {
          excludedAccountIds,
          reject,
          resolve,
          ...(signal === undefined ? {} : { signal }),
          abort: () => {
            const index = this.queue.indexOf(pending);
            if (index >= 0) {
              this.queue.splice(index, 1);
            }
            reject(accountAcquisitionAborted());
          },
        };
        signal?.addEventListener("abort", pending.abort, { once: true });
        this.queue.push(pending);
      },
    );
  }

  private takeAvailable(
    excludedAccountIds: ReadonlySet<string>,
  ): SubscriptionRuntimeAccountLease | undefined {
    for (let offset = 0; offset < this.slots.length; offset += 1) {
      const index = (this.cursor + offset) % this.slots.length;
      const slot = this.slots[index];
      if (
        slot === undefined ||
        slot.busy ||
        excludedAccountIds.has(slot.account.id)
      ) {
        continue;
      }
      slot.busy = true;
      this.cursor = (index + 1) % this.slots.length;
      let released = false;
      return {
        account: slot.account,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          slot.busy = false;
          this.drainQueue();
        },
      };
    }
    return undefined;
  }

  private drainQueue(): void {
    for (let index = 0; index < this.queue.length;) {
      const pending = this.queue[index];
      if (pending === undefined) {
        return;
      }
      if (pending.signal?.aborted === true) {
        this.queue.splice(index, 1);
        pending.signal.removeEventListener("abort", pending.abort);
        pending.reject(accountAcquisitionAborted());
        continue;
      }
      const lease = this.takeAvailable(pending.excludedAccountIds);
      if (lease === undefined) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.resolve(lease);
    }
  }

  private allExcluded(excludedAccountIds: ReadonlySet<string>): boolean {
    return this.slots.every((slot) => excludedAccountIds.has(slot.account.id));
  }
}

export function subscriptionProviderInstanceId(accountId: string): string {
  return accountId === "slot-1"
    ? providerInstanceId
    : `${providerInstanceId}-${accountId}`;
}

function accountAcquisitionAborted(): Error {
  return new Error("Subscription account acquisition was aborted");
}
