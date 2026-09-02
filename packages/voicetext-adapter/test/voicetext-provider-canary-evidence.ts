import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const digestPattern = /^[a-f\d]{64}$/u;
const gitObjectPattern = /^(?:[a-f\d]{40}|[a-f\d]{64})$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const containerPattern = /^[a-f\d]{64}$/u;
const imageIdPattern = /^sha256:[a-f\d]{64}$/u;
const repositoryDigestPattern = /^[^\s@]+@sha256:[a-f\d]{64}$/u;
const pinnedRepository = "https://github.com/777genius/voicetext-gateway";

export type CanaryProvider = "deepgram" | "elevenlabs";

export interface GatewayRunningIdentityV1 {
  readonly containerId: string;
  readonly httpOrigin: string;
  readonly identitySha256: string;
  readonly imageDigest: string;
  readonly imageId: string;
  readonly kind: "voicetext-gateway-running-identity";
  readonly observedAt: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
  readonly sourceRepository: typeof pinnedRepository;
  readonly sourceTree: string;
  readonly wsOrigin: string;
}

export interface GatewayIdentityExpectation {
  readonly httpOrigin: string;
  readonly identitySha256: string;
  readonly imageDigest: string;
  readonly runId: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly wsOrigin: string;
}

interface TranscriptEvidence {
  readonly firstStartMs: number;
  readonly lastEndMs: number;
  readonly segmentCount: number;
  readonly textSha256: string;
}

export interface ProviderCanaryReceiptV1 {
  readonly batch: TranscriptEvidence & { readonly jobId: string };
  readonly createdAt: string;
  readonly expectedTermsSha256: string;
  readonly fixture: {
    readonly durationMs: number;
    readonly packetCount: number;
    readonly sha256: string;
  };
  readonly gatewayIdentity: GatewayRunningIdentityV1;
  readonly gatewayIdentitySha256: string;
  readonly kind: "voicetext-gateway-provider-canary-receipt";
  readonly live: TranscriptEvidence & {
    readonly acknowledgedPacketCount: number;
    readonly finalizeComplete: true;
  };
  readonly profile: {
    readonly batch: "deepgram-nova-3" | "elevenlabs-scribe-v2";
    readonly live: "deepgram-nova-3" | "elevenlabs-scribe-v2-realtime";
    readonly provider: CanaryProvider;
  };
  readonly receiptSha256: string;
  readonly runId: string;
  readonly schemaVersion: 1;
}

export interface ProviderCanaryReceiptContent {
  readonly batch: ProviderCanaryReceiptV1["batch"];
  readonly createdAt: string;
  readonly expectedTermsSha256: string;
  readonly fixture: ProviderCanaryReceiptV1["fixture"];
  readonly gatewayIdentity: GatewayRunningIdentityV1;
  readonly gatewayIdentitySha256: string;
  readonly kind: ProviderCanaryReceiptV1["kind"];
  readonly live: ProviderCanaryReceiptV1["live"];
  readonly profile: ProviderCanaryReceiptV1["profile"];
  readonly runId: string;
  readonly schemaVersion: 1;
}

export interface ReceiptExpectation {
  readonly expectedTermsSha256: string;
  readonly fixtureSha256: string;
  readonly gatewayIdentitySha256: string;
  readonly profile: CanaryProvider;
  readonly runId: string;
}

export function parseGatewayRunningIdentity(
  value: unknown,
  expected: GatewayIdentityExpectation,
): GatewayRunningIdentityV1 {
  const identity = record(value, "gateway identity");
  exactKeys(identity, [
    "containerId", "httpOrigin", "identitySha256", "imageDigest", "imageId", "kind",
    "observedAt", "runId", "schemaVersion", "sourceCommit", "sourceRepository",
    "sourceTree", "wsOrigin",
  ], "gateway identity");
  const parsed = identity as unknown as GatewayRunningIdentityV1;
  if (parsed.kind !== "voicetext-gateway-running-identity" || parsed.schemaVersion !== 1
    || !containerPattern.test(parsed.containerId) || !imageIdPattern.test(parsed.imageId)
    || !repositoryDigestPattern.test(parsed.imageDigest)
    || !gitObjectPattern.test(parsed.sourceCommit) || !gitObjectPattern.test(parsed.sourceTree)
    || parsed.sourceRepository !== pinnedRepository || !identifierPattern.test(parsed.runId)
    || !isCanonicalTimestamp(parsed.observedAt)
    || !digestPattern.test(parsed.identitySha256)
    || !isExactOrigin(parsed.httpOrigin, ["http:", "https:"])
    || !isExactOrigin(parsed.wsOrigin, ["ws:", "wss:"])) {
    throw new Error("Gateway running identity schema is invalid");
  }
  const { identitySha256, ...content } = parsed;
  if (digestCanonical(content) !== identitySha256) {
    throw new Error("Gateway running identity digest is invalid");
  }
  if (identitySha256 !== expected.identitySha256 || parsed.runId !== expected.runId
    || parsed.sourceCommit !== expected.sourceCommit || parsed.sourceTree !== expected.sourceTree
    || parsed.imageDigest !== expected.imageDigest || parsed.httpOrigin !== expected.httpOrigin
    || parsed.wsOrigin !== expected.wsOrigin) {
    throw new Error("Running gateway identity does not match the exact canary expectation");
  }
  return Object.freeze(parsed);
}

export function buildGatewayRunningIdentity(
  content: Omit<GatewayRunningIdentityV1, "identitySha256">,
): GatewayRunningIdentityV1 {
  return Object.freeze({ ...content, identitySha256: digestCanonical(content) });
}

export function buildProviderCanaryReceipt(
  content: ProviderCanaryReceiptContent,
): ProviderCanaryReceiptV1 {
  return Object.freeze({ ...content, receiptSha256: digestCanonical(content) });
}

export function validateProviderCanaryReceipt(
  value: unknown,
  expected: ReceiptExpectation,
): ProviderCanaryReceiptV1 {
  const receipt = record(value, "provider canary receipt");
  exactKeys(receipt, [
    "batch", "createdAt", "expectedTermsSha256", "fixture", "gatewayIdentity",
    "gatewayIdentitySha256", "kind", "live", "profile", "receiptSha256", "runId",
    "schemaVersion",
  ], "provider canary receipt");
  const parsed = receipt as unknown as ProviderCanaryReceiptV1;
  if (parsed.kind !== "voicetext-gateway-provider-canary-receipt" || parsed.schemaVersion !== 1
    || !identifierPattern.test(parsed.runId) || !isCanonicalTimestamp(parsed.createdAt)
    || !digestPattern.test(parsed.receiptSha256) || !digestPattern.test(parsed.expectedTermsSha256)
    || !digestPattern.test(parsed.gatewayIdentitySha256)) {
    throw new Error("Provider canary receipt envelope is invalid");
  }
  const { receiptSha256, ...content } = parsed;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Provider canary receipt digest is invalid");
  }
  validateTranscriptEvidence(parsed.batch, true);
  validateTranscriptEvidence(parsed.live, false);
  validateFixture(parsed.fixture);
  validateProfile(parsed.profile);
  if (parsed.live.finalizeComplete !== true
    || parsed.live.acknowledgedPacketCount !== parsed.fixture.packetCount
    || parsed.gatewayIdentity.identitySha256 !== parsed.gatewayIdentitySha256
    || parsed.runId !== parsed.gatewayIdentity.runId
    || parsed.runId !== expected.runId || parsed.fixture.sha256 !== expected.fixtureSha256
    || parsed.gatewayIdentitySha256 !== expected.gatewayIdentitySha256
    || parsed.expectedTermsSha256 !== expected.expectedTermsSha256
    || parsed.profile.provider !== expected.profile) {
    throw new Error("Provider canary receipt does not match its exact evidence binding");
  }
  parseGatewayRunningIdentity(parsed.gatewayIdentity, {
    httpOrigin: parsed.gatewayIdentity.httpOrigin,
    identitySha256: expected.gatewayIdentitySha256,
    imageDigest: parsed.gatewayIdentity.imageDigest,
    runId: expected.runId,
    sourceCommit: parsed.gatewayIdentity.sourceCommit,
    sourceTree: parsed.gatewayIdentity.sourceTree,
    wsOrigin: parsed.gatewayIdentity.wsOrigin,
  });
  return Object.freeze(parsed);
}

export async function writeCreateOnlyReceipt(
  path: string,
  receipt: ProviderCanaryReceiptV1,
): Promise<void> {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("Provider canary receipt path must be absolute");
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function validateTranscriptEvidence(value: unknown, includesJobId: boolean): void {
  const evidence = record(value, "transcript evidence");
  exactKeys(evidence, includesJobId
    ? ["firstStartMs", "jobId", "lastEndMs", "segmentCount", "textSha256"]
    : ["acknowledgedPacketCount", "finalizeComplete", "firstStartMs", "lastEndMs", "segmentCount", "textSha256"],
  "transcript evidence");
  if (!isNonnegativeInteger(evidence.firstStartMs) || !isNonnegativeInteger(evidence.lastEndMs)
    || (evidence.lastEndMs as number) <= (evidence.firstStartMs as number)
    || !Number.isSafeInteger(evidence.segmentCount) || (evidence.segmentCount as number) < 1
    || typeof evidence.textSha256 !== "string" || !digestPattern.test(evidence.textSha256)
    || (includesJobId && (typeof evidence.jobId !== "string" || !identifierPattern.test(evidence.jobId)))) {
    throw new Error("Provider canary transcript evidence is invalid");
  }
}

function validateFixture(value: unknown): void {
  const fixture = record(value, "fixture evidence");
  exactKeys(fixture, ["durationMs", "packetCount", "sha256"], "fixture evidence");
  if (typeof fixture.durationMs !== "number" || !Number.isFinite(fixture.durationMs)
    || fixture.durationMs <= 0 || !Number.isSafeInteger(fixture.packetCount)
    || (fixture.packetCount as number) < 1 || typeof fixture.sha256 !== "string"
    || !digestPattern.test(fixture.sha256)) {
    throw new Error("Provider canary fixture evidence is invalid");
  }
}

function validateProfile(value: unknown): void {
  const profile = record(value, "profile");
  exactKeys(profile, ["batch", "live", "provider"], "profile");
  const valid = (profile.provider === "deepgram" && profile.batch === "deepgram-nova-3"
      && profile.live === "deepgram-nova-3")
    || (profile.provider === "elevenlabs" && profile.batch === "elevenlabs-scribe-v2"
      && profile.live === "elevenlabs-scribe-v2-realtime");
  if (!valid) {
    throw new Error("Provider canary profile is invalid");
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && new Date(value).toISOString() === value;
}

function isExactOrigin(value: unknown, protocols: readonly string[]): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && url.origin === value
      && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}
