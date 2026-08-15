export const INFINITY_CONTEXT_SDK_PROVENANCE = Object.freeze({
  archiveSha256: "1aad93c1c9deea91f0c0ec750b99e91d1092e9d208751e11c6231badd5fbd9d2",
  commit: "897efd211151e9a81a7466fdd6be5cb067ddb8eb",
  developmentPackageLink:
    "vendor/infinity-context/.upstream/packages/infinity_context_ts_sdk",
  immutablePackageIntegrity:
    "sha512-ohD89uSSlW7zT/BqaEufIBZ7EAVcq1LYAWn/rRel8EOyMAnq5DXSh3PqjYXAYJdE9WsHgLWx7Tysy9jAY7XaHw==",
  immutablePackagePath:
    "vendor/infinity-context/artifacts/infinity-context-sdk-0.1.0-897efd21.tgz",
  packageLockSha256: "068b3129a4ccd449c50cdc6a72755dbae3d4a977c5a468565e2f3841529cac0e",
  packageManifestSha256: "a646c42b1f8948b0f1b81d3d988f79b4f2c64616a1c5e2711648b2686ce1e135",
  packageName: "@infinity-context/sdk",
  packageTarballIntegrity:
    "sha512-ohD89uSSlW7zT/BqaEufIBZ7EAVcq1LYAWn/rRel8EOyMAnq5DXSh3PqjYXAYJdE9WsHgLWx7Tysy9jAY7XaHw==",
  packageTarballSha256: "93ea6c98dec53c886250f3a3a06cb3825da27d1fc5ff73b85ab9633273e6bc1a",
  packageVersion: "0.1.0",
  retainedLiveQualificationEvidenceSha256:
    "4f19e430a465294d020e6dc0eebde4a6320913744201fa60700cb75d148065fe",
  retainedLiveQualificationManifestSha256:
    "sha256:abe694b3e1cf0dcec9d5ff7c0d8b65f30ec5364ac11bb2526bd1c3a3b176c207",
  retainedLiveQualificationSourceLogSha256:
    "d69ad3870ea17c15a2c0fafa88e71aa9dfa87e0dfc81afa1ed3b3f0c93ed9c51",
  retainedTransportQualification: Object.freeze({
    embeddingProfile: "deterministic-mock-non-production-v1",
    productionSemanticQualification: false,
    qualifiesDeletionDrain: true,
    qualifiesOfficialSdkTransport: true,
  }),
  /** Populated only by a future reviewed release with retained production evidence. */
  retainedProductionSemanticQualificationManifestSha256: null as string | null,
  repository: "https://github.com/777genius/infinity-context.git",
  tree: "67a744b1accc0d4628c19f28849660bc917b8b62",
});

export interface InfinityContextProductionEmbeddingProfileAttestationV1 {
  readonly embeddingProfile: string;
  readonly embeddingProfileDigestSha256: string;
  readonly productionSemanticQualification: boolean;
  readonly qualificationManifestSha256: string;
  readonly schemaVersion: 1;
}

export interface InfinityContextRuntimeActivationV1 {
  readonly apiVersion: string;
  readonly archiveSha256: string;
  readonly environment: "development" | "production" | "test";
  readonly immutablePackageIntegrity: string | null;
  readonly indexingEnabled: boolean;
  readonly packageSource: "immutable_package" | "reviewed_source_workspace";
  readonly productionEmbeddingProfileAttestation:
    InfinityContextProductionEmbeddingProfileAttestationV1 | null;
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
  readonly enabledAdapters: readonly string[];
  readonly serviceName: string | null;
  readonly supportsQdrant: boolean;
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

function rejectUnknownActivationFields(input: Readonly<Record<string, unknown>>): void {
  const allowed = new Set([
    "apiVersion",
    "archiveSha256",
    "environment",
    "immutablePackageIntegrity",
    "indexingEnabled",
    "packageSource",
    "productionEmbeddingProfileAttestation",
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

function decodeProductionEmbeddingProfileAttestation(
  value: unknown,
): InfinityContextProductionEmbeddingProfileAttestationV1 | null {
  if (value === undefined || value === null) {
    return null;
  }
  const input = object(value);
  const allowed = new Set([
    "embeddingProfile",
    "embeddingProfileDigestSha256",
    "productionSemanticQualification",
    "qualificationManifestSha256",
    "schemaVersion",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new InfinityContextActivationError(
      "production embedding-profile attestation contains an unknown field",
    );
  }
  if (input.schemaVersion !== 1) {
    throw new InfinityContextActivationError(
      "unsupported production embedding-profile attestation schema version",
    );
  }
  return Object.freeze({
    embeddingProfile: string(input.embeddingProfile, "embeddingProfile"),
    embeddingProfileDigestSha256: string(
      input.embeddingProfileDigestSha256,
      "embeddingProfileDigestSha256",
    ),
    productionSemanticQualification: boolean(
      input.productionSemanticQualification,
      "productionSemanticQualification",
    ),
    qualificationManifestSha256: string(
      input.qualificationManifestSha256,
      "qualificationManifestSha256",
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
    productionEmbeddingProfileAttestation:
      decodeProductionEmbeddingProfileAttestation(
        input.productionEmbeddingProfileAttestation,
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
  if (
    activation.environment === "production" &&
    (
      activation.packageSource !== "immutable_package" ||
      activation.immutablePackageIntegrity !==
        INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity ||
      activation.qualificationManifestSha256 === null ||
      activation.qualificationManifestSha256 !==
        INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256
    )
  ) {
    throw new InfinityContextActivationError(
      "production Infinity activation and deletion reconciliation require immutable package integrity and a retained live-service qualification",
    );
  }
  if (capabilities === undefined) {
    return;
  }
  assertInfinityContextCapabilities(activation, capabilities);
}

/**
 * Search qualification is deliberately separate from immutable SDK transport
 * and deletion-drain qualification. The retained r26 manifest used a
 * deterministic mock embedding profile, so this release has no approved
 * production semantic manifest and production search remains fail closed.
 */
export function assertInfinityContextSearchActivation(
  activation: InfinityContextRuntimeActivationV1,
): void {
  if (!activation.searchEnabled || activation.environment !== "production") {
    return;
  }
  const attestation = activation.productionEmbeddingProfileAttestation;
  if (attestation === null) {
    throw new InfinityContextActivationError(
      "production Infinity search requires an immutable embedding-profile attestation",
    );
  }
  if (!attestation.productionSemanticQualification) {
    throw new InfinityContextActivationError(
      "production Infinity search requires productionSemanticQualification=true",
    );
  }
  if (
    /(?:deterministic|mock|non-production)/iu.test(attestation.embeddingProfile) ||
    attestation.qualificationManifestSha256 ===
      INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256
  ) {
    throw new InfinityContextActivationError(
      "the retained non-production qualification manifest cannot activate semantic search",
    );
  }
  const retainedManifest =
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedProductionSemanticQualificationManifestSha256;
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(attestation.embeddingProfileDigestSha256) ||
    retainedManifest === null ||
    attestation.qualificationManifestSha256 !== retainedManifest
  ) {
    throw new InfinityContextActivationError(
      "production embedding-profile attestation digest does not match retained qualification",
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
  if (
    capabilities.apiVersion !== activation.apiVersion ||
    capabilities.serviceName !== activation.serviceName ||
    (active && (
      !capabilities.supportsQdrant ||
      !capabilities.enabledAdapters.includes("qdrant")
    ))
  ) {
    throw new InfinityContextActivationError(
      "Infinity endpoint capability attestation does not satisfy this release",
    );
  }
}
