import { createHash } from "node:crypto";

export function stableSubscriptionRuntimeId(
  kind:
    | "action"
    | "conversation-answer-request"
    | "decision"
    | "incremental-summary-request"
    | "question"
    | "summary"
    | "summary-provider-output-repair"
    | "summary-request",
  ...parts: readonly string[]
): string {
  const hash = createHash("sha256");
  hash.update(kind, "utf8");
  for (const part of parts) {
    hash.update(`:${part.length}:`, "utf8");
    hash.update(part, "utf8");
  }
  return `${kind}-${hash.digest("hex").slice(0, 32)}`;
}
