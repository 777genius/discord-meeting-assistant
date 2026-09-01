import { createHash } from "node:crypto";

export interface ConversationOneShotReceiptInput {
  readonly kind: "farewell" | "greeting";
  readonly meetingId: string;
  readonly subjectId: string;
}

export const maximumGreetingCohortReceiptCount = 12;
export const maximumGreetingCommandPromptLength = 1_024;
export const greetingProviderRecoveryWindowSeconds = 120;

export interface ReceiptRow {
  readonly lease_token: string | null;
  readonly provider_command_locale: "en" | "ru" | null;
  readonly provider_command_id: string | null;
  readonly provider_command_prompt: string | null;
  readonly provider_recovery_remaining_ms: string | null;
  readonly state: "attempted" | "commanded" | "completed" | "played" | "reserved" |
    "started" | "suppressed";
  readonly suppression_reason: "ambiguous" | "capacity" | "stale" | null;
}

export interface ConversationGreetingSettlementInput extends ConversationOneShotReceiptInput {
  readonly kind: "greeting";
  readonly leaseToken: string;
  readonly outcome: "played" | "suppressed";
  readonly reason?: "ambiguous" | "capacity" | "stale";
}

export interface ConversationFarewellSettlementInput extends ConversationOneShotReceiptInput {
  readonly kind: "farewell";
  readonly leaseToken: string;
  readonly outcome: "played" | "suppressed";
  readonly reason?: "ambiguous";
}

export function greetingScopeIdentity(meetingId: string): string {
  if (meetingId.length < 1 || meetingId.length > 1_024) {
    throw new RangeError("conversation greeting scope identity is outside its bounds");
  }
  return createHash("sha256").update(JSON.stringify({ meetingId, schemaVersion: 1 }), "utf8")
    .digest("hex");
}

export function receiptIdentity(input: ConversationOneShotReceiptInput): string {
  if (input.meetingId.length < 1 || input.meetingId.length > 1_024 ||
    input.subjectId.length < 1 || input.subjectId.length > 1_024) {
    throw new RangeError("conversation one-shot receipt identity is outside its bounds");
  }
  return createHash("sha256").update(JSON.stringify({
    kind: input.kind, meetingId: input.meetingId, schemaVersion: 1, subjectId: input.subjectId,
  }), "utf8").digest("hex");
}

export function parseRecoveryRemainingMilliseconds(value: string): number {
  const remainingMilliseconds = Number(value);
  if (!Number.isSafeInteger(remainingMilliseconds) || remainingMilliseconds < 0) {
    throw new Error("greeting provider recovery window is invalid");
  }
  return remainingMilliseconds;
}

export function assertGreetingCommandPrompt(value: string): void {
  if (value.length < 1 || value.length > maximumGreetingCommandPromptLength) {
    throw new RangeError("greeting command prompt is outside its bounds");
  }
}

export function assertLeaseSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 5 || value > 300) {
    throw new RangeError("conversation one-shot receipt lease is outside its bounds");
  }
}
