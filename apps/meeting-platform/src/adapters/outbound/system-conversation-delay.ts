import {
  type ConversationDelay,
  type ConversationDelayPort,
} from "@discord-meeting/meeting-core/conversation";

/** Node timer implementation kept outside Meeting Core's deterministic policy. */
export class SystemConversationDelay implements ConversationDelayPort {
  public start(delayMs: number): ConversationDelay {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new RangeError("Conversation delay must be a non-negative safe integer");
    }

    let resolveElapsed!: (outcome: "cancelled" | "elapsed") => void;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<"cancelled" | "elapsed">((resolve) => {
      resolveElapsed = resolve;
    });
    const settle = (outcome: "cancelled" | "elapsed"): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      resolveElapsed(outcome);
    };

    timeout = setTimeout(() => {
      settle("elapsed");
    }, delayMs);
    return Object.freeze({
      cancel: () => {
        settle("cancelled");
      },
      elapsed,
    });
  }
}
