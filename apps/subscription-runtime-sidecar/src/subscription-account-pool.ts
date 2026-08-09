import { providerInstanceId } from "./constants.js";

export interface SubscriptionRuntimeAccount {
  readonly authJsonPath: string;
  readonly id: string;
  readonly providerInstanceId: string;
}

interface AccountSlot {
  readonly account: SubscriptionRuntimeAccount;
}

export class SubscriptionAccountPool {
  private readonly slots: AccountSlot[];
  private cursor = 0;

  public constructor(accounts: readonly SubscriptionRuntimeAccount[]) {
    if (accounts.length === 0) {
      throw new Error("Subscription account pool must contain an account");
    }
    this.slots = accounts.map((account) => ({ account }));
  }

  public get accounts(): readonly SubscriptionRuntimeAccount[] {
    return this.slots.map((slot) => slot.account);
  }

  public select(
    excludedAccountIds: ReadonlySet<string> = new Set(),
    signal?: AbortSignal,
  ): SubscriptionRuntimeAccount | undefined {
    if (signal?.aborted === true) {
      throw accountSelectionAborted();
    }
    for (let offset = 0; offset < this.slots.length; offset += 1) {
      const index = (this.cursor + offset) % this.slots.length;
      const slot = this.slots[index];
      if (
        slot === undefined ||
        excludedAccountIds.has(slot.account.id)
      ) {
        continue;
      }
      this.cursor = (index + 1) % this.slots.length;
      return slot.account;
    }
    return undefined;
  }
}

export function subscriptionProviderInstanceId(accountId: string): string {
  return accountId === "slot-1"
    ? providerInstanceId
    : `${providerInstanceId}-${accountId}`;
}

function accountSelectionAborted(): Error {
  return new Error("Subscription account selection was aborted");
}
