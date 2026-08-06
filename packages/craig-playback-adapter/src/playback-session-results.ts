import { createHash } from "node:crypto";

import {
  type ConversationPortResult,
} from "@discord-meeting/meeting-core/conversation";

export function playbackOpenCancelled(): ConversationPortResult<never> {
  return playbackFailure(
    "CRAIG_PLAYBACK_OPEN_CANCELLED",
    "Craig playback open was cancelled",
    true,
  );
}

export function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export async function settlePlaybackStart(
  operation: Promise<void>,
  signal?: AbortSignal,
): Promise<PlaybackStartDelivery> {
  if (signal === undefined) {
    try {
      await operation;
      return { status: "sent" };
    } catch (error) {
      return { error, status: "failed" };
    }
  }
  if (signal.aborted) {
    return { status: "aborted" };
  }
  return await new Promise((resolve: (delivery: PlaybackStartDelivery) => void) => {
    const settle = (delivery: PlaybackStartDelivery): void => {
      signal.removeEventListener("abort", abort);
      resolve(delivery);
    };
    const abort = () => {
      settle({ status: "aborted" });
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      () => {
        settle({ status: "sent" });
        return null;
      },
      (error: unknown) => {
        settle({ error, status: "failed" });
        return null;
      },
    );
  });
}

export function chunkHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function observedNow(nowMilliseconds: () => number): number {
  const value = Math.floor(nowMilliseconds());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Craig playback observation clock must be a non-negative integer");
  }
  return value;
}

export function transportFailure(error: unknown): FailedPortResult {
  return playbackFailure(
    "CRAIG_PLAYBACK_TRANSPORT_ERROR",
    error instanceof Error && error.message.length > 0
      ? error.message
      : "Craig playback transport failed",
    true,
  );
}

export function playbackFailure(
  code: string,
  message: string,
  retryable: boolean,
): FailedPortResult {
  return { ok: false, failure: { code, message, retryable } };
}

export function terminalState(
  state: "starting" | "open" | "finishing" | "cancelling" | "finished" | "failed",
): boolean {
  return state === "finished" || state === "failed";
}

export type FailedPortResult = Extract<ConversationPortResult<never>, { ok: false }>;

type PlaybackStartDelivery =
  | { readonly status: "aborted" | "sent" }
  | { readonly error: unknown; readonly status: "failed" };
