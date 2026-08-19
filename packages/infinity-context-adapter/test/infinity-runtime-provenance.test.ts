import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { BuildContextInput } from "@infinity-context/sdk";
import { describe, expect, it } from "vitest";

import {
  INFINITY_CONTEXT_PRODUCTION_QUALIFICATION,
  INFINITY_CONTEXT_SDK_PROVENANCE,
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE,
  InfinityContextActivationError,
  assertInfinityContextPlanningCompatibility,
  assertInfinityContextActivation,
  assertInfinityContextSearchActivation,
  decodeInfinityContextCapabilityAttestation,
  decodeInfinityContextRuntimeActivation,
  infinityContextHistoricalIndexProfileId,
} from "../src/index.js";

const instanceDigest = `sha256:${"a".repeat(64)}` as const;
const profileAttestation = Object.freeze({
  embeddingProfile: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileId,
  embeddingProfileDigestSha256: instanceDigest,
  schemaVersion: 1 as const,
});
const baseActivation = {
  apiVersion: "v1",
  archiveSha256: INFINITY_CONTEXT_SDK_PROVENANCE.archiveSha256,
  embeddingProfileAttestation: null,
  environment: "test",
  immutablePackageIntegrity: null,
  indexingEnabled: true,
  packageSource: "reviewed_source_workspace",
  qualificationManifestSha256: null,
  schemaVersion: 1,
  sdkCommit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
  sdkTree: INFINITY_CONTEXT_SDK_PROVENANCE.tree,
  searchEnabled: true,
  serviceName: "disposable-infinity-context",
  servingProfile: "same_room_retrieval",
} as const;
const productionActivation = {
  ...baseActivation,
  embeddingProfileAttestation: profileAttestation,
  environment: "production" as const,
  immutablePackageIntegrity: INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity,
  packageSource: "immutable_package" as const,
  qualificationManifestSha256:
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedB77SemanticTransportManifestSha256,
} as const;
const exactCapabilities = {
  apiVersion: "v1",
  embeddingProfileDigestSha256: instanceDigest,
  embeddingProfileId: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileId,
  enabledAdapters: ["qdrant"],
  qdrant: null,
  serviceName: "disposable-infinity-context",
  serviceRevision: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
  supportsQdrant: true,
} as const;
const testProductionPolicy = {
  embeddingProfileDigestSha256: instanceDigest,
  embeddingProfileId: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileId,
  productionSemanticQualification: true,
  qualificationManifestSha256:
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedB77SemanticTransportManifestSha256,
  sdkCommit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
  serviceRevision: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
} as const;

function assertCompatibility(
  productionQualification = INFINITY_CONTEXT_PRODUCTION_QUALIFICATION,
  tokenizerProfile = PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE,
): void {
  assertInfinityContextPlanningCompatibility({
    productionQualification,
    tokenizerProfile,
  });
}

describe("Infinity Context official SDK provenance", () => {
  it("loads the exact official package through ESM, CJS, and advisory-search types", async () => {
    const esm = await import("@infinity-context/sdk");
    const cjs = createRequire(import.meta.url)("@infinity-context/sdk") as {
      readonly InfinityContextClient?: unknown;
    };
    const typedSearch: BuildContextInput = {
      projectAnchorPolicy: "advisory",
      query: "meeting decision",
    };
    expect(typeof esm.InfinityContextClient).toBe("function");
    expect(typeof cjs.InfinityContextClient).toBe("function");
    expect(typedSearch.projectAnchorPolicy).toBe("advisory");
  });

  it("binds checkout, package tree, archive, and immutable tarball to b77", () => {
    const root = fileURLToPath(
      new URL("../../../vendor/infinity-context/.upstream/", import.meta.url),
    );
    expect(execFileSync("git", ["-C", root, "rev-parse", "HEAD"],
      { encoding: "utf8" }).trim()).toBe(INFINITY_CONTEXT_SDK_PROVENANCE.commit);
    expect(execFileSync("git", ["-C", root, "rev-parse",
      `${INFINITY_CONTEXT_SDK_PROVENANCE.commit}:packages/infinity_context_ts_sdk`],
    { encoding: "utf8" }).trim()).toBe(INFINITY_CONTEXT_SDK_PROVENANCE.tree);
    const archive = execFileSync("git", ["-C", root, "archive", "--format=tar",
      INFINITY_CONTEXT_SDK_PROVENANCE.commit, "packages/infinity_context_ts_sdk"],
    { maxBuffer: 16 * 1_024 * 1_024 });
    expect(createHash("sha256").update(archive).digest("hex"))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.archiveSha256);
    const immutablePackage = readFileSync(new URL(
      `../../../${INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackagePath}`,
      import.meta.url,
    ));
    expect(createHash("sha256").update(immutablePackage).digest("hex"))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.packageTarballSha256);
    expect(`sha512-${createHash("sha512").update(immutablePackage).digest("base64")}`)
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity);
    expect(INFINITY_CONTEXT_SDK_PROVENANCE.commit)
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision);
  });
});

describe("Infinity Context planning compatibility", () => {
  it("retains the reviewed b77 dense service and tokenizer tuple", () => {
    expect(() => { assertCompatibility(); }).not.toThrow();
  });

  it.each([
    ["service profile id", {
      ...INFINITY_CONTEXT_PRODUCTION_QUALIFICATION,
      embeddingProfileId: "another-dense-profile",
    }],
    ["service profile digest", {
      ...INFINITY_CONTEXT_PRODUCTION_QUALIFICATION,
      embeddingProfileDigestSha256: `sha256:${"c".repeat(64)}`,
    }],
  ] as const)("fails closed on a wrong %s", (_label, productionQualification) => {
    expect(() => { assertCompatibility(productionQualification); })
      .toThrow(/service profile mismatch/u);
  });

  it.each([
    ["local profile id", {
      ...PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE,
      id: "sentence-transformers/another-model",
    }],
    ["tokenizer revision", {
      ...PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE,
      embeddingModelRevision: "f".repeat(40),
    }],
  ] as const)("fails closed on a wrong %s", (_label, tokenizerProfile) => {
    expect(() => { assertCompatibility(
      INFINITY_CONTEXT_PRODUCTION_QUALIFICATION,
      tokenizerProfile,
    ); }).toThrow(/tokenizer profile mismatch/u);
  });
});

describe("Infinity Context source-pinned activation", () => {
  it("changes durable index identity when the qualified instance digest changes", () => {
    const secondDigest = `sha256:${"b".repeat(64)}`;
    expect(infinityContextHistoricalIndexProfileId(instanceDigest)).not.toBe(
      infinityContextHistoricalIndexProfileId(secondDigest),
    );
    expect(() => infinityContextHistoricalIndexProfileId("operator-label"))
      .toThrow(RangeError);
  });

  it("requires the dense profile for every active production projection", () => {
    expect(() => decodeInfinityContextRuntimeActivation({
      ...productionActivation,
      embeddingProfileAttestation: null,
    })).toThrow(/source-pinned embedding profile/u);
    expect(() => decodeInfinityContextRuntimeActivation({
      ...productionActivation,
      embeddingProfileAttestation: {
        ...profileAttestation,
        embeddingProfile: "local-open-source-paraphrase-multilingual-minilm-l12-v2-hybrid-bm25.r73",
      },
    })).toThrow(/source-pinned embedding profile/u);
  });

  it("permits production indexing-only with source transport qualification", () => {
    const sourceDigest =
      INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileDigestSha256;
    const activation = decodeInfinityContextRuntimeActivation({
      ...productionActivation,
      embeddingProfileAttestation: {
        ...profileAttestation,
        embeddingProfileDigestSha256: sourceDigest,
      },
      searchEnabled: false,
    });
    expect(() => { assertInfinityContextActivation(activation, {
      ...exactCapabilities,
      embeddingProfileDigestSha256: sourceDigest,
    }, INFINITY_CONTEXT_PRODUCTION_QUALIFICATION); }).not.toThrow();
  });

  it("rejects production search with source transport-only qualification", () => {
    const activation = decodeInfinityContextRuntimeActivation({
      ...productionActivation,
      embeddingProfileAttestation: {
        ...profileAttestation,
        embeddingProfileDigestSha256:
          INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileDigestSha256,
      },
    });
    expect(
      INFINITY_CONTEXT_PRODUCTION_QUALIFICATION.productionSemanticQualification,
    ).toBe(false);
    expect(() => {
      assertInfinityContextSearchActivation(
        activation,
        INFINITY_CONTEXT_PRODUCTION_QUALIFICATION,
      );
    }).toThrow(/explicit semantic qualification/u);
  });

  it("permits production search with explicit semantic qualification", () => {
    const activation = decodeInfinityContextRuntimeActivation(productionActivation);
    expect(() => {
      assertInfinityContextSearchActivation(activation, testProductionPolicy);
    }).not.toThrow();
    expect(() => { assertInfinityContextSearchActivation(activation); })
      .toThrow(/retained b77 qualification/u);
  });

  it("requires the source-owned policy to qualify an exact instance digest", () => {
    const secondDigest = `sha256:${"b".repeat(64)}`;
    const activation = decodeInfinityContextRuntimeActivation({
      ...productionActivation,
      embeddingProfileAttestation: {
        ...profileAttestation,
        embeddingProfileDigestSha256: secondDigest,
      },
    });
    const secondPolicy = {
      ...testProductionPolicy,
      embeddingProfileDigestSha256: secondDigest,
    };
    expect(() => { assertInfinityContextActivation(activation, {
      ...exactCapabilities,
      embeddingProfileDigestSha256: secondDigest,
    }, secondPolicy); }).not.toThrow();
    expect(() => {
      assertInfinityContextActivation(activation, exactCapabilities, secondPolicy);
    })
      .toThrow(/capability attestation/u);
  });

  it.each([
    ["service", { serviceRevision: "f".repeat(40) }],
    ["profile", { embeddingProfileId: "another-profile" }],
    ["digest", { embeddingProfileDigestSha256: `sha256:${"c".repeat(64)}` }],
  ] as const)("fails closed on %s drift", (_label, drift) => {
    const activation = decodeInfinityContextRuntimeActivation(productionActivation);
    expect(() => { assertInfinityContextActivation(activation, {
      ...exactCapabilities,
      ...drift,
    }, testProductionPolicy); }).toThrow(/capability attestation/u);
  });

  it("rejects the removed r79 operator-authored qualification fields", () => {
    expect(() => decodeInfinityContextRuntimeActivation({
      ...productionActivation,
      embeddingProfileAttestation: {
        ...profileAttestation,
        productionSemanticQualification: true,
        qualificationManifestSha256: `sha256:${"d".repeat(64)}`,
      },
    })).toThrow(/unknown field/u);
  });

  it("decodes additive capability fields while preserving the source identity", () => {
    expect(decodeInfinityContextCapabilityAttestation({
      api_version: exactCapabilities.apiVersion,
      embedding_profile_digest_sha256: exactCapabilities.embeddingProfileDigestSha256,
      embedding_profile_id: exactCapabilities.embeddingProfileId,
      enabled_adapters: exactCapabilities.enabledAdapters,
      ignored_provider_field: true,
      service_name: exactCapabilities.serviceName,
      service_revision: exactCapabilities.serviceRevision,
      supports_qdrant: true,
    })).toEqual(exactCapabilities);
  });

  it("keeps immutable transport qualification and strict serving-profile decoding", () => {
    expect(() => decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      embeddingProfileAttestation: profileAttestation,
      environment: "production",
    })).toThrow(/immutable package integrity/u);
    expect(() => decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      indexingEnabled: false,
      searchEnabled: false,
      servingProfile: "unreviewed-profile",
    })).toThrow(/unsupported Infinity serving profile/u);
    expect(() => decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      searchEnabeld: false,
    })).toThrow(InfinityContextActivationError);
  });
});
