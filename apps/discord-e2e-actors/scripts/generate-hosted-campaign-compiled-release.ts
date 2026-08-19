import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

type JsonValue = boolean | null | number | string | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

const argumentsList = process.argv.slice(2);
const trustRootPath = requiredFlag(argumentsList, "--trust-root");
const expectedSha256 = requiredFlag(argumentsList, "--expected-sha256");
const defaultOutputPath = fileURLToPath(new URL(
  "../src/hosted-campaign-compiled-release.generated.ts",
  import.meta.url,
));
const outputPath = resolve(optionalFlag(argumentsList, "--output") ?? defaultOutputPath);
if (!/^[a-f\d]{64}$/u.test(expectedSha256)) {
  throw new Error("--expected-sha256 must be an exact lowercase SHA-256 digest");
}
const trustRoot = parseJson(await readFile(resolve(trustRootPath), "utf8"));
const canonicalTrustRoot = canonical(trustRoot);
const actualSha256 = digest(canonicalTrustRoot);
if (actualSha256 !== expectedSha256) {
  throw new Error("Reviewed trust-root digest does not match --expected-sha256");
}
const generatedRelease = {
  generatorVersion: 2,
  schemaVersion: 2,
  status: "admitted",
  trustRoot: canonicalTrustRoot,
  trustRootSha256: actualSha256,
} as const;
const source = "/** Generated. Review the input and digest; do not edit by hand. */\n" +
  `export const GENERATED_HOSTED_CAMPAIGN_COMPILED_RELEASE = Object.freeze(${JSON.stringify(
    generatedRelease,
    undefined,
    2,
  )} as const);\n`;
const temporaryPath = `${outputPath}.partial-${process.pid}`;
await writeFile(temporaryPath, source, { encoding: "utf8", mode: 0o600 });
await rename(temporaryPath, outputPath);

function requiredFlag(values: readonly string[], name: string): string {
  const value = optionalFlag(values, name);
  if (value === undefined) {
    throw new Error(`Missing required ${name}`);
  }
  return value;
}

function optionalFlag(values: readonly string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires one value`);
  }
  return value;
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseJson(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  if (!isJsonValue(value)) {
    throw new Error("Reviewed trust root must be canonical JSON data");
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right)).map(([key, nested]) => [key, canonical(nested)]));
}
