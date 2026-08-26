import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { buildHistoricalIndexPlan } from
  "@discord-meeting/meeting-core/meeting-knowledge";

import {
  INFINITY_CONTEXT_SDK_PROVENANCE,
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE,
  HmacHistoricalOpaqueIds,
  PinnedMultilingualMiniLmTokenizer,
  PinnedMultilingualMiniLmTokenizerError,
  type PinnedMultilingualMiniLmArtifacts,
} from "../src/index.js";
import {
  PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME,
  PINNED_MULTILINGUAL_MINILM_EMBEDDING_PROFILE_ID,
  historicalIndexProfileIdForSemanticTuple,
  type InfinityContextHistoricalIndexSemanticTupleV2,
} from "../src/pinned-multilingual-minilm-tokenizer.js";
import { finalMeeting } from "./historical-e2e-test-kit.js";

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

const semanticTuple: InfinityContextHistoricalIndexSemanticTupleV2 = {
  conformanceVectorSetSha256:
    PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.conformanceVectorSetSha256,
  embeddingModelRevision:
    PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.embeddingModelRevision,
  embeddingProfileId: PINNED_MULTILINGUAL_MINILM_EMBEDDING_PROFILE_ID,
  embeddingProfileInstanceDigestSha256: `sha256:${"a".repeat(64)}`,
  maxInputTokens: PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.maxInputTokens,
  serviceRevision: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
  servingRuntimeRevision:
    PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.servingRuntimeRevision,
  tokenizerArtifactSha256:
    PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.tokenizerArtifactSha256,
  tokenizerConfigSha256:
    PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.tokenizerConfigSha256,
  tokenizerRuntimeIntegrity: PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME.integrity,
  tokenizerRuntimeManifestSha256:
    PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME.manifestSha256,
  tokenizerRuntimePackage: PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME.package,
  tokenizerRuntimeSha256: PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME.runtimeSha256,
  tokenizerRuntimeTarballSha256:
    PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME.tarballSha256,
  tokenizerRuntimeVersion: PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME.version,
};

const componentChanges: readonly [
  keyof InfinityContextHistoricalIndexSemanticTupleV2,
  string | number,
][] = [
  ["conformanceVectorSetSha256", `sha256:${"b".repeat(64)}`],
  ["embeddingModelRevision", "f".repeat(40)],
  ["embeddingProfileId", "changed-profile"],
  ["embeddingProfileInstanceDigestSha256", `sha256:${"b".repeat(64)}`],
  ["maxInputTokens", 129],
  ["serviceRevision", "f".repeat(40)],
  ["servingRuntimeRevision", "f".repeat(40)],
  ["tokenizerArtifactSha256", `sha256:${"b".repeat(64)}`],
  ["tokenizerConfigSha256", `sha256:${"b".repeat(64)}`],
  ["tokenizerRuntimeIntegrity", `sha512-${"A".repeat(86)}==`],
  ["tokenizerRuntimeManifestSha256", `sha256:${"b".repeat(64)}`],
  ["tokenizerRuntimePackage", "@huggingface/tokenizers-changed"],
  ["tokenizerRuntimeSha256", `sha256:${"b".repeat(64)}`],
  ["tokenizerRuntimeTarballSha256", `sha256:${"b".repeat(64)}`],
  ["tokenizerRuntimeVersion", "0.1.4"],
];

describe("pinned multilingual MiniLM tokenizer", () => {
  it.each(componentChanges)(
    "changes durable index identity when %s changes",
    (component, changedValue) => {
      const changedTuple = {
        ...semanticTuple,
        [component]: changedValue,
      } as InfinityContextHistoricalIndexSemanticTupleV2;

      expect(historicalIndexProfileIdForSemanticTuple(changedTuple)).not.toBe(
        historicalIndexProfileIdForSemanticTuple(semanticTuple),
      );
    },
  );

  it("rejects malformed semantic tuple identities", () => {
    expect(() => historicalIndexProfileIdForSemanticTuple({
      ...semanticTuple,
      embeddingProfileInstanceDigestSha256: "operator-label",
    })).toThrow(RangeError);
    expect(() => historicalIndexProfileIdForSemanticTuple({
      ...semanticTuple,
      maxInputTokens: 0,
    })).toThrow(RangeError);
    expect(() => historicalIndexProfileIdForSemanticTuple({
      ...semanticTuple,
      tokenizerRuntimePackage: "",
    })).toThrow(RangeError);
  });

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

  it("splits the exact 190-token Cyrillic regression before the 96-token limit", () => {
    const tokenizer = new PinnedMultilingualMiniLmTokenizer();
    const base = finalMeeting(1, "Tuesday");
    const text = "Привет".repeat(94);
    const meeting = Object.freeze({
      ...base,
      humanTurns: Object.freeze([Object.freeze({
        ...base.humanTurns[0]!,
        text,
        turnId: "cyrillic-regression",
      })]),
    });
    const plan = buildHistoricalIndexPlan(
      meeting,
      new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x33)),
      {
        maximumEmbeddingTokens: 96,
        maxBlockUtf8Bytes: 4_096,
        maxBlocksPerMeeting: 500,
        maxTurnsPerBlock: 64,
        version: "meeting-knowledge.block-policy.v1",
      },
      tokenizer,
    );

    expect(tokenizer.countTokens(text)).toBe(190);
    expect(plan.documents.length).toBeGreaterThan(1);
    expect(plan.documents.every(({ embeddingText, manifest }) =>
      tokenizer.countTokens(embeddingText) === manifest.embeddingTokenEstimate &&
      manifest.embeddingTokenEstimate <= 96
    )).toBe(true);
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
  }, 30_000);
});
