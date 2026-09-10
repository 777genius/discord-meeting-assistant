import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const RECEIPT_SCHEMA = "infinity-context-typescript-sdk-draft-qualification.v1";
const SCOPE = "Observed mutable draft; downloaded bytes match this build. Not public distribution or immutable attestation.";
const MANIFEST_NAME = "infinity-context-sdk-release-manifest.json";
const IDENTITY_PATH = "dist/sdk-artifact-identity.json";
const MAX_METADATA = 10 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function requireMatch(condition, label) {
  if (!condition) {throw new Error(`Draft SDK custody: ${label}`);}
}
function exactKeys(value, keys, label) {
  requireMatch(value !== null && typeof value === "object" && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).toSorted(), [...keys].toSorted()), `${label} fields`);
}
function equal(actual, expected, label) {
  requireMatch(isDeepStrictEqual(actual, expected), `${label} mismatch`);
}
function canonical(value) {
  if (Array.isArray(value)) {return `[${value.map(canonical).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  requireMatch(typeof value !== "number" || Number.isSafeInteger(value), "unsafe JSON number");
  return JSON.stringify(value);
}
function parse(bytes, label, canonicalRequired = false) {
  requireMatch(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_METADATA, `${label} bytes`);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(text);
  // JSON.parse alone silently accepts duplicate keys. Tokenize only after it
  // has validated syntax, keeping strings (including escaped keys) intact.
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/gu) ?? [];
  const objects = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "{") {objects.push(new Set());}
    else if (token === "[") {objects.push(null);}
    else if (token === "}" || token === "]") {objects.pop();}
    else if (token.startsWith('"') && tokens[index + 1] === ":") {
      const key = JSON.parse(token);
      const keys = objects.at(-1);
      requireMatch(keys !== null && keys !== undefined && !keys.has(key), `${label} duplicate key`);
      keys.add(key);
    }
  }
  if (canonicalRequired) {
    requireMatch(text === canonical(value) || text === `${canonical(value)}\n`, `${label} canonical JSON`);
  }
  return value;
}
function digestPin(bytes, pin, label) {
  requireMatch(typeof pin === "string" && /^[0-9a-f]{64}$/u.test(pin), `${label} trusted SHA256`);
  equal(sha256(bytes), pin, `${label} SHA256`);
}
function positive(value, label) {
  requireMatch(Number.isSafeInteger(value) && value > 0, label);
}
function inventory(value, label) {
  requireMatch(Array.isArray(value) && value.length > 0 && value.length <= 4096, label);
  let previous = "";
  for (const entry of value) {
    exactKeys(entry, ["path", "sha256_hex"], label);
    requireMatch(typeof entry.path === "string" && /^[A-Za-z0-9_./-]+$/u.test(entry.path) &&
      entry.path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
      entry.path > previous, `${label} path/order`);
    requireMatch(typeof entry.sha256_hex === "string" && /^[0-9a-f]{64}$/u.test(entry.sha256_hex), `${label} digest`);
    previous = entry.path;
  }
}

/**
 * Offline, development-only intake helper. No installation or active pin changes.
 * `expected` MUST come from a separately reviewed trusted intake record, never
 * be populated from the supplied receipt/manifest. All hashes pin exact bytes.
 * The source lock is supplied separately because npm pack omits package-lock.json.
 * Producer inspected at 1715a6b9cb33f0b59d508e16cfbecc290d3e6103:
 * sdk-release-publish.sh, sdk-release-manifest.mjs, sdk-artifact-identity.mjs.
 * A successful result proves consistency with those pins, not GitHub state,
 * source reproducibility, public distribution, or an immutable attestation.
 * Receipt run IDs are strings; manifest run IDs are positive safe integers.
 */
function verifyTrustedIdentity(expected) {
  exactKeys(expected, [
    "kind", "repository", "packageName", "packageVersion", "sourceCommit", "sourceTree",
    "tagObject", "workflowSha256", "runId", "runAttempt", "releaseId", "observedDraftUrl",
    "tarballAssetId", "manifestAssetId", "tarballSha256", "tarballIntegrity",
    "manifestSha256", "receiptSha256", "packageManifestSha256", "packageLockSha256",
  ], "trusted identity");
  equal(expected.kind, "draft-qualification", "trusted evidence kind");
  equal(expected.repository, "777genius/infinity-context", "trusted repository");
  equal(expected.packageName, "@infinity-context/sdk", "trusted package");
  requireMatch(typeof expected.packageVersion === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(expected.packageVersion), "trusted version");
  const [major, minor, patch] = expected.packageVersion.split(".").map(Number);
  requireMatch(major > 0 || minor > 2 || (minor === 2 && patch >= 1), "producer minimum version");
  for (const field of ["sourceCommit", "sourceTree", "tagObject"]) {
    requireMatch(typeof expected[field] === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(expected[field]) &&
      expected[field].length === expected.sourceCommit.length, `trusted ${field}`);
  }
  requireMatch(typeof expected.workflowSha256 === "string" && /^[0-9a-f]{64}$/u.test(expected.workflowSha256), "trusted workflow");
  for (const field of ["runId", "runAttempt", "releaseId", "tarballAssetId", "manifestAssetId"]) {positive(expected[field], `trusted ${field}`);}
  requireMatch(expected.tarballAssetId !== expected.manifestAssetId, "distinct asset IDs");
  const tag = `sdk-v${expected.packageVersion}`;
  const artifactName = `infinity-context-sdk-${expected.packageVersion}.tgz`;
  const urlBase = `https://github.com/${expected.repository}/releases/tag/`;
  requireMatch(typeof expected.observedDraftUrl === "string" &&
    (expected.observedDraftUrl === `${urlBase}${tag}` ||
      (expected.observedDraftUrl.startsWith(`${urlBase}untagged-`) &&
        /^[0-9a-f]{20}$/u.test(expected.observedDraftUrl.slice(`${urlBase}untagged-`.length)))), "trusted draft URL");
  return { tag, artifactName };
}

export function verifyDraftSdkCustody({ tarball, manifestBytes, receiptBytes, packageLockBytes }, expected) {
  const { tag, artifactName } = verifyTrustedIdentity(expected);
  requireMatch(Buffer.isBuffer(tarball) && tarball.length > 0 && tarball.length <= 100 * 1024 * 1024, "tarball bytes");
  digestPin(tarball, expected.tarballSha256, "tarball");
  equal(`sha512-${createHash("sha512").update(tarball).digest("base64")}`, expected.tarballIntegrity, "tarball SRI");
  digestPin(manifestBytes, expected.manifestSha256, "manifest");
  digestPin(receiptBytes, expected.receiptSha256, "receipt");
  digestPin(packageLockBytes, expected.packageLockSha256, "package lock");
  const manifest = parse(manifestBytes, "manifest", true);
  const receipt = parse(receiptBytes, "receipt");
  // jq emits pretty JSON; comparing the complete value closes every receipt and
  // asset field. Exact receipt-byte pinning also prevents duplicate-key rewrites.
  equal(receipt, {
    schema_version: RECEIPT_SCHEMA,
    release_state: "draft", immutable_attestation_verified: false, evidence_scope: SCOPE,
    repository: expected.repository, source_commit: expected.sourceCommit, tag_object: expected.tagObject,
    workflow_sha256: expected.workflowSha256, run_id: String(expected.runId), run_attempt: String(expected.runAttempt),
    release_id: expected.releaseId, release_tag: tag, observed_draft_url: expected.observedDraftUrl,
    assets: [
      { name: artifactName, sha256: expected.tarballSha256, byte_length: tarball.length, id: expected.tarballAssetId },
      { name: MANIFEST_NAME, sha256: expected.manifestSha256, byte_length: manifestBytes.length, id: expected.manifestAssetId },
    ],
  }, "draft receipt");
  // Read only exact members to stdout from the already hashed buffer. Never
  // unpack an untrusted archive to disk or execute anything from the package.
  const member = (path) => execFileSync("tar", ["-xzOf", "-", `package/${path}`], {
    input: tarball, maxBuffer: MAX_METADATA, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
  });
  const packageBytes = member("package.json");
  digestPin(packageBytes, expected.packageManifestSha256, "package manifest");
  const pkg = parse(packageBytes, "package manifest");
  equal(pkg.name, expected.packageName, "packed package name");
  equal(pkg.version, expected.packageVersion, "packed package version");
  const repositoryUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  requireMatch(typeof repositoryUrl === "string", "packed repository");
  equal(repositoryUrl.replace(/^git\+https:\/\//u, "https://").replace(/\.git$/u, ""), `https://github.com/${expected.repository}`, "packed repository");
  const lock = parse(packageLockBytes, "package lock");
  equal(lock.name, expected.packageName, "lock package name");
  equal(lock.version, expected.packageVersion, "lock version");
  equal(lock.packages?.[""]?.name, expected.packageName, "lock root name");
  equal(lock.packages?.[""]?.version, expected.packageVersion, "lock root version");
  const identityBytes = member(IDENTITY_PATH);
  const identity = parse(identityBytes, "packed identity", true);
  exactKeys(identity, ["files", "package_name", "package_version", "schema_version", "source_commit", "source_git_tree_oid"], "packed identity");
  equal(identity.schema_version, "infinity-context-typescript-sdk-artifact-identity.v1", "packed identity schema");
  equal(identity.package_name, expected.packageName, "identity package name");
  equal(identity.package_version, expected.packageVersion, "identity package version");
  equal(identity.source_commit, expected.sourceCommit, "identity source");
  equal(identity.source_git_tree_oid, expected.sourceTree, "identity tree");
  inventory(identity.files, "packed inventory");
  requireMatch(identity.files.some((entry) => entry.path === "package.json"), "inventory package manifest");
  for (const entry of identity.files) {
    requireMatch(entry.path !== IDENTITY_PATH, "self-referencing identity");
    digestPin(member(entry.path), entry.sha256_hex, `packed ${entry.path}`);
  }
  inventory(manifest.contract_fixture_inventory, "contract inventory");
  requireMatch(manifest.contract_fixture_inventory.every((entry) =>
    (entry.path.startsWith("src/") && entry.path.endsWith(".ts")) ||
    (entry.path.startsWith("fixtures/") && entry.path.endsWith(".json"))), "contract inventory paths");
  equal(manifest, {
    artifact_byte_length: tarball.length, artifact_name: artifactName,
    artifact_identity_sha256_hex: sha256(identityBytes), artifact_sha256_hex: expected.tarballSha256,
    artifact_sri_sha512: expected.tarballIntegrity, build_profile: "node24-npm-ci-pack-once.v1",
    build_workflow_path: ".github/workflows/typescript-sdk-release.yml",
    build_workflow_run_attempt: expected.runAttempt, build_workflow_run_id: expected.runId,
    build_workflow_sha256_hex: expected.workflowSha256,
    contract_fixture_inventory: manifest.contract_fixture_inventory,
    contract_fixture_inventory_sha256_hex: sha256(Buffer.from(canonical(manifest.contract_fixture_inventory))),
    git_object_format: expected.sourceCommit.length === 40 ? "sha1" : "sha256", node_version: "24.18.0",
    package_lock_sha256_hex: expected.packageLockSha256, package_name: expected.packageName,
    package_version: expected.packageVersion, release_tag: tag, repository: expected.repository,
    repository_url: `https://github.com/${expected.repository}`, schema_version: "infinity-context-typescript-sdk-release.v1",
    source_commit: expected.sourceCommit, source_git_tree_oid: expected.sourceTree, tag_object_oid: expected.tagObject,
  }, "release manifest");
  return Object.freeze({
    kind: "draft-qualification", evidenceScope: SCOPE, immutableAttestationVerified: false,
    publicDistributionVerified: false, ...expected,
  });
}
