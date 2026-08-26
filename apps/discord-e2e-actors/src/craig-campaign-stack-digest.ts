import { createHash } from "node:crypto";

export function digestCraigCampaignStackCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(nested: unknown): unknown {
  if (Array.isArray(nested)) { return nested.map(canonical); }
  if (nested === null || typeof nested !== "object") { return nested; }
  return Object.fromEntries(Object.entries(nested).toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]));
}
