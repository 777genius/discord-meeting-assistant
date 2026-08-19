import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type {
  HistoricalEmbeddingTokenizerPort,
  HistoricalEmbeddingTokenizerProfileV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import { INFINITY_CONTEXT_SDK_PROVENANCE } from "./infinity-runtime-provenance.js";

interface TokenizerRuntime {
  encode(
    text: string,
    options: Readonly<{ add_special_tokens: true }>,
  ): Readonly<{ ids: readonly number[] }>;
}

interface TokenizerModule {
  readonly Tokenizer: new (
    tokenizer: Readonly<Record<string, unknown>>,
    config: Readonly<Record<string, unknown>>,
  ) => TokenizerRuntime;
}

// 0.1.3 ships NodeNext-incompatible declarations. Keep that provider defect
// inside this adapter while the exact runtime package remains lockfile-pinned.
const tokenizerRequire = createRequire(import.meta.url);
const tokenizerRuntimePath = tokenizerRequire.resolve("@huggingface/tokenizers");
const tokenizerModule = tokenizerRequire("@huggingface/tokenizers") as TokenizerModule;

export const PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME = Object.freeze({
  integrity:
    "sha512-8rF/RRT10u+kn7YuUbUg0OF30K8rjTc78aHpxT+qJ1uWSqxT1MHi8+9ltwYfkFYJzT/oS+qw3JVfHtNMGAdqyA==",
  manifestSha256:
    "sha256:2e5425540a964ccbc721566f0e066772c4be7339a4663d9f33c3b04be4d2daaf",
  package: "@huggingface/tokenizers",
  runtimeSha256:
    "sha256:31a6ace9e7b9bab8e16e27b575308fe698546457fc0f78bd9b8729bd1139d7f2",
  tarballSha256:
    "sha256:0ef814be66cad9c1123859b2b46a7220a6215c4deb9752e1a345c470f06268cb",
  version: "0.1.3",
});

function verifyInstalledTokenizerRuntime(): void {
  const runtimeSuffix = "dist/tokenizers.cjs";
  if (!tokenizerRuntimePath.replaceAll("\\", "/").endsWith(runtimeSuffix)) {
    throw new PinnedMultilingualMiniLmTokenizerError(
      "tokenizer runtime entrypoint mismatch",
    );
  }
  const manifestPath =
    `${tokenizerRuntimePath.slice(0, -runtimeSuffix.length)}package.json`;
  verifyDigest(
    readFileSync(tokenizerRuntimePath),
    PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME.runtimeSha256,
    "@huggingface/tokenizers runtime",
  );
  const manifest = readFileSync(manifestPath);
  verifyDigest(
    manifest,
    PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME.manifestSha256,
    "@huggingface/tokenizers package manifest",
  );
  const parsed = parseObject(manifest, "@huggingface/tokenizers package manifest");
  if (
    parsed.name !== PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME.package ||
    parsed.version !== PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME.version
  ) {
    throw new PinnedMultilingualMiniLmTokenizerError(
      "tokenizer runtime identity mismatch",
    );
  }
}

const assetDirectory = new URL(
  "../assets/paraphrase-multilingual-minilm-l12-v2-e8f8c211/",
  import.meta.url,
);

const tokenizerArtifactSha256 =
  "sha256:2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8";
const tokenizerConfigSha256 =
  "sha256:5036ea374ffedd706e3bef33e2e0d6953cb868ef8a490e76e32ba0faa37a6b9b";
const conformanceVectorSetSha256 =
  "sha256:59126ff07b10202d43c04bc1d1e87b92040f2ce9760a2e44dfed6cf314deeaf4";

export const PINNED_MULTILINGUAL_MINILM_EMBEDDING_PROFILE_ID =
  "tei-sentence-transformers-paraphrase-multilingual-minilm-l12-v2-384d-dense.v1";

export const PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE:
HistoricalEmbeddingTokenizerProfileV1 = Object.freeze({
  conformanceVectorSetSha256,
  embeddingModelRevision: "e8f8c211226b894fcb81acc59f3b34ba3efd5f42",
  id: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
  maxInputTokens: 128,
  servingRuntimeRevision: "78502d8e61223d2c73d4bb7aeaea46787e90d596",
  tokenizerArtifactSha256,
  tokenizerConfigSha256,
});

/** Opaque durable identity for indexes produced by this exact qualified stack. */
const PINNED_INFINITY_CONTEXT_HISTORICAL_INDEX_PROFILE_BASE_ID = [
  "meeting-knowledge.infinity-index.v1",
  INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
  PINNED_MULTILINGUAL_MINILM_EMBEDDING_PROFILE_ID,
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.embeddingModelRevision,
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.servingRuntimeRevision,
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.conformanceVectorSetSha256,
].join("|");

/** Binds durable serving identity to the exact qualified deployment instance. */
export function infinityContextHistoricalIndexProfileId(
  embeddingProfileDigestSha256: string,
): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(embeddingProfileDigestSha256)) {
    throw new RangeError("embedding profile digest must be an exact SHA-256 identity");
  }
  return `${PINNED_INFINITY_CONTEXT_HISTORICAL_INDEX_PROFILE_BASE_ID}|${embeddingProfileDigestSha256}`;
}

export interface PinnedMultilingualMiniLmArtifacts {
  readonly conformance: Uint8Array;
  readonly tokenizerConfig: Uint8Array;
  readonly tokenizerJson: Uint8Array;
}

interface ConformanceVector {
  readonly ids: readonly number[];
  readonly text: string;
}

interface ConformanceReceipt {
  readonly imageDigestSha256: string;
  readonly maxInputTokens: number;
  readonly modelRevision: string;
  readonly schemaVersion: string;
  readonly teiBuildRevision: string;
  readonly teiVersion: string;
  readonly vectors: readonly ConformanceVector[];
}

export class PinnedMultilingualMiniLmTokenizerError extends Error {
  public override readonly name = "PinnedMultilingualMiniLmTokenizerError";
}

/** Exact, offline tokenizer used by the qualified historical embedding plan. */
export class PinnedMultilingualMiniLmTokenizer
implements HistoricalEmbeddingTokenizerPort {
  public readonly profile = PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE;
  readonly #tokenizer: TokenizerRuntime;

  public constructor(artifacts: PinnedMultilingualMiniLmArtifacts = loadArtifacts()) {
    verifyInstalledTokenizerRuntime();
    verifyDigest(artifacts.tokenizerJson, tokenizerArtifactSha256, "tokenizer.json");
    verifyDigest(
      artifacts.tokenizerConfig,
      tokenizerConfigSha256,
      "tokenizer_config.json",
    );
    verifyDigest(
      artifacts.conformance,
      conformanceVectorSetSha256,
      "conformance.v1.json",
    );
    const tokenizerJson = parseObject(artifacts.tokenizerJson, "tokenizer.json");
    const tokenizerConfig = parseObject(
      artifacts.tokenizerConfig,
      "tokenizer_config.json",
    );
    assertEmbeddedMaximum(tokenizerJson);
    const conformance = parseConformance(artifacts.conformance);
    this.#tokenizer = new tokenizerModule.Tokenizer(tokenizerJson, tokenizerConfig);
    this.#verifyConformance(conformance);
  }

  public countTokens(text: string): number {
    const count = this.#encode(text).length;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new PinnedMultilingualMiniLmTokenizerError(
        "pinned tokenizer returned an invalid token count",
      );
    }
    return count;
  }

  #encode(text: string): readonly number[] {
    return this.#tokenizer.encode(text, { add_special_tokens: true }).ids;
  }

  #verifyConformance(receipt: ConformanceReceipt): void {
    if (
      receipt.schemaVersion !== "meeting-knowledge.tokenizer-conformance.v1" ||
      receipt.modelRevision !== this.profile.embeddingModelRevision ||
      receipt.teiBuildRevision !== this.profile.servingRuntimeRevision ||
      receipt.maxInputTokens !== this.profile.maxInputTokens ||
      receipt.teiVersion !== "1.8.3" ||
      receipt.imageDigestSha256 !==
        "sha256:c466c97680cc9c2968108c4b1b44ca7729a091a44b61c840d9487f07d42e9099"
    ) {
      throw new PinnedMultilingualMiniLmTokenizerError(
        "TEI tokenizer conformance identity does not match the pinned profile",
      );
    }
    for (const vector of receipt.vectors) {
      if (!sameNumbers(this.#encode(vector.text), vector.ids)) {
        throw new PinnedMultilingualMiniLmTokenizerError(
          "local tokenizer does not match the pinned TEI conformance vectors",
        );
      }
    }
  }
}

function loadArtifacts(): PinnedMultilingualMiniLmArtifacts {
  return Object.freeze({
    conformance: readFileSync(new URL("conformance.v1.json", assetDirectory)),
    tokenizerConfig: readFileSync(new URL("tokenizer_config.json", assetDirectory)),
    tokenizerJson: readFileSync(new URL("tokenizer.json", assetDirectory)),
  });
}

function verifyDigest(bytes: Uint8Array, expected: string, label: string): void {
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== expected) {
    throw new PinnedMultilingualMiniLmTokenizerError(`${label} checksum mismatch`);
  }
}

function parseObject(
  bytes: Uint8Array,
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("not an object");
    }
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new PinnedMultilingualMiniLmTokenizerError(
      `${label} is not valid JSON: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}

function assertEmbeddedMaximum(tokenizerJson: Readonly<Record<string, unknown>>): void {
  const truncation = tokenizerJson.truncation;
  if (
    typeof truncation !== "object" ||
    truncation === null ||
    Array.isArray(truncation) ||
    (truncation as Readonly<Record<string, unknown>>).max_length !==
      PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.maxInputTokens
  ) {
    throw new PinnedMultilingualMiniLmTokenizerError(
      "tokenizer embedded maximum does not match the pinned profile",
    );
  }
}

function parseConformance(bytes: Uint8Array): ConformanceReceipt {
  const input = parseObject(bytes, "conformance.v1.json");
  if (!Array.isArray(input.vectors) || input.vectors.length < 1) {
    throw new PinnedMultilingualMiniLmTokenizerError(
      "tokenizer conformance vectors are missing",
    );
  }
  const vectors = input.vectors.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new PinnedMultilingualMiniLmTokenizerError("invalid conformance vector");
    }
    const vector = candidate as Readonly<Record<string, unknown>>;
    if (
      typeof vector.text !== "string" ||
      !Array.isArray(vector.ids) ||
      vector.ids.some((id) => !Number.isSafeInteger(id) || Number(id) < 0)
    ) {
      throw new PinnedMultilingualMiniLmTokenizerError("invalid conformance vector");
    }
    return Object.freeze({
      ids: Object.freeze(vector.ids.map(Number)),
      text: vector.text,
    });
  });
  return Object.freeze({
    imageDigestSha256: String(input.imageDigestSha256),
    maxInputTokens: Number(input.maxInputTokens),
    modelRevision: String(input.modelRevision),
    schemaVersion: String(input.schemaVersion),
    teiBuildRevision: String(input.teiBuildRevision),
    teiVersion: String(input.teiVersion),
    vectors: Object.freeze(vectors),
  });
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
