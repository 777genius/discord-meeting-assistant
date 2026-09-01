import { createHash, createPublicKey } from "node:crypto";

export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value, "$"));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(
    value instanceof Uint8Array ? value : canonicalJson(value),
  ).digest("hex");
}

export function exactRecord(value: unknown, keys: readonly string[], label: string):
Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (canonicalJson(Object.keys(record).toSorted()) !== canonicalJson([...keys].toSorted())) {
    throw new Error(`${label} has an invalid shape`);
  }
  return record;
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

export function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function publicKeyFingerprintSha256(publicKeyPem: string, label: string): string {
  try {
    const der = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
    return createHash("sha256").update(der).digest("hex");
  } catch {
    throw new Error(`${label} public key is invalid`);
  }
}

function canonical(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {return value;}
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {throw new Error(`${path} contains a non-integer number`);}
    return value;
  }
  if (Array.isArray(value)) {return value.map((item, index) => canonical(item, `${path}[${index}]`));}
  if (typeof value !== "object") {
    throw new Error(`${path} contains a non-canonical value`);
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right))) {
    if (item === undefined) {throw new Error(`${path}.${key} is undefined`);}
    output[key] = canonical(item, `${path}.${key}`);
  }
  return output;
}
