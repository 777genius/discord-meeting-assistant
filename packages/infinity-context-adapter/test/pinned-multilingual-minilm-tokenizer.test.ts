import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE,
  PinnedMultilingualMiniLmTokenizer,
  PinnedMultilingualMiniLmTokenizerError,
  type PinnedMultilingualMiniLmArtifacts,
} from "../src/index.js";

const assetDirectory = new URL(
  "../assets/paraphrase-multilingual-minilm-l12-v2-e8f8c211/",
  import.meta.url,
);

function artifacts(): PinnedMultilingualMiniLmArtifacts {
  return {
    conformance: readFileSync(new URL("conformance.v1.json", assetDirectory)),
    tokenizerConfig: readFileSync(new URL("tokenizer_config.json", assetDirectory)),
    tokenizerJson: readFileSync(new URL("tokenizer.json", assetDirectory)),
  };
}

function tamper(value: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(value);
  copy[0] = (copy[0] ?? 0) ^ 1;
  return copy;
}

describe("pinned multilingual MiniLM tokenizer", () => {
  it("matches exact token counts observed from the pinned TEI runtime", () => {
    const tokenizer = new PinnedMultilingualMiniLmTokenizer();

    expect([
      tokenizer.countTokens("Hello, world!"),
      tokenizer.countTokens("Привет, мир!"),
      tokenizer.countTokens("你好，世界。"),
      tokenizer.countTokens("👋🏽🚀"),
      tokenizer.countTokens("é café"),
      tokenizer.countTokens("email@example.com -- 42%"),
    ]).toEqual([6, 7, 7, 6, 4, 12]);
    expect(tokenizer.profile).toEqual(PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE);
  });

  it("counts beyond the serving maximum instead of silently truncating", () => {
    const tokenizer = new PinnedMultilingualMiniLmTokenizer();

    expect(tokenizer.countTokens("word ".repeat(126))).toBe(128);
    expect(tokenizer.countTokens("word ".repeat(127))).toBe(129);
    expect(tokenizer.profile.maxInputTokens).toBe(128);
  });

  it.each([
    "tokenizerJson",
    "tokenizerConfig",
    "conformance",
  ] as const)("fails closed when %s bytes are tampered", (field) => {
    const original = artifacts();

    expect(() => new PinnedMultilingualMiniLmTokenizer({
      ...original,
      [field]: tamper(original[field]),
    })).toThrow(PinnedMultilingualMiniLmTokenizerError);
  });

  it("is deterministic across independently constructed instances", () => {
    const first = new PinnedMultilingualMiniLmTokenizer();
    const second = new PinnedMultilingualMiniLmTokenizer();
    const samples = [
      "Русский and English",
      "漢字とかな punctuation?!",
      "👨‍👩‍👧‍👦 café café",
    ];

    expect(samples.map((sample) => first.countTokens(sample))).toEqual(
      samples.map((sample) => second.countTokens(sample)),
    );
  });
});
