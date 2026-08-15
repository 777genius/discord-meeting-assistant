import type { LiveConversationOneShotReceiptPort } from "../src/live-runtime/contracts.js";

export class MemoryOneShotReceipts implements LiveConversationOneShotReceiptPort {
  readonly #states = new Map<string, {
    readonly expired?: boolean;
    readonly leaseToken?: string;
    readonly state: "completed" | "reserved";
  }>();
  #leaseSequence = 0;

  public complete(input: Parameters<LiveConversationOneShotReceiptPort["complete"]>[0]) {
    const key = this.key(input.kind, input.meetingId, input.subjectId);
    if (this.#states.get(key)?.leaseToken === input.leaseToken) {
      this.#states.set(key, { state: "completed" });
    }
    return Promise.resolve();
  }

  public release(input: Parameters<LiveConversationOneShotReceiptPort["release"]>[0]) {
    const key = this.key(input.kind, input.meetingId, input.subjectId);
    if (this.#states.get(key)?.leaseToken === input.leaseToken) {
      this.#states.delete(key);
    }
    return Promise.resolve();
  }

  public reserve(input: Parameters<LiveConversationOneShotReceiptPort["reserve"]>[0]) {
    const key = this.key(input.kind, input.meetingId, input.subjectId);
    const receipt = this.#states.get(key);
    if (receipt?.state === "completed") {
      return Promise.resolve({ status: "completed" as const });
    }
    if (receipt?.state === "reserved" && receipt.expired !== true) {
      return Promise.resolve({ status: "in_flight" as const });
    }
    this.#leaseSequence += 1;
    const leaseToken = `greeting-test-lease-${this.#leaseSequence}`;
    this.#states.set(key, { leaseToken, state: "reserved" });
    return Promise.resolve({ leaseToken, status: "reserved" as const });
  }

  public state(
    kind: "farewell" | "greeting",
    meetingId: string,
    subjectId: string,
  ) {
    return this.#states.get(this.key(kind, meetingId, subjectId))?.state;
  }

  public expireReservations(): void {
    for (const [key, receipt] of this.#states) {
      if (receipt.state === "reserved") {
        this.#states.set(key, { ...receipt, expired: true });
      }
    }
  }

  private key(kind: string, meetingId: string, subjectId: string): string {
    return `${kind}\u0000${meetingId}\u0000${subjectId}`;
  }
}
