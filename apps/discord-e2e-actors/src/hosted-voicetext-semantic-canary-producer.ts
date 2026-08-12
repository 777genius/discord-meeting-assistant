import { createHash } from "node:crypto";

import { z } from "zod";

import {
  digestVoicetextSemanticCanaryReceiptContentV1,
  type VoicetextSemanticCanaryReceiptV1,
} from "./hosted-voicetext-semantic-canary-receipt.js";

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const segmentSchema = z.object({
  endMs: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  text: z.string().min(1).max(16_384),
}).strict().refine(({ endMs, startMs }) => endMs >= startMs);

export const voicetextCanaryInternalResultV1Schema = z.object({
  batch: z.object({
    firstSubmission: z.object({
      jobId: z.string().min(1).max(256), resultId: z.string().min(1).max(256), resultSha256: sha256Schema,
    }).strict(),
    idempotentReplay: z.object({
      jobId: z.string().min(1).max(256), resultId: z.string().min(1).max(256), resultSha256: sha256Schema,
    }).strict(),
    segments: z.array(segmentSchema).min(1).max(1_024),
    utteranceCount: z.number().int().positive().max(1_024),
  }).strict(),
  live: z.object({
    audioAcknowledgements: z.object({ expected: z.number().int().positive(), received: z.number().int().nonnegative() }).strict(),
    finalizeComplete: z.literal(true),
    protocolReady: z.literal(true),
    segments: z.array(segmentSchema).min(1).max(1_024),
  }).strict(),
  schemaVersion: z.literal(1),
  tokenFile: z.object({
    generationId: z.string().min(1).max(256), mode: z.literal(0o600),
    ownerUid: z.number().int().nonnegative(), path: z.string().startsWith("/").max(4_096),
  }).strict(),
}).strict();

export type VoicetextCanaryInternalResultV1 = z.infer<typeof voicetextCanaryInternalResultV1Schema>;

export interface VoicetextCanaryRunnerV1 {
  run(input: VoicetextCanaryRunnerInputV1): Promise<unknown>;
}

export interface VoicetextCanaryRunnerInputV1 {
  readonly binding: VoicetextSemanticCanaryReceiptV1["binding"];
  readonly endpoint: VoicetextSemanticCanaryReceiptV1["endpoint"];
  readonly fixturePath: string;
  readonly timeoutMs: number;
}

export interface ProduceVoicetextCanaryInputV1 extends VoicetextCanaryRunnerInputV1 {
  readonly expectedSegments: readonly z.infer<typeof segmentSchema>[];
  readonly generatedAtEpochMs: number;
  readonly requiredTerms: readonly string[];
  readonly ttlMs: number;
}

export async function produceVoicetextSemanticCanaryReceiptV1(
  input: ProduceVoicetextCanaryInputV1,
  runner: VoicetextCanaryRunnerV1,
): Promise<VoicetextSemanticCanaryReceiptV1> {
  assertInput(input);
  const result = voicetextCanaryInternalResultV1Schema.parse(await runner.run(input));
  assertIdempotentBatch(result);
  const expected = input.expectedSegments.map((segment) => segmentSchema.parse(segment));
  const expectedWords = normalizedWords(expected);
  const expectedCharacters = normalizedCharacters(expected);
  const requiredTerms = input.requiredTerms.map(normalizeText);
  const batchQuality = transcriptQuality(result.batch.segments, expected, expectedWords, expectedCharacters, requiredTerms);
  const liveQuality = transcriptQuality(result.live.segments, expected, expectedWords, expectedCharacters, requiredTerms);
  const batchDigest = digestCanonical(result.batch.segments);
  if (result.batch.firstSubmission.resultSha256 !== batchDigest) {
    throw new Error("Voicetext batch result digest does not match the immutable transcript result");
  }
  const content: Omit<VoicetextSemanticCanaryReceiptV1, "receiptSha256"> = {
    batch: {
      finalSegments: { count: result.batch.segments.length, digestSha256: batchDigest },
      firstSubmission: result.batch.firstSubmission,
      idempotentReplay: result.batch.idempotentReplay,
      utterances: { count: result.batch.utteranceCount, digestSha256: digestCanonical({ count: result.batch.utteranceCount, segments: result.batch.segments }) },
    },
    binding: input.binding,
    capability: "voicetext-semantic-canary",
    endpoint: input.endpoint,
    expiresAtEpochMs: input.generatedAtEpochMs + input.ttlMs,
    generatedAtEpochMs: input.generatedAtEpochMs,
    kind: "hosted-voicetext-semantic-canary-receipt",
    live: {
      audioAcknowledgements: result.live.audioAcknowledgements,
      finalSegments: { count: result.live.segments.length, digestSha256: digestCanonical(result.live.segments) },
      finalizeComplete: true,
      protocolReady: true,
    },
    quality: {
      characterErrorRate: Math.max(batchQuality.characterErrorRate, liveQuality.characterErrorRate),
      observedMaximumTimelineDeltaMs: Math.max(batchQuality.timelineDeltaMs, liveQuality.timelineDeltaMs),
      requiredTermMatches: Math.min(batchQuality.requiredTermMatches, liveQuality.requiredTermMatches),
      requiredTermsExpectationSha256: digestCanonical(requiredTerms),
      wordErrorRate: Math.max(batchQuality.wordErrorRate, liveQuality.wordErrorRate),
    },
    schemaVersion: 1,
    tokenFile: result.tokenFile,
  };
  return Object.freeze({ ...content, receiptSha256: digestVoicetextSemanticCanaryReceiptContentV1(content) });
}

function assertInput(input: ProduceVoicetextCanaryInputV1): void {
  if (!input.fixturePath.startsWith("/") || input.fixturePath.length > 4_096
    || !Number.isSafeInteger(input.generatedAtEpochMs) || input.generatedAtEpochMs < 0
    || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 300_000
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000
    || input.expectedSegments.length < 1 || input.expectedSegments.length > 1_024
    || input.requiredTerms.length < 1 || input.requiredTerms.length > 256) {
    throw new Error("Voicetext semantic canary producer input is invalid");
  }
  const expected = input.expectedSegments.map((segment) => segmentSchema.parse(segment));
  const normalizedTerms = input.requiredTerms.map(normalizeText);
  if (normalizedTerms.some((term) => term.length === 0) || new Set(normalizedTerms).size !== normalizedTerms.length
    || digestCanonical(expected) !== input.binding.transcriptExpectationSha256) {
    throw new Error("Voicetext semantic canary expectation binding is invalid");
  }
}

function assertIdempotentBatch(result: VoicetextCanaryInternalResultV1): void {
  const first = result.batch.firstSubmission;
  const replay = result.batch.idempotentReplay;
  if (first.jobId !== replay.jobId || first.resultId !== replay.resultId
    || first.resultSha256 !== replay.resultSha256) {
    throw new Error("Voicetext internal canary did not return one idempotent immutable batch result");
  }
  if (result.live.audioAcknowledgements.expected !== result.live.audioAcknowledgements.received) {
    throw new Error("Voicetext internal canary did not acknowledge every live audio chunk");
  }
}

interface TranscriptQuality {
  readonly characterErrorRate: number;
  readonly requiredTermMatches: number;
  readonly timelineDeltaMs: number;
  readonly wordErrorRate: number;
}

function transcriptQuality(
  actual: readonly z.infer<typeof segmentSchema>[],
  expected: readonly z.infer<typeof segmentSchema>[],
  expectedWords: readonly string[],
  expectedCharacters: readonly string[],
  requiredTerms: readonly string[],
): TranscriptQuality {
  const actualText = normalizeText(actual.map(({ text }) => text).join(" "));
  return {
    characterErrorRate: errorRate(expectedCharacters, Array.from(actualText.replaceAll(" ", ""))),
    requiredTermMatches: requiredTerms.filter((term) => actualText.includes(term)).length,
    timelineDeltaMs: maximumTimelineDelta(actual, expected),
    wordErrorRate: errorRate(expectedWords, actualText.length === 0 ? [] : actualText.split(" ")),
  };
}

function maximumTimelineDelta(
  actual: readonly z.infer<typeof segmentSchema>[], expected: readonly z.infer<typeof segmentSchema>[],
): number {
  if (actual.length !== expected.length) {return 60_000;}
  return actual.reduce((maximum, segment, index) => {
    const reference = expected[index];
    if (reference === undefined) {return 60_000;}
    return Math.max(maximum, Math.abs(segment.startMs - reference.startMs), Math.abs(segment.endMs - reference.endMs));
  }, 0);
}

function errorRate(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) {return actual.length === 0 ? 0 : 1;}
  const previous = Array.from({ length: actual.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= expected.length; row += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = row;
    for (let column = 1; column <= actual.length; column += 1) {
      const above = previous[column] ?? column;
      const substitution = diagonal + (expected[row - 1] === actual[column - 1] ? 0 : 1);
      diagonal = above;
      previous[column] = Math.min(above + 1, (previous[column - 1] ?? row) + 1, substitution);
    }
  }
  return Math.min(1, (previous.at(-1) ?? expected.length) / expected.length);
}

function normalizedWords(segments: readonly z.infer<typeof segmentSchema>[]): readonly string[] {
  const normalized = normalizeText(segments.map(({ text: segmentText }) => segmentText).join(" "));
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function normalizedCharacters(segments: readonly z.infer<typeof segmentSchema>[]): readonly string[] {
  return Array.from(normalizeText(segments.map(({ text }) => text).join(" ")).replaceAll(" ", ""));
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function digestVoicetextCanaryExpectationV1(value: unknown): string {
  return digestCanonical(value);
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
