import { createHash } from "node:crypto";

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(toCanonicalJsonValue(value)), "utf8")
    .digest("hex");
}

function toCanonicalJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON does not allow non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : toCanonicalJsonValue(item),
    );
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, toCanonicalJsonValue(item)]),
    );
  }

  throw new Error("Canonical JSON value is not serializable");
}
