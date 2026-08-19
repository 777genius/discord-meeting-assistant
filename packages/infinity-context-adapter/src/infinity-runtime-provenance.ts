export const INFINITY_CONTEXT_SDK_PROVENANCE = Object.freeze({
  archiveSha256: "b95264ecd7b94943b718fa99d34aabff387beadcf9ce6cdf5cd72146cddd3091",
  commit: "9b5c0e38bf46cdabe32698c84e62e1711a8b0aee",
  developmentPackageLink: "vendor/infinity-context/.upstream/packages/infinity_context_ts_sdk",
  immutablePackageIntegrity: "sha512-muYj1Pzi7eonaOq+zBsFjoQzPh/veOjWh3z9yMzoywHYqAEDtZdg+YE7DYSl3fuKPjYgglOInbL7CWBOsx0Naw==",
  immutablePackagePath: "vendor/infinity-context/artifacts/infinity-context-sdk-0.1.0-9b5c0e38.tgz",
  packageLockSha256: "068b3129a4ccd449c50cdc6a72755dbae3d4a977c5a468565e2f3841529cac0e",
  packageManifestSha256: "020c37993fc2749dd55649b2649d35e79570c1b43757a67ee16618de15be6ccd",
  packageName: "@infinity-context/sdk",
  packageTarballIntegrity: "sha512-muYj1Pzi7eonaOq+zBsFjoQzPh/veOjWh3z9yMzoywHYqAEDtZdg+YE7DYSl3fuKPjYgglOInbL7CWBOsx0Naw==",
  packageTarballSha256: "8f8015583ba3ccb71b1654d11ad6af111881ceedde68dec52241edc431981dc0",
  packageVersion: "0.1.0",
  retainedLiveQualificationEvidenceSha256:
    "4f19e430a465294d020e6dc0eebde4a6320913744201fa60700cb75d148065fe",
  retainedLiveQualificationManifestSha256:
    "sha256:abe694b3e1cf0dcec9d5ff7c0d8b65f30ec5364ac11bb2526bd1c3a3b176c207",
  retainedLiveQualificationSourceLogSha256:
    "d69ad3870ea17c15a2c0fafa88e71aa9dfa87e0dfc81afa1ed3b3f0c93ed9c51",
  retainedScopedDocumentsManifestPath: "docs/operations/evidence/2026-08-19-infinity-scoped-documents-9b5c0e38/manifest.json",
  retainedScopedDocumentsManifestSha256: "sha256:42807626aa1867c8d9663fa4a8c9ad27cc08c0d2eb93adbcea8f138a3f230c43",
  retainedScopedDocumentsParityBaselineSha256: "sha256:d7e58a5d8d1ef010c413d2b76a35ac196ee6f5ba7033573fcab100fca040fa97",
  retainedScopedDocumentsPostgresEvidenceSha256:
    "sha256:4331f5ca203cdc6a2b2c654820675a51a355fffc4ad0f900e1f7c33c9e1850ba",
  retainedScopedDocumentsSdkAsgiEvidenceSha256:
    "sha256:63a31a0f2ea0a40b7802612838ea045998a59bda2646236e7a88190923e84487",
  retainedTransportQualification: Object.freeze({
    embeddingProfile: "deterministic-mock-non-production-v1",
    productionSemanticQualification: false,
    qualifiesDeletionDrain: true,
    qualifiesOfficialSdkTransport: true,
  }),
  sourcePinnedEmbeddingProfileId:
    "tei-sentence-transformers-paraphrase-multilingual-minilm-l12-v2-384d-dense.v1",
  sourcePinnedEmbeddingProfileDigestSha256:
    "sha256:b183b9d6350dfaf9f874cab9fef993d3ded5060a4a18d972c45ec97def5faf31",
  sourcePinnedServiceRevision:
    "9b5c0e38bf46cdabe32698c84e62e1711a8b0aee",
  repository: "https://github.com/777genius/infinity-context.git",
  tree: "74f071f748591a26f1721dfba1c9742f7a8fb9d1",
});

export interface InfinityContextEmbeddingProfileAttestationV1 {
  readonly embeddingProfile: string;
  /** Deployment-instance echo. It is not semantic compatibility authority. */
  readonly embeddingProfileDigestSha256: string;
  readonly schemaVersion: 1;
}

export interface InfinityContextRuntimeActivationV1 {
  readonly apiVersion: string;
  readonly archiveSha256: string;
  readonly environment: "development" | "production" | "test";
  readonly immutablePackageIntegrity: string | null;
  readonly indexingEnabled: boolean;
  readonly packageSource: "immutable_package" | "reviewed_source_workspace";
  readonly embeddingProfileAttestation: InfinityContextEmbeddingProfileAttestationV1 | null;
  readonly qualificationManifestSha256: string | null;
  readonly schemaVersion: 1;
  readonly sdkCommit: string;
  readonly sdkTree: string;
  readonly searchEnabled: boolean;
  readonly serviceName: string;
  readonly servingProfile: "shadow_sync" | "same_room_retrieval";
}

export interface InfinityContextCapabilityAttestationV1 {
  readonly apiVersion: string | null;
  readonly embeddingProfileDigestSha256: string | null;
  readonly embeddingProfileId: string | null;
  readonly enabledAdapters: readonly string[];
  readonly qdrant?: {
    readonly enabled: boolean;
    readonly healthy: boolean;
    readonly supportsSearch: boolean;
    readonly supportsUpsert: boolean;
  } | null;
  readonly serviceRevision: string | null;
  readonly serviceName: string | null;
  readonly supportsQdrant: boolean;
}

/** Source-owned qualification receipt. Operator activation cannot create this authority. */
export interface InfinityContextProductionQualificationPolicyV1 {
  readonly embeddingProfileDigestSha256: string;
  readonly embeddingProfileId: string;
  readonly productionSemanticQualification: boolean;
  readonly qualificationManifestSha256: string;
  readonly sdkCommit: string;
  readonly serviceRevision: string;
}

export class InfinityContextActivationError extends Error {
  public override readonly name = "InfinityContextActivationError";
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InfinityContextActivationError("Infinity activation must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InfinityContextActivationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new InfinityContextActivationError(`${field} must be a boolean`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return string(value, field);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Converts the provider capability response into the adapter-owned receipt
 * validated by composition. Additive provider fields remain inside this
 * adapter boundary and an older endpoint decodes to an incomplete receipt.
 */
export function decodeInfinityContextCapabilityAttestation(
  value: unknown,
): InfinityContextCapabilityAttestationV1 {
  const input = object(value);
  const enabledAdaptersValue = input.enabled_adapters;
  if (!isUnknownArray(enabledAdaptersValue)) {
    throw new InfinityContextActivationError("enabled_adapters must be an array of strings");
  }
  const enabledAdapters = enabledAdaptersValue.map((item) =>
    string(item, "enabled_adapters")
  );
  const adapters = typeof input.adapters === "object" && input.adapters !== null
    ? input.adapters as Readonly<Record<string, unknown>>
    : {};
  const qdrant = typeof adapters.qdrant === "object" && adapters.qdrant !== null
    ? adapters.qdrant as Readonly<Record<string, unknown>>
    : null;
  return Object.freeze({
    apiVersion: nullableString(input.api_version, "api_version"),
    embeddingProfileDigestSha256: nullableString(
      input.embedding_profile_digest_sha256,
      "embedding_profile_digest_sha256",
    ),
    embeddingProfileId: nullableString(input.embedding_profile_id, "embedding_profile_id"),
    enabledAdapters: Object.freeze([...enabledAdapters]),
    qdrant: qdrant === null
      ? null
      : Object.freeze({
        enabled: qdrant.enabled === true,
        healthy: qdrant.healthy === true,
        supportsSearch: qdrant.supports_search === true,
        supportsUpsert: qdrant.supports_upsert === true,
      }),
    serviceRevision: nullableString(input.service_revision, "service_revision"),
    serviceName: nullableString(input.service_name, "service_name"),
    supportsQdrant: input.supports_qdrant === true,
  });
}

function rejectUnknownActivationFields(input: Readonly<Record<string, unknown>>): void {
  const allowed = new Set([
    "apiVersion",
    "archiveSha256",
    "environment",
    "immutablePackageIntegrity",
    "indexingEnabled",
    "packageSource",
    "embeddingProfileAttestation",
    "qualificationManifestSha256",
    "schemaVersion",
    "sdkCommit",
    "sdkTree",
    "searchEnabled",
    "serviceName",
    "servingProfile",
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new InfinityContextActivationError(
      "Infinity activation contains an unknown configuration field",
    );
  }
}

function decodeEmbeddingProfileAttestation(
  value: unknown,
): InfinityContextEmbeddingProfileAttestationV1 | null {
  if (value === undefined || value === null) {
    return null;
  }
  const input = object(value);
  const allowed = new Set([
    "embeddingProfile",
    "embeddingProfileDigestSha256",
    "schemaVersion",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new InfinityContextActivationError(
      "embedding-profile attestation contains an unknown field",
    );
  }
  if (input.schemaVersion !== 1) {
    throw new InfinityContextActivationError(
      "unsupported embedding-profile attestation schema version",
    );
  }
  return Object.freeze({
    embeddingProfile: string(input.embeddingProfile, "embeddingProfile"),
    embeddingProfileDigestSha256: string(
      input.embeddingProfileDigestSha256,
      "embeddingProfileDigestSha256",
    ),
    schemaVersion: 1 as const,
  });
}

/** Runtime codec for the versioned, non-secret activation contract. */
export function decodeInfinityContextRuntimeActivation(
  value: unknown,
): InfinityContextRuntimeActivationV1 {
  const input = object(value);
  rejectUnknownActivationFields(input);
  if (input.schemaVersion !== 1) {
    throw new InfinityContextActivationError("unsupported Infinity activation schema version");
  }
  const environment = string(input.environment, "environment");
  const packageSource = string(input.packageSource, "packageSource");
  const servingProfile = string(input.servingProfile ?? "shadow_sync", "servingProfile");
  if (!new Set(["development", "production", "test"]).has(environment)) {
    throw new InfinityContextActivationError("unsupported Infinity activation environment");
  }
  if (!new Set(["immutable_package", "reviewed_source_workspace"]).has(packageSource)) {
    throw new InfinityContextActivationError("unsupported Infinity SDK package source");
  }
  if (!new Set(["shadow_sync", "same_room_retrieval"]).has(servingProfile)) {
    throw new InfinityContextActivationError("unsupported Infinity serving profile");
  }
  const immutablePackageIntegrity = input.immutablePackageIntegrity === null
    ? null
    : string(input.immutablePackageIntegrity, "immutablePackageIntegrity");
  const qualificationManifestSha256 = input.qualificationManifestSha256 === null
    ? null
    : string(input.qualificationManifestSha256, "qualificationManifestSha256");
  const activation = Object.freeze({
    apiVersion: string(input.apiVersion, "apiVersion"),
    archiveSha256: string(input.archiveSha256, "archiveSha256"),
    environment: environment as InfinityContextRuntimeActivationV1["environment"],
    immutablePackageIntegrity,
    indexingEnabled: boolean(input.indexingEnabled, "indexingEnabled"),
    packageSource: packageSource as InfinityContextRuntimeActivationV1["packageSource"],
    embeddingProfileAttestation:
      decodeEmbeddingProfileAttestation(
        input.embeddingProfileAttestation,
      ),
    qualificationManifestSha256,
    schemaVersion: 1 as const,
    sdkCommit: string(input.sdkCommit, "sdkCommit"),
    sdkTree: string(input.sdkTree, "sdkTree"),
    searchEnabled: boolean(input.searchEnabled, "searchEnabled"),
    serviceName: string(input.serviceName, "serviceName"),
    servingProfile: servingProfile as InfinityContextRuntimeActivationV1["servingProfile"],
  });
  assertInfinityContextActivation(activation);
  return activation;
}

export function assertInfinityContextActivation(
  activation: InfinityContextRuntimeActivationV1,
  capabilities?: InfinityContextCapabilityAttestationV1,
  productionPolicy?: InfinityContextProductionQualificationPolicyV1,
): void {
  if (
    activation.sdkCommit !== INFINITY_CONTEXT_SDK_PROVENANCE.commit ||
    activation.sdkTree !== INFINITY_CONTEXT_SDK_PROVENANCE.tree ||
    activation.archiveSha256 !== INFINITY_CONTEXT_SDK_PROVENANCE.archiveSha256
  ) {
    throw new InfinityContextActivationError("Infinity SDK provenance does not match the reviewed source");
  }
  if (searchProfileMismatch(activation)) {
    throw new InfinityContextActivationError(
      "Infinity search requires the same-room retrieval activation profile",
    );
  }
  assertPinnedProductionProfile(activation);
  if (
    activation.environment === "production" &&
    (
      activation.packageSource !== "immutable_package" ||
      activation.immutablePackageIntegrity !==
        INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity ||
      activation.qualificationManifestSha256 === null ||
      activation.qualificationManifestSha256 !==
        INFINITY_CONTEXT_SDK_PROVENANCE.retainedScopedDocumentsManifestSha256
    )
  ) {
    throw new InfinityContextActivationError(
      "production Infinity activation and deletion reconciliation require immutable package integrity and a retained live-service qualification",
    );
  }
  if (capabilities === undefined) {
    return;
  }
  assertProductionQualificationPolicy(activation, productionPolicy);
  assertInfinityContextCapabilities(activation, capabilities);
}

function assertProductionQualificationPolicy(
  activation: InfinityContextRuntimeActivationV1,
  policy: InfinityContextProductionQualificationPolicyV1 | undefined,
): void {
  if (
    activation.environment !== "production" ||
    (!activation.indexingEnabled && !activation.searchEnabled)
  ) {
    return;
  }
  const attestation = activation.embeddingProfileAttestation;
  if (
    policy === undefined ||
    attestation === null ||
    policy.sdkCommit !== INFINITY_CONTEXT_SDK_PROVENANCE.commit ||
    policy.serviceRevision !== INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision ||
    policy.embeddingProfileId !== INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileId ||
    policy.embeddingProfileId !== attestation.embeddingProfile ||
    policy.embeddingProfileDigestSha256 !== attestation.embeddingProfileDigestSha256 ||
    policy.qualificationManifestSha256 !== activation.qualificationManifestSha256
  ) {
    throw new InfinityContextActivationError("production Infinity indexing/search requires exact-head qualification evidence");
  }
  if (activation.indexingEnabled && !(policy?.productionSemanticQualification ?? false)) {
    throw new InfinityContextActivationError("production Infinity indexing requires exact-head ingest, process, and dense-profile qualification");
  }
}

/**
 * Search is independently switchable, but production compatibility comes from
 * the source-pinned service/profile pair and the locally verified tokenizer.
 * The deployment-specific profile digest is retained only as an endpoint echo.
 */
export function assertInfinityContextSearchActivation(
  activation: InfinityContextRuntimeActivationV1,
  productionPolicy?: InfinityContextProductionQualificationPolicyV1,
): void {
  if (!activation.searchEnabled || activation.environment !== "production") {
    return;
  }
  const attestation = activation.embeddingProfileAttestation;
  if (attestation === null) {
    throw new InfinityContextActivationError(
      "production Infinity search requires an embedding-profile attestation",
    );
  }
  if (
    attestation.embeddingProfile !==
      INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileId ||
    !/^sha256:[a-f0-9]{64}$/u.test(attestation.embeddingProfileDigestSha256)
  ) {
    throw new InfinityContextActivationError(
      "production embedding-profile attestation does not match the source-pinned profile",
    );
  }
  assertProductionQualificationPolicy(activation, productionPolicy);
  if (!(productionPolicy?.productionSemanticQualification ?? false)) {
    throw new InfinityContextActivationError("production search requires explicit semantic qualification");
  }
}

function assertPinnedProductionProfile(
  activation: InfinityContextRuntimeActivationV1,
): void {
  if (
    activation.environment !== "production" ||
    (!activation.indexingEnabled && !activation.searchEnabled)
  ) {
    return;
  }
  const attestation = activation.embeddingProfileAttestation;
  if (
    attestation === null ||
    attestation.embeddingProfile !==
      INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileId ||
    !/^sha256:[a-f0-9]{64}$/u.test(attestation.embeddingProfileDigestSha256)
  ) {
    throw new InfinityContextActivationError(
      "production Infinity indexing/search requires the source-pinned embedding profile",
    );
  }
}

function searchProfileMismatch(activation: InfinityContextRuntimeActivationV1): boolean {
  return activation.searchEnabled && activation.servingProfile !== "same_room_retrieval";
}

function assertInfinityContextCapabilities(
  activation: InfinityContextRuntimeActivationV1,
  capabilities: InfinityContextCapabilityAttestationV1,
): void {
  const active = activation.indexingEnabled || activation.searchEnabled;
  const productionActiveAttestation = activation.environment === "production" && active
      ? activation.embeddingProfileAttestation
      : null;
  if (
    capabilities.apiVersion !== activation.apiVersion ||
    capabilities.serviceName !== activation.serviceName ||
    (active && (
      !capabilities.supportsQdrant ||
      !capabilities.enabledAdapters.includes("qdrant")
    )) ||
    (productionActiveAttestation !== null && (
      capabilities.embeddingProfileId !== productionActiveAttestation.embeddingProfile ||
      capabilities.embeddingProfileDigestSha256 !==
        productionActiveAttestation.embeddingProfileDigestSha256 ||
      capabilities.serviceRevision !==
        INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision
    ))
  ) {
    throw new InfinityContextActivationError(
      "Infinity endpoint capability attestation does not satisfy this release",
    );
  }
}
