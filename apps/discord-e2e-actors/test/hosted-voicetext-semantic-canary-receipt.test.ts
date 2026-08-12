import { describe, expect, it } from "vitest";

import {
  digestVoicetextSemanticCanaryReceiptContentV1,
  evaluateVoicetextSemanticCanaryReceiptV1,
  type VoicetextSemanticCanaryReceiptV1,
} from "../src/hosted-voicetext-semantic-canary-receipt.js";

const binding = {
  campaignId: "campaign-1", containerId: "platform-1", fixtureSha256: "a".repeat(64),
  host: "codex-workers-eu-01", imageDigestSha256: "b".repeat(64), planSha256: "c".repeat(64),
  sourceRevision: "d".repeat(40), transcriptExpectationSha256: "e".repeat(64),
} as const;
const endpoint = {
  batch: { origin: "https://voicetext.test", path: "/v2/listen" },
  live: { origin: "wss://voicetext.test", path: "/v1/listen" },
} as const;
const expectation = {
  binding, endpoint, maximumAgeMs: 60_000, maximumCharacterErrorRate: 0.15,
  maximumTimelineDeltaMs: 250, maximumWordErrorRate: 0.2, nowEpochMs: 110_000,
  requiredTermCount: 2, requiredTermsExpectationSha256: "5".repeat(64),
};

describe("hosted Voicetext semantic canary receipt", () => {
  it("accepts immutable batch/live evidence without retaining transcript or token text", () => {
    const result = evaluateVoicetextSemanticCanaryReceiptV1(receipt(), expectation);
    expect(result.batch.firstSubmission).toEqual(result.batch.idempotentReplay);
    expect(JSON.stringify(result)).not.toMatch(/transcriptText|tokenText/u);
  });

  it.each([
    ["digest tampering", (value: VoicetextSemanticCanaryReceiptV1) => ({ ...value, receiptSha256: "0".repeat(64) })],
    ["fixture substitution", (value: VoicetextSemanticCanaryReceiptV1) => signed({ ...withoutDigest(value), binding: { ...value.binding, fixtureSha256: "f".repeat(64) } })],
    ["endpoint redirection", (value: VoicetextSemanticCanaryReceiptV1) => signed({ ...withoutDigest(value), endpoint: { ...value.endpoint, batch: { ...value.endpoint.batch, path: "/other" } } })],
    ["changed idempotency result", (value: VoicetextSemanticCanaryReceiptV1) => signed({ ...withoutDigest(value), batch: { ...value.batch, idempotentReplay: { ...value.batch.idempotentReplay, resultId: "result-2" } } })],
    ["WER threshold failure", (value: VoicetextSemanticCanaryReceiptV1) => signed({ ...withoutDigest(value), quality: { ...value.quality, wordErrorRate: 0.21 } })],
    ["missing required term", (value: VoicetextSemanticCanaryReceiptV1) => signed({ ...withoutDigest(value), quality: { ...value.quality, requiredTermMatches: 1 } })],
    ["timeline threshold failure", (value: VoicetextSemanticCanaryReceiptV1) => signed({ ...withoutDigest(value), quality: { ...value.quality, observedMaximumTimelineDeltaMs: 251 } })],
    ["required-terms expectation mismatch", (value: VoicetextSemanticCanaryReceiptV1) => signed({ ...withoutDigest(value), quality: { ...value.quality, requiredTermsExpectationSha256: "6".repeat(64) } })],
    ["missing live ACK", (value: VoicetextSemanticCanaryReceiptV1) => signed({ ...withoutDigest(value), live: { ...value.live, audioAcknowledgements: { expected: 2, received: 1 } } })],
    ["expired receipt", (value: VoicetextSemanticCanaryReceiptV1) => signed({ ...withoutDigest(value), expiresAtEpochMs: 110_000 })],
  ])("rejects %s", (_label, mutate) => {
    expect(() => evaluateVoicetextSemanticCanaryReceiptV1(mutate(receipt()), expectation)).toThrow();
  });

  it.each([
    ["maximum WER", { maximumWordErrorRate: 1 }],
    ["maximum CER", { maximumCharacterErrorRate: 1 }],
    ["maximum timeline delta", { maximumTimelineDeltaMs: 86_400_000 }],
  ])("does not let a receipt select its %s", (_label, receiptPolicy) => {
    const base = receipt();
    const selfAuthorizing = signed({
      ...withoutDigest(base),
      quality: { ...base.quality, ...receiptPolicy },
    });
    expect(() => evaluateVoicetextSemanticCanaryReceiptV1(selfAuthorizing, expectation)).toThrow();
  });

  it.each([
    ["maximum WER of one", { maximumWordErrorRate: 1 }],
    ["maximum CER of one", { maximumCharacterErrorRate: 1 }],
    ["an unbounded timeline delta", { maximumTimelineDeltaMs: 86_400_000 }],
    ["zero required terms", { requiredTermCount: 0 }],
  ])("rejects a pinned expectation with %s", (_label, expectationPolicy) => {
    expect(() => evaluateVoicetextSemanticCanaryReceiptV1(
      receipt(), { ...expectation, ...expectationPolicy },
    )).toThrow(/expectation is invalid/u);
  });

  it("rejects fixture, endpoint, and deployment-provenance expectation mismatches", () => {
    const mismatches = [
      { ...expectation, binding: { ...binding, fixtureSha256: "f".repeat(64) } },
      { ...expectation, endpoint: { ...endpoint, live: { ...endpoint.live, path: "/v2/listen" } } },
      { ...expectation, binding: { ...binding, sourceRevision: "f".repeat(40) } },
    ];
    for (const mismatch of mismatches) {
      expect(() => evaluateVoicetextSemanticCanaryReceiptV1(receipt(), mismatch)).toThrow(
        /does not match its campaign binding/u,
      );
    }
  });

  it("rejects absent protocol completion, empty evidence, or non-private token metadata", () => {
    const base = receipt();
    const invalidValues = [
      { ...withoutDigest(base), live: { ...base.live, finalizeComplete: false } },
      { ...withoutDigest(base), batch: { ...base.batch, utterances: { count: 0, digestSha256: "3".repeat(64) } } },
      { ...withoutDigest(base), tokenFile: { ...base.tokenFile, mode: 0o644 } },
    ];
    for (const value of invalidValues) {
      expect(() => evaluateVoicetextSemanticCanaryReceiptV1(value, expectation)).toThrow();
    }
  });
});

function receipt(): VoicetextSemanticCanaryReceiptV1 {
  return signed({
    batch: {
      finalSegments: { count: 2, digestSha256: "1".repeat(64) },
      firstSubmission: { jobId: "job-1", resultId: "result-1", resultSha256: "2".repeat(64) },
      idempotentReplay: { jobId: "job-1", resultId: "result-1", resultSha256: "2".repeat(64) },
      utterances: { count: 2, digestSha256: "3".repeat(64) },
    },
    binding, capability: "voicetext-semantic-canary", endpoint, expiresAtEpochMs: 150_000,
    generatedAtEpochMs: 100_000, kind: "hosted-voicetext-semantic-canary-receipt",
    live: {
      audioAcknowledgements: { expected: 2, received: 2 },
      finalSegments: { count: 2, digestSha256: "4".repeat(64) },
      finalizeComplete: true, protocolReady: true,
    },
    quality: {
      characterErrorRate: 0.05, observedMaximumTimelineDeltaMs: 100,
      requiredTermMatches: 2, requiredTermsExpectationSha256: "5".repeat(64), wordErrorRate: 0.1,
    },
    schemaVersion: 1,
    tokenFile: { generationId: "generation-1", mode: 0o600, ownerUid: 10_001, path: "/run/secrets/voicetext" },
  });
}

function signed(
  content: Omit<VoicetextSemanticCanaryReceiptV1, "receiptSha256">,
): VoicetextSemanticCanaryReceiptV1 {
  return { ...content, receiptSha256: digestVoicetextSemanticCanaryReceiptContentV1(content) };
}

function withoutDigest(
  receiptValue: VoicetextSemanticCanaryReceiptV1,
): Omit<VoicetextSemanticCanaryReceiptV1, "receiptSha256"> {
  const { receiptSha256: _receiptSha256, ...content } = receiptValue;
  return content;
}
