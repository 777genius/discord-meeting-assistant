import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  INFINITY_CONTEXT_SDK_PROVENANCE,
  InfinityContextActivationError,
  assertInfinityContextActivation,
  assertInfinityContextSearchActivation,
  decodeInfinityContextCapabilityAttestation,
  decodeInfinityContextRuntimeActivation,
} from "../src/index.js";

const baseActivation = {
  apiVersion: "v1",
  archiveSha256: INFINITY_CONTEXT_SDK_PROVENANCE.archiveSha256,
  environment: "test",
  immutablePackageIntegrity: null,
  indexingEnabled: true,
  packageSource: "reviewed_source_workspace",
  productionEmbeddingProfileAttestation: null,
  qualificationManifestSha256: null,
  schemaVersion: 1,
  sdkCommit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
  sdkTree: INFINITY_CONTEXT_SDK_PROVENANCE.tree,
  searchEnabled: true,
  serviceName: "disposable-infinity-context",
  servingProfile: "same_room_retrieval",
} as const;

const retainedProductionAttestation = {
  embeddingProfile:
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedProductionSemanticEmbeddingProfileId,
  embeddingProfileDigestSha256:
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedProductionSemanticEmbeddingProfileDigestSha256,
  productionSemanticQualification: true,
  qualificationManifestSha256:
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedProductionSemanticQualificationManifestSha256,
  schemaVersion: 1,
} as const;

const productionSearchActivation = {
  ...baseActivation,
  environment: "production" as const,
  immutablePackageIntegrity: INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity,
  packageSource: "immutable_package" as const,
  productionEmbeddingProfileAttestation: retainedProductionAttestation,
  qualificationManifestSha256:
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256,
} as const;

describe("Infinity Context activation provenance", () => {
  const testCapabilities = {
    apiVersion: "v1",
    embeddingProfileDigestSha256: null,
    embeddingProfileId: null,
    enabledAdapters: ["qdrant"],
    qdrant: null,
    serviceName: "disposable-infinity-context",
    serviceRevision: null,
    supportsQdrant: true,
  } as const;

  it("loads the exact official package through ESM, CJS, and TypeScript consumers", async () => {
    const esm = await import("@infinity-context/sdk");
    const cjs = createRequire(import.meta.url)("@infinity-context/sdk") as {
      readonly InfinityContextClient?: unknown;
    };

    expect(typeof esm.InfinityContextClient).toBe("function");
    expect(typeof cjs.InfinityContextClient).toBe("function");
  });

  it("binds the reviewable source workspace to the reviewed commit, tree, and archive", () => {
    const root = fileURLToPath(
      new URL("../../../vendor/infinity-context/.upstream/", import.meta.url),
    );
    expect(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.commit);
    expect(execFileSync("git", [
      "-C",
      root,
      "rev-parse",
      `${INFINITY_CONTEXT_SDK_PROVENANCE.commit}:packages/infinity_context_ts_sdk`,
    ], { encoding: "utf8" }).trim()).toBe(INFINITY_CONTEXT_SDK_PROVENANCE.tree);
    const archive = execFileSync("git", [
      "-C",
      root,
      "archive",
      "--format=tar",
      INFINITY_CONTEXT_SDK_PROVENANCE.commit,
      "packages/infinity_context_ts_sdk",
    ], { maxBuffer: 16 * 1_024 * 1_024 });
    expect(createHash("sha256").update(archive).digest("hex"))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.archiveSha256);
    const packageRoot = new URL(
      "../../../vendor/infinity-context/.upstream/packages/infinity_context_ts_sdk/",
      import.meta.url,
    );
    expect(createHash("sha256").update(readFileSync(new URL("package.json", packageRoot)))
      .digest("hex")).toBe(INFINITY_CONTEXT_SDK_PROVENANCE.packageManifestSha256);
    expect(createHash("sha256").update(readFileSync(new URL("package-lock.json", packageRoot)))
      .digest("hex")).toBe(INFINITY_CONTEXT_SDK_PROVENANCE.packageLockSha256);
    expect(INFINITY_CONTEXT_SDK_PROVENANCE.packageTarballSha256)
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(INFINITY_CONTEXT_SDK_PROVENANCE.packageTarballIntegrity)
      .toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/u);
    expect(INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256)
      .toBe("sha256:abe694b3e1cf0dcec9d5ff7c0d8b65f30ec5364ac11bb2526bd1c3a3b176c207");
    expect(
      INFINITY_CONTEXT_SDK_PROVENANCE
        .retainedProductionSemanticQualificationManifestSha256,
    ).toBe(
      "sha256:2b0ea368ea4d1feef4616fb185ce1267b9f8735e44d03634d81f03c8d58af965",
    );

    const immutablePackage = readFileSync(new URL(
      `../../../${INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackagePath}`,
      import.meta.url,
    ));
    expect(createHash("sha256").update(immutablePackage).digest("hex"))
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.packageTarballSha256);
    expect(`sha512-${createHash("sha512").update(immutablePackage).digest("base64")}`)
      .toBe(INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity);

    const evidenceRoot = new URL(
      "../../../docs/operations/evidence/2026-08-14-infinity-r26/",
      import.meta.url,
    );
    expect(`sha256:${createHash("sha256").update(readFileSync(
      new URL("qualification-manifest.v1.json", evidenceRoot),
    )).digest("hex")}`).toBe(
      INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256,
    );
    expect(createHash("sha256").update(readFileSync(
      new URL("real-service-e2e.txt", evidenceRoot),
    )).digest("hex")).toBe(
      INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationEvidenceSha256,
    );
    const productionEvidenceRoot = new URL(
      "../../../docs/operations/evidence/2026-08-15-infinity-r79/",
      import.meta.url,
    );
    const productionManifest = JSON.parse(readFileSync(
      new URL("qualification-manifest.v1.json", productionEvidenceRoot),
      "utf8",
    )) as {
      readonly embeddingProfile: {
        readonly digestSha256: string;
        readonly id: string;
      };
    };
    expect(`sha256:${createHash("sha256").update(readFileSync(
      new URL("qualification-manifest.v1.json", productionEvidenceRoot),
    )).digest("hex")}`).toBe(
      INFINITY_CONTEXT_SDK_PROVENANCE
        .retainedProductionSemanticQualificationManifestSha256,
    );
    expect(productionManifest.embeddingProfile.id).toBe(
      INFINITY_CONTEXT_SDK_PROVENANCE.retainedProductionSemanticEmbeddingProfileId,
    );
    expect(productionManifest.embeddingProfile.digestSha256).toBe(
      INFINITY_CONTEXT_SDK_PROVENANCE
        .retainedProductionSemanticEmbeddingProfileDigestSha256,
    );
    expect(readFileSync(new URL("SHA256SUMS", productionEvidenceRoot), "utf8"))
      .toBe([
        "2b0ea368ea4d1feef4616fb185ce1267b9f8735e44d03634d81f03c8d58af965  qualification-manifest.v1.json",
        "64b8266a653a96fcc156591f57f704253c4d6e65dd62fcda7ac56c0860fcd3ae  runtime-provenance.txt",
        "",
      ].join("\n"));

    const adapterManifest = JSON.parse(readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { readonly dependencies?: Readonly<Record<string, string>> };
    expect(adapterManifest.dependencies?.[INFINITY_CONTEXT_SDK_PROVENANCE.packageName])
      .toBe("catalog:");
    expect(readFileSync(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8"))
      .toContain(
        '"@infinity-context/sdk": "file:vendor/infinity-context/artifacts/infinity-context-sdk-0.1.0-897efd21.tgz"',
      );
    const preparationSource = readFileSync(
      new URL("../../../vendor/infinity-context/prepare-official-sdk.mjs", import.meta.url),
      "utf8",
    );
    expect(preparationSource).toContain(INFINITY_CONTEXT_SDK_PROVENANCE.repository);
    expect(preparationSource).toContain(INFINITY_CONTEXT_SDK_PROVENANCE.packageTarballSha256);
    expect(preparationSource).toContain(INFINITY_CONTEXT_SDK_PROVENANCE.packageTarballIntegrity);
  });

  it("accepts official healthy Qdrant capabilities without inventing a lexical adapter", () => {
    const activation = decodeInfinityContextRuntimeActivation(baseActivation);
    expect(() => {
      assertInfinityContextActivation(activation, {
        ...testCapabilities,
      });
    }).not.toThrow();
    expect(() => {
      assertInfinityContextActivation(activation, {
        apiVersion: "v1",
        embeddingProfileDigestSha256: null,
        embeddingProfileId: null,
        enabledAdapters: ["keyword"],
        serviceRevision: null,
        serviceName: "disposable-infinity-context",
        supportsQdrant: false,
      });
    }).toThrow(InfinityContextActivationError);
  });

  it("accepts production transport/deletion only with the immutable package and retained r26 manifest", () => {
    expect(() => decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      environment: "production",
    })).toThrow(/immutable package integrity/u);

    expect(() => decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      environment: "production",
      immutablePackageIntegrity: "sha512:unapproved",
      packageSource: "immutable_package",
      qualificationManifestSha256: `sha256:${"a".repeat(64)}`,
    })).toThrow(/immutable package integrity/u);

    expect(() => decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      environment: "production",
      immutablePackageIntegrity: INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity,
      packageSource: "immutable_package",
      qualificationManifestSha256:
        INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256,
    })).not.toThrow();

    expect(() => decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      environment: "production",
      immutablePackageIntegrity: INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity,
      packageSource: "immutable_package",
      qualificationManifestSha256: `sha256:${"a".repeat(64)}`,
    })).toThrow(/retained live-service qualification/u);
  });
});

describe("Infinity Context production search provenance", () => {
  const exactProductionCapabilities = {
    apiVersion: "v1",
    embeddingProfileDigestSha256:
      retainedProductionAttestation.embeddingProfileDigestSha256,
    embeddingProfileId: retainedProductionAttestation.embeddingProfile,
    enabledAdapters: ["qdrant"],
    qdrant: null,
    serviceName: "disposable-infinity-context",
    serviceRevision:
      INFINITY_CONTEXT_SDK_PROVENANCE.retainedProductionSemanticServiceRevision,
    supportsQdrant: true,
  } as const;

  it("keeps production search closed for missing, false, and unretained embedding attestations", () => {
    const production = {
      ...baseActivation,
      environment: "production" as const,
      immutablePackageIntegrity: INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity,
      packageSource: "immutable_package" as const,
      qualificationManifestSha256:
        INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256,
    };
    const missing = decodeInfinityContextRuntimeActivation(production);
    expect(() => { assertInfinityContextSearchActivation(missing); })
      .toThrow(/embedding-profile attestation/u);

    const explicitlyFalse = decodeInfinityContextRuntimeActivation({
      ...production,
      productionEmbeddingProfileAttestation: {
        embeddingProfile: "deterministic-mock-non-production-v1",
        embeddingProfileDigestSha256: `sha256:${"1".repeat(64)}`,
        productionSemanticQualification: false,
        qualificationManifestSha256:
          INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256,
        schemaVersion: 1,
      },
    });
    expect(() => { assertInfinityContextSearchActivation(explicitlyFalse); })
      .toThrow(/productionSemanticQualification=true/u);

    const mockClaimingTrue = decodeInfinityContextRuntimeActivation({
      ...production,
      productionEmbeddingProfileAttestation: {
        embeddingProfile: "deterministic-mock-non-production-v1",
        embeddingProfileDigestSha256: `sha256:${"2".repeat(64)}`,
        productionSemanticQualification: true,
        qualificationManifestSha256:
          INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256,
        schemaVersion: 1,
      },
    });
    expect(() => { assertInfinityContextSearchActivation(mockClaimingTrue); })
      .toThrow(/non-production qualification manifest/u);
  });

  it("rejects a profile-name mismatch against the retained r79 evidence", () => {
    const activation = decodeInfinityContextRuntimeActivation({
      ...productionSearchActivation,
      productionEmbeddingProfileAttestation: {
        ...retainedProductionAttestation,
        embeddingProfile: "another-valid-production-profile",
      },
    });

    expect(() => { assertInfinityContextSearchActivation(activation); })
      .toThrow(/retained qualification/u);
  });

  it("rejects a profile-digest mismatch against the retained r79 evidence", () => {
    const activation = decodeInfinityContextRuntimeActivation({
      ...productionSearchActivation,
      productionEmbeddingProfileAttestation: {
        ...retainedProductionAttestation,
        embeddingProfileDigestSha256: `sha256:${"a".repeat(64)}`,
      },
    });

    expect(() => { assertInfinityContextSearchActivation(activation); })
      .toThrow(/retained qualification/u);
  });

  it("rejects a manifest mismatch against the retained r79 evidence", () => {
    const activation = decodeInfinityContextRuntimeActivation({
      ...productionSearchActivation,
      productionEmbeddingProfileAttestation: {
        ...retainedProductionAttestation,
        qualificationManifestSha256: `sha256:${"a".repeat(64)}`,
      },
    });

    expect(() => { assertInfinityContextSearchActivation(activation); })
      .toThrow(/retained qualification/u);
  });

  it("activates production search only with the retained r79 semantic attestation", () => {
    const activation = decodeInfinityContextRuntimeActivation(productionSearchActivation);

    expect(() => { assertInfinityContextSearchActivation(activation); }).not.toThrow();
  });

  it("fails closed when the endpoint omits its runtime qualification receipt", () => {
    const activation = decodeInfinityContextRuntimeActivation(productionSearchActivation);

    expect(() => {
      assertInfinityContextActivation(activation, {
        ...exactProductionCapabilities,
        embeddingProfileDigestSha256: null,
        embeddingProfileId: null,
        serviceRevision: null,
      });
    }).toThrow(/capability attestation/u);
  });

  it.each([
    ["profile", { embeddingProfileId: "another-production-profile" }],
    ["digest", { embeddingProfileDigestSha256: `sha256:${"d".repeat(64)}` }],
    ["revision", { serviceRevision: "f".repeat(40) }],
  ] as const)("rejects endpoint %s drift from the retained qualification", (_field, drift) => {
    const activation = decodeInfinityContextRuntimeActivation(productionSearchActivation);

    expect(() => {
      assertInfinityContextActivation(activation, {
        ...exactProductionCapabilities,
        ...drift,
      });
    }).toThrow(/capability attestation/u);
  });

  it("binds production search to the endpoint's exact qualification receipt", () => {
    const activation = decodeInfinityContextRuntimeActivation(productionSearchActivation);

    expect(() => {
      assertInfinityContextActivation(activation, exactProductionCapabilities);
    }).not.toThrow();
  });

  it("decodes additive provider fields into an adapter-owned receipt", () => {
    expect(decodeInfinityContextCapabilityAttestation({
      api_version: exactProductionCapabilities.apiVersion,
      embedding_profile_digest_sha256:
        exactProductionCapabilities.embeddingProfileDigestSha256,
      embedding_profile_id: exactProductionCapabilities.embeddingProfileId,
      enabled_adapters: exactProductionCapabilities.enabledAdapters,
      ignored_provider_field: "kept outside composition",
      service_name: exactProductionCapabilities.serviceName,
      service_revision: exactProductionCapabilities.serviceRevision,
      supports_qdrant: true,
    })).toEqual(exactProductionCapabilities);
  });

  it("does not permit search under a shadow-sync activation profile", () => {
    expect(() => decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      servingProfile: "shadow_sync",
    })).toThrow(InfinityContextActivationError);
  });

  it("rejects unknown serving profiles even when serving flags are disabled", () => {
    expect(() => decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      indexingEnabled: false,
      searchEnabled: false,
      servingProfile: "unreviewed-profile",
    })).toThrow(/unsupported Infinity serving profile/u);
  });

  it("rejects unknown activation fields instead of silently accepting a typo", () => {
    expect(() => decodeInfinityContextRuntimeActivation({
      ...baseActivation,
      searchEnabeld: false,
    })).toThrow(/unknown configuration field/u);
  });
});
