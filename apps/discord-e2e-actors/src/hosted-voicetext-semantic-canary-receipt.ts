import { createHash } from "node:crypto";

import { z } from "zod";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const countAndDigestSchema = z.object({ count: z.number().int().nonnegative(), digestSha256: sha256Schema }).strict();
const endpointSchema = z.object({
  origin: z.url().refine((value) => new URL(value).origin === value),
  path: z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u),
}).strict();
const maximumAllowedTimelineDeltaMs = 60_000;

export const voicetextSemanticCanaryReceiptV1Schema = z.object({
  batch: z.object({
    finalSegments: countAndDigestSchema,
    firstSubmission: z.object({ jobId: identifierSchema, resultId: identifierSchema, resultSha256: sha256Schema }).strict(),
    idempotentReplay: z.object({ jobId: identifierSchema, resultId: identifierSchema, resultSha256: sha256Schema }).strict(),
    utterances: countAndDigestSchema,
  }).strict(),
  binding: z.object({
    campaignId: identifierSchema,
    containerId: identifierSchema,
    fixtureSha256: sha256Schema,
    host: identifierSchema,
    imageDigestSha256: sha256Schema,
    planSha256: sha256Schema,
    sourceRevision: sourceRevisionSchema,
    transcriptExpectationSha256: sha256Schema,
  }).strict(),
  capability: z.literal("voicetext-semantic-canary"),
  endpoint: z.object({ batch: endpointSchema, live: endpointSchema }).strict(),
  expiresAtEpochMs: z.number().int().nonnegative(),
  generatedAtEpochMs: z.number().int().nonnegative(),
  kind: z.literal("hosted-voicetext-semantic-canary-receipt"),
  live: z.object({
    audioAcknowledgements: z.object({ expected: z.number().int().positive(), received: z.number().int().nonnegative() }).strict(),
    finalSegments: countAndDigestSchema,
    finalizeComplete: z.literal(true),
    protocolReady: z.literal(true),
  }).strict(),
  quality: z.object({
    characterErrorRate: z.number().min(0).max(1),
    observedMaximumTimelineDeltaMs: z.number().int().nonnegative(),
    requiredTermMatches: z.number().int().nonnegative(),
    requiredTermsExpectationSha256: sha256Schema,
    wordErrorRate: z.number().min(0).max(1),
  }).strict(),
  receiptSha256: sha256Schema,
  schemaVersion: z.literal(1),
  tokenFile: z.object({
    generationId: identifierSchema,
    mode: z.literal(0o600),
    ownerUid: z.number().int().nonnegative(),
    path: z.string().startsWith("/"),
  }).strict(),
}).strict();

export type VoicetextSemanticCanaryReceiptV1 = z.infer<typeof voicetextSemanticCanaryReceiptV1Schema>;

export interface VoicetextSemanticCanaryExpectationV1 {
  readonly binding: VoicetextSemanticCanaryReceiptV1["binding"];
  readonly endpoint: VoicetextSemanticCanaryReceiptV1["endpoint"];
  readonly maximumCharacterErrorRate: number;
  readonly maximumAgeMs: number;
  readonly maximumTimelineDeltaMs: number;
  readonly maximumWordErrorRate: number;
  readonly nowEpochMs: number;
  readonly requiredTermCount: number;
  readonly requiredTermsExpectationSha256: string;
}

export function digestVoicetextSemanticCanaryReceiptContentV1(
  content: Omit<VoicetextSemanticCanaryReceiptV1, "receiptSha256">,
): string {
  return digestCanonical(content);
}

export function evaluateVoicetextSemanticCanaryReceiptV1(
  value: unknown,
  expected: VoicetextSemanticCanaryExpectationV1,
): VoicetextSemanticCanaryReceiptV1 {
  const receipt = voicetextSemanticCanaryReceiptV1Schema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestVoicetextSemanticCanaryReceiptContentV1(content) !== receiptSha256) {
    throw new Error("Voicetext semantic canary receipt digest is invalid");
  }
  assertLifetime(receipt, expected);
  if (JSON.stringify(receipt.binding) !== JSON.stringify(expected.binding)
    || JSON.stringify(receipt.endpoint) !== JSON.stringify(expected.endpoint)) {
    throw new Error("Voicetext semantic canary does not match its campaign binding");
  }
  assertBatchIdempotency(receipt);
  assertSemanticThresholds(receipt, expected);
  return Object.freeze(receipt);
}

function assertLifetime(
  receipt: VoicetextSemanticCanaryReceiptV1,
  expected: VoicetextSemanticCanaryExpectationV1,
): void {
  if (!Number.isSafeInteger(expected.maximumAgeMs) || expected.maximumAgeMs < 1
    || !Number.isSafeInteger(expected.nowEpochMs)
    || receipt.expiresAtEpochMs <= receipt.generatedAtEpochMs
    || receipt.generatedAtEpochMs > expected.nowEpochMs
    || expected.nowEpochMs >= receipt.expiresAtEpochMs
    || expected.nowEpochMs - receipt.generatedAtEpochMs > expected.maximumAgeMs) {
    throw new Error("Voicetext semantic canary is stale, expired, or from the future");
  }
}

function assertBatchIdempotency(receipt: VoicetextSemanticCanaryReceiptV1): void {
  const first = receipt.batch.firstSubmission;
  const replay = receipt.batch.idempotentReplay;
  if (first.jobId !== replay.jobId || first.resultId !== replay.resultId
    || first.resultSha256 !== replay.resultSha256) {
    throw new Error("Voicetext batch canary did not preserve the idempotent job and result");
  }
  if (receipt.batch.utterances.count < 1 || receipt.batch.finalSegments.count < 1
    || receipt.live.finalSegments.count < 1) {
    throw new Error("Voicetext semantic canary contains no immutable transcript evidence");
  }
}

function assertSemanticThresholds(
  receipt: VoicetextSemanticCanaryReceiptV1,
  expected: VoicetextSemanticCanaryExpectationV1,
): void {
  const { live, quality } = receipt;
  if (!isRate(expected.maximumWordErrorRate)
    || !isRate(expected.maximumCharacterErrorRate)
    || !Number.isSafeInteger(expected.maximumTimelineDeltaMs) || expected.maximumTimelineDeltaMs < 0
    || expected.maximumTimelineDeltaMs > maximumAllowedTimelineDeltaMs
    || !Number.isSafeInteger(expected.requiredTermCount) || expected.requiredTermCount < 1
    || !sha256Schema.safeParse(expected.requiredTermsExpectationSha256).success) {
    throw new Error("Voicetext semantic canary expectation is invalid");
  }
  if (live.audioAcknowledgements.received !== live.audioAcknowledgements.expected
    || quality.wordErrorRate > expected.maximumWordErrorRate
    || quality.characterErrorRate > expected.maximumCharacterErrorRate
    || quality.observedMaximumTimelineDeltaMs > expected.maximumTimelineDeltaMs
    || quality.requiredTermsExpectationSha256 !== expected.requiredTermsExpectationSha256
    || quality.requiredTermMatches !== expected.requiredTermCount) {
    throw new Error("Voicetext semantic canary did not satisfy its protocol or quality thresholds");
  }
}

function isRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value < 1;
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalize);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}
