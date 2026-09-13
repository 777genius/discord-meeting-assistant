import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { INFINITY_CONTEXT_RETRIEVAL_V3_SDK_PROVENANCE } from "../infinity-sdk-provenance.js";
import { canonicalJson, exactRecord, sha256 } from "./canonical.js";
import type { DiagnosticSdkIdentity } from "./diagnostic-manifest.js";

/** Authenticate the installed bytes against the explicit test-only V3 draft intake. */
export async function verifyInstalledDiagnosticSdk(
  expected: DiagnosticSdkIdentity,
): Promise<Readonly<DiagnosticSdkIdentity & { readonly loadedEntrypointSha256: string }>> {
  const entrypoint = new URL(import.meta.resolve("@infinity-context/sdk"));
  const installedEntrypoint = await realpath(fileURLToPath(entrypoint));
  if (!installedEntrypoint.includes(`${sep}node_modules${sep}`)) {
    throw new Error("diagnostic SDK resolution is not an installed package artifact");
  }
  const packageRoot = await realpath(fileURLToPath(new URL("..", entrypoint)));
  return verifyDiagnosticSdkPackageBytes(packageRoot, installedEntrypoint, expected);
}

/** Byte verifier kept separate so hostile installed-package layouts can be tested without
 * mutating the workspace installation. It does not establish installed-package resolution. */
export async function verifyDiagnosticSdkPackageBytes(packageRoot: string, installedEntrypoint: string,
  expected: DiagnosticSdkIdentity): Promise<Readonly<DiagnosticSdkIdentity & {
    readonly loadedEntrypointSha256: string;
  }>> {
  assertDiagnosticSdkProvenance();
  const provenance = INFINITY_CONTEXT_RETRIEVAL_V3_SDK_PROVENANCE;
  const observed = diagnosticSdkIdentityFromProvenance();
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error("installed diagnostic SDK differs from authenticated draft package");
  }
  await assertDiagnosticSdkManifest(packageRoot, expected);
  const identityPath = resolve(packageRoot, provenance.artifactIdentityPath);
  if (relative(packageRoot, identityPath).split(sep).join("/") !== provenance.artifactIdentityPath) {
    throw new Error("installed diagnostic SDK artifact identity path is unsafe");
  }
  const identityBytes = await readFile(identityPath);
  const identity = exactInstalledSdkIdentity(JSON.parse(identityBytes.toString("utf8")));
  assertDiagnosticSdkArtifactIdentity(identityBytes, identity, expected);
  assertDiagnosticSdkInventoryMembership(packageRoot, installedEntrypoint, identity);
  for (const file of identity.files) {
    await assertDiagnosticSdkInventoryFile(packageRoot, file);
  }
  return Object.freeze({ ...observed,
    loadedEntrypointSha256: sha256(await readFile(installedEntrypoint)) });
}

function assertDiagnosticSdkProvenance(): void {
  const provenance: DiagnosticSdkProvenanceAdmission = INFINITY_CONTEXT_RETRIEVAL_V3_SDK_PROVENANCE;
  if (provenance.evidenceKind !== "draft-qualification" || provenance.releaseState !== "draft" ||
    provenance.qualificationScope !== "test-only" || provenance.immutableAttestationVerified ||
    provenance.publicDistributionVerified) {
    throw new Error("diagnostic SDK provenance is not an admitted test-only draft");
  }
}

interface DiagnosticSdkProvenanceAdmission {
  readonly evidenceKind: string;
  readonly releaseState: string;
  readonly qualificationScope: string;
  readonly immutableAttestationVerified: boolean;
  readonly publicDistributionVerified: boolean;
}

function diagnosticSdkIdentityFromProvenance(): Readonly<DiagnosticSdkIdentity> {
  const provenance = INFINITY_CONTEXT_RETRIEVAL_V3_SDK_PROVENANCE;
  return Object.freeze({ packageName: provenance.packageName, version: provenance.packageVersion,
    sourceRevision: provenance.reviewedSourceCommit, tarballSha256: provenance.packageTarballSha256,
    manifestSha256: provenance.packageManifestSha256 });
}

function diagnosticSdkManifestIdentity(value: unknown): Readonly<{ name: unknown; version: unknown }> {
  if (typeof value !== "object" || value === null) {
    return { name: undefined, version: undefined };
  }
  return { name: "name" in value ? value.name : undefined,
    version: "version" in value ? value.version : undefined };
}

async function assertDiagnosticSdkManifest(packageRoot: string, expected: DiagnosticSdkIdentity): Promise<void> {
  const manifestBytes = await readFile(join(packageRoot, "package.json"));
  const manifest = diagnosticSdkManifestIdentity(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.name !== expected.packageName || manifest.version !== expected.version ||
    sha256(manifestBytes) !== expected.manifestSha256) {
    throw new Error("installed diagnostic SDK manifest differs from authenticated draft package");
  }
}

interface InstalledSdkArtifactIdentity {
  readonly files: readonly InstalledSdkArtifactFile[];
  readonly package_name: string; readonly package_version: string;
  readonly schema_version: string; readonly source_commit: string;
  readonly source_git_tree_oid: string;
}
interface InstalledSdkArtifactFile { readonly path: string; readonly sha256_hex: string }

function exactInstalledSdkIdentity(value: unknown): InstalledSdkArtifactIdentity {
  let record: Record<string, unknown>;
  try {
    record = exactRecord(value, ["files", "package_name", "package_version", "schema_version",
      "source_commit", "source_git_tree_oid"], "installed diagnostic SDK artifact identity");
  } catch {
    throw new Error("installed diagnostic SDK artifact identity is invalid");
  }
  if (record.schema_version !== "infinity-context-typescript-sdk-artifact-identity.v1" ||
    !Array.isArray(record.files) || record.files.length === 0) {
    throw new Error("installed diagnostic SDK artifact identity is invalid");
  }
  const packageName = installedSdkIdentityText(record.package_name);
  const packageVersion = installedSdkIdentityText(record.package_version);
  const sourceCommit = installedSdkIdentityText(record.source_commit);
  const sourceTree = installedSdkIdentityText(record.source_git_tree_oid);
  const files = record.files.map(exactInstalledSdkFile);
  if (new Set(files.map(({ path }) => path)).size !== files.length) {
    throw new Error("installed diagnostic SDK file inventory is duplicated");
  }
  return Object.freeze({ files: Object.freeze(files),
    package_name: packageName,
    package_version: packageVersion,
    schema_version: record.schema_version,
    source_commit: sourceCommit,
    source_git_tree_oid: sourceTree });
}

function installedSdkIdentityText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("installed diagnostic SDK artifact identity is invalid");
  }
  return value;
}

function exactInstalledSdkFile(value: unknown): InstalledSdkArtifactFile {
  let file: Record<string, unknown>;
  try {
    file = exactRecord(value, ["path", "sha256_hex"], "installed diagnostic SDK file identity");
  } catch {
    throw new Error("installed diagnostic SDK file identity is invalid");
  }
  if (typeof file.path !== "string" || file.path.length === 0 || file.path.includes("\0") ||
    file.path.includes("\\") || file.path.startsWith("/") ||
    file.path.split("/").some(part => part === "" || part === "." || part === "..") ||
    typeof file.sha256_hex !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256_hex)) {
    throw new Error("installed diagnostic SDK file identity is invalid");
  }
  return Object.freeze({ path: file.path, sha256_hex: file.sha256_hex });
}

function assertDiagnosticSdkArtifactIdentity(identityBytes: Uint8Array,
  identity: InstalledSdkArtifactIdentity, expected: DiagnosticSdkIdentity): void {
  const provenance = INFINITY_CONTEXT_RETRIEVAL_V3_SDK_PROVENANCE;
  if (sha256(identityBytes) !== provenance.artifactIdentitySha256 ||
    sha256(identity.files) !== provenance.artifactInventorySha256) {
    throw new Error("installed diagnostic SDK artifact identity differs");
  }
  if (identity.package_name !== expected.packageName || identity.package_version !== expected.version ||
    identity.source_commit !== provenance.reviewedSourceCommit ||
    identity.source_git_tree_oid !== provenance.reviewedSourceTree) {
    throw new Error("installed diagnostic SDK source identity differs");
  }
}

function assertDiagnosticSdkInventoryMembership(packageRoot: string, installedEntrypoint: string,
  identity: InstalledSdkArtifactIdentity): void {
  const entrypointRelative = relative(packageRoot, installedEntrypoint).split(sep).join("/");
  if (!identity.files.some(({ path }) => path === "package.json") ||
    !identity.files.some(({ path }) => path === entrypointRelative)) {
    throw new Error("installed diagnostic SDK inventory is incomplete");
  }
}

async function assertDiagnosticSdkInventoryFile(packageRoot: string,
  file: InstalledSdkArtifactFile): Promise<void> {
  const path = resolve(packageRoot, file.path);
  const child = relative(packageRoot, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child) ||
    await realpath(path) !== path || (await lstat(path)).isSymbolicLink() ||
    sha256(await readFile(path)) !== file.sha256_hex) {
    throw new Error("installed diagnostic SDK file inventory differs");
  }
}
