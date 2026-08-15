import type { ConversationTurn } from "./conversation-turn.js";

export type ConversationCancellationReason =
  | "barge-in"
  | "disconnected"
  | "meeting-ended"
  | "playback-failed"
  | "runtime-shutdown"
  | "superseded";

export type ConversationAdmission =
  | {
      readonly status: "active";
      readonly turn: ConversationTurn;
    }
  | {
      readonly expiresAtMs: number;
      readonly status: "queued";
      readonly turn: ConversationTurn;
    }
  | {
      readonly status: "busy";
      readonly turnId: string;
    }
  | {
      readonly disposition: ConversationTurnDisposition;
      readonly status: "reused";
      readonly turnId: string;
    };

export type ConversationTurnDisposition =
  | "active"
  | "busy"
  | "cancelled"
  | "cancelling"
  | "completed"
  | "expired"
  | "queued";

export type ConversationCancellation =
  | {
      readonly reason: ConversationCancellationReason;
      readonly status: "requested";
      readonly turn: ConversationTurn;
    }
  | { readonly status: "ignored" };

export type ConversationCompletion =
  | {
      readonly next: ConversationTurn | null;
      readonly status: "completed" | "cancelled";
      readonly turn: ConversationTurn;
    }
  | { readonly next: null; readonly status: "ignored" };
