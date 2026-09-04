import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { BuildContextInput } from "@infinity-context/sdk";
import { describe, expect, it } from "vitest";

import {
  INFINITY_CONTEXT_PRODUCTION_QUALIFICATION,
  INFINITY_CONTEXT_RETRIEVAL_V2_SDK_PROVENANCE,
  INFINITY_CONTEXT_SDK_PROVENANCE,
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE,
  InfinityContextActivationError,
  assertInfinityContextPlanningCompatibility,
  assertInfinityContextActivation,
  assertInfinityContextSearchActivation,
  assertInfinityContextTransportCapabilities,
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
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedExactHeadQualificationManifestSha256,
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
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedExactHeadQualificationManifestSha256,
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
  const repositoryRoot = new URL("../../../", import.meta.url);
  const retainedDigest = (path: string): string =>
    "sha256:" + createHash("sha256").update(readFileSync(new URL(path, repositoryRoot))).digest("hex");

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

  it("verifies the retained release evidence offline", () => {
    const output = execFileSync(process.execPath, [
      new URL("../../../vendor/infinity-context/prepare-official-sdk.mjs", import.meta.url).pathname,
      "--verify-only",
    ], { encoding: "utf8" });
    expect(output).toContain("SDK 0.2.4 immutable package verified offline");
  });

  it("binds the single default Retrieval SDK at 0.2.4", () => {
    expect(INFINITY_CONTEXT_SDK_PROVENANCE).toMatchObject({
      archiveSha256: "9b6bd230ae59e73af02039a1fbef4d7e06fc112419adf265229ea05c4b8ae366",
      commit: "40704f193008f98c52ede93b68a44349907dd2cd",
      tree: "836cca4d0981f4df73922c5b982975fc9db25ec7",
      releaseTag: "sdk-v0.2.4",
      releaseTagObject: "60933db64cdc5796b624d97f463b498b28ae3fca",
      packageLockSha256: "c27ee764041ac4e93fd3d19bbf4363590e3dc1641abe4d89c7cbb0cbfc8222da",
    });
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

    const retrievalV2Package = readFileSync(new URL(
      `../../../${INFINITY_CONTEXT_RETRIEVAL_V2_SDK_PROVENANCE.immutablePackagePath}`,
      import.meta.url,
    ));
    expect(createHash("sha256").update(retrievalV2Package).digest("hex"))
      .toBe(INFINITY_CONTEXT_RETRIEVAL_V2_SDK_PROVENANCE.packageTarballSha256);
    expect(`sha512-${createHash("sha512").update(retrievalV2Package).digest("base64")}`)
      .toBe(INFINITY_CONTEXT_RETRIEVAL_V2_SDK_PROVENANCE.immutablePackageIntegrity);
    expect(INFINITY_CONTEXT_RETRIEVAL_V2_SDK_PROVENANCE).toMatchObject({
      packageName: "@infinity-context/sdk",
      packageVersion: "0.2.4",
      reviewedSourceCommit: "40704f193008f98c52ede93b68a44349907dd2cd",
    });
    const packedManifest = execFileSync("tar", [
      "-xOf",
      new URL(
        `../../../${INFINITY_CONTEXT_RETRIEVAL_V2_SDK_PROVENANCE.immutablePackagePath}`,
        import.meta.url,
      ).pathname,
      "package/package.json",
    ]);
    expect(createHash("sha256").update(packedManifest).digest("hex"))
      .toBe(INFINITY_CONTEXT_RETRIEVAL_V2_SDK_PROVENANCE.packageManifestSha256);
    expect(JSON.parse(packedManifest.toString("utf8"))).toMatchObject({
      name: "@infinity-context/sdk",
      version: "0.2.4",
    });
    expect(retainedDigest(INFINITY_CONTEXT_SDK_PROVENANCE.releaseManifestPath))
      .toBe(`sha256:${INFINITY_CONTEXT_SDK_PROVENANCE.releaseManifestSha256}`);
    expect(retainedDigest(INFINITY_CONTEXT_SDK_PROVENANCE.releaseVerificationReceiptPath))
      .toBe(`sha256:${INFINITY_CONTEXT_SDK_PROVENANCE.releaseVerificationReceiptSha256}`);
  });

  it("binds the composite exact-head and retained predecessor qualification evidence", () => {
    expect(retainedDigest(INFINITY_CONTEXT_SDK_PROVENANCE.retainedPredecessorScopedDocumentsManifestPath))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.retainedPredecessorScopedDocumentsManifestSha256);
    expect(retainedDigest(INFINITY_CONTEXT_SDK_PROVENANCE.retainedActiveOnlyQualificationPath))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.retainedActiveOnlyQualificationSha256);
    expect(retainedDigest(INFINITY_CONTEXT_SDK_PROVENANCE.retainedExactHeadQualificationManifestPath))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.retainedExactHeadQualificationManifestSha256);
    const exactHeadManifest = JSON.parse(readFileSync(new URL(
      INFINITY_CONTEXT_SDK_PROVENANCE.retainedExactHeadQualificationManifestPath,
      repositoryRoot,
    ), "utf8")) as unknown;
    expect(exactHeadManifest).toMatchObject({
      exact_head_gates: {
        bidirectional_api_parity: { failed: 0, passed: 93 },
        sdk_tests: { failed: 0, passed: 86 },
        server_tests: { failed: 0, passed: 116 },
      },
      head_revision: INFINITY_CONTEXT_SDK_PROVENANCE.retainedExactHeadRevision,
      production_capabilities: {
        deletion_reconciliation: true,
        indexing: false,
        semantic_search: false,
      },
      sdk: {
        source_bundle_sha256:
          INFINITY_CONTEXT_SDK_PROVENANCE.retainedExactHeadSourceBundleSha256,
        tarball_sha256:
          INFINITY_CONTEXT_SDK_PROVENANCE.retainedExactHeadSdkTarballSha256,
        tree: INFINITY_CONTEXT_SDK_PROVENANCE.retainedExactHeadSdkTree,
      },
    });
    const evidenceRoot = new URL(
      "../../../docs/operations/evidence/2026-08-19-infinity-scoped-documents-9b5c0e38/",
      import.meta.url,
    );
    const digest = (name: string): string =>
      `sha256:${createHash("sha256").update(readFileSync(new URL(name, evidenceRoot))).digest("hex")}`;
    expect(digest("manifest.json"))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.retainedPredecessorScopedDocumentsManifestSha256);
    expect(digest("postgres-live-evidence.json"))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.retainedScopedDocumentsPostgresEvidenceSha256);
    expect(digest("sdk-asgi-postgres-evidence.json"))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.retainedScopedDocumentsSdkAsgiEvidenceSha256);
    expect(digest("parity-baseline.sha256"))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.retainedScopedDocumentsParityBaselineSha256);
  });
});

describe("Infinity Context planning compatibility", () => {
  it("retains the reviewed scoped-list dense service and tokenizer tuple", () => {
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

  it("rejects production indexing backed only by scoped-list qualification", () => {
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
    }, INFINITY_CONTEXT_PRODUCTION_QUALIFICATION); }).toThrow(
      /exact-head ingest, process, and dense-profile qualification/u,
    );
  });

  it("rejects production search with source transport-only qualification", () => {
    const activation = decodeInfinityContextRuntimeActivation({
      ...productionActivation,
      indexingEnabled: false,
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
    const activation = decodeInfinityContextRuntimeActivation({
      ...productionActivation,
      indexingEnabled: false,
    });
    expect(() => {
      assertInfinityContextSearchActivation(activation, testProductionPolicy);
    }).not.toThrow();
    expect(() => { assertInfinityContextSearchActivation(activation); })
      .toThrow(/exact-head qualification evidence/u);
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
    }, testProductionPolicy); }).toThrow(/attestation/u);
  });

  it("binds deletion-only transport to the exact reviewed service", () => {
    const deletionOnly = decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      indexingEnabled: false,
      searchEnabled: false,
    });
    expect(() => {
      assertInfinityContextTransportCapabilities(deletionOnly, exactCapabilities);
    }).not.toThrow();
    for (const capabilities of [
      { ...exactCapabilities, serviceRevision: null },
      { ...exactCapabilities, serviceRevision: "f".repeat(40) },
      { ...exactCapabilities, serviceName: "other-infinity-context" },
      { ...exactCapabilities, apiVersion: "v2" },
    ]) {
      expect(() => {
        assertInfinityContextTransportCapabilities(deletionOnly, capabilities);
      }).toThrow(/transport attestation/u);
    }
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
