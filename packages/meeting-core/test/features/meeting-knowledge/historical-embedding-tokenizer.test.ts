import { describe, expect, it } from "vitest";

import {
  HistoricalEmbeddingTokenizerQualificationError,
  prepareQualifiedHistoricalEmbeddingTokenizer,
  type HistoricalEmbeddingTokenizerPort,
  type HistoricalEmbeddingTokenizerProfileV1,
} from "../../../src/features/meeting-knowledge/index.js";

const profile: HistoricalEmbeddingTokenizerProfileV1 = Object.freeze({
  conformanceVectorSetSha256: `sha256:${"c".repeat(64)}`,
  embeddingModelRevision: "a".repeat(40),
  id: "pinned-tokenizer",
  maxInputTokens: 128,
  teiBuildRevision: "b".repeat(40),
  tokenizerArtifactSha256: `sha256:${"d".repeat(64)}`,
  tokenizerConfigSha256: `sha256:${"e".repeat(64)}`,
});

const tokenizer: HistoricalEmbeddingTokenizerPort = Object.freeze({
  countTokens: (text: string) => Array.from(text).length + 2,
  profile,
});

function compatibility(overrides: Partial<Parameters<
  typeof prepareQualifiedHistoricalEmbeddingTokenizer
>[1]> = {}): Parameters<typeof prepareQualifiedHistoricalEmbeddingTokenizer>[1] {
  return {
    expectedEmbeddingProfileDigestSha256: `sha256:${"f".repeat(64)}`,
    expectedEmbeddingProfileId: "dense-profile.v1",
    expectedTokenizerProfile: profile,
    observedEmbeddingProfileDigestSha256: `sha256:${"f".repeat(64)}`,
    observedEmbeddingProfileId: "dense-profile.v1",
    ...overrides,
  };
}

describe("historical embedding tokenizer qualification", () => {
  it("returns the exact admitted tokenizer without wrapping its deterministic counter", () => {
    const admitted = prepareQualifiedHistoricalEmbeddingTokenizer(
      tokenizer,
      compatibility(),
    );

    expect(admitted).toBe(tokenizer);
    expect(admitted.countTokens("Привет")).toBe(8);
  });

  it.each([
    ["id", "other"],
    ["embeddingModelRevision", "1".repeat(40)],
    ["teiBuildRevision", "2".repeat(40)],
    ["tokenizerArtifactSha256", `sha256:${"3".repeat(64)}`],
    ["tokenizerConfigSha256", `sha256:${"4".repeat(64)}`],
    ["conformanceVectorSetSha256", `sha256:${"5".repeat(64)}`],
    ["maxInputTokens", 127],
  ] as const)("rejects a mismatched local %s", (field, value) => {
    const expectedTokenizerProfile = Object.freeze({ ...profile, [field]: value });

    expect(() => prepareQualifiedHistoricalEmbeddingTokenizer(
      tokenizer,
      compatibility({ expectedTokenizerProfile }),
    )).toThrow(HistoricalEmbeddingTokenizerQualificationError);
  });

  it.each([
    { observedEmbeddingProfileId: null },
    { observedEmbeddingProfileId: "other" },
    { observedEmbeddingProfileDigestSha256: null },
    { observedEmbeddingProfileDigestSha256: `sha256:${"0".repeat(64)}` },
  ])("rejects missing or mismatched live Infinity capability evidence", (override) => {
    expect(() => prepareQualifiedHistoricalEmbeddingTokenizer(
      tokenizer,
      compatibility(override),
    )).toThrow(HistoricalEmbeddingTokenizerQualificationError);
  });

  it("rejects a malformed reviewed Infinity profile binding", () => {
    expect(() => prepareQualifiedHistoricalEmbeddingTokenizer(
      tokenizer,
      compatibility({
        expectedEmbeddingProfileDigestSha256: "sha256:mutable" as `sha256:${string}`,
      }),
    )).toThrow("expected Infinity embedding profile binding is invalid");
  });

  it("rejects malformed reviewed profiles before admission", () => {
    const expectedTokenizerProfile = Object.freeze({
      ...profile,
      embeddingModelRevision: "mutable-main",
    });

    expect(() => prepareQualifiedHistoricalEmbeddingTokenizer(
      tokenizer,
      compatibility({ expectedTokenizerProfile }),
    )).toThrow("expected tokenizer profile is invalid");
  });
});
