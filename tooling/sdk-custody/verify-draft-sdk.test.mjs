// @ts-check
/// <reference types="node" />
/// <reference lib="es2024" />
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { verifyDraftSdkCustody } from "./verify-draft-sdk.mjs";

// Entirely synthetic test-only package and identities. No upstream build,
// installation, GitHub access, or actual draft qualification occurs here.
/** @typedef {{path: string, sha256_hex: string, extra?: boolean}} InventoryEntry */
/** @typedef {{name: string, sha256: string, byte_length: number, id: number, attestation_verified?: boolean}} Asset */
/** @typedef {Record<string, unknown> & {assets: Asset[]}} Receipt */
/** @typedef {Record<string, unknown> & {contract_fixture_inventory: InventoryEntry[]}} Manifest */
/** @typedef {{pkg: {name: string, version: string, repository: {type: string, url: string}, files: string[]}, lock: {name: string, version: string, lockfileVersion: number, packages: {"": {name: string, version: string}}}, identity: {schema_version: string, package_name: string, package_version: string, source_commit: string, source_git_tree_oid: string, files: InventoryEntry[], extra?: boolean}}} PackageFixture */
/** @typedef {{expected: Record<string, unknown>, manifest: Manifest, receipt: Receipt, inputs: {tarball: Buffer, packageLockBytes: Buffer, manifestBytes: Buffer, receiptBytes: Buffer}}} Fixture */
/** @param {import("node:crypto").BinaryLike} bytes */
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @param {unknown} value @returns {string} */
const canonical = (value) => Array.isArray(value) ? `[${/** @type {unknown[]} */ (value).map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${canonical(/** @type {Record<string, unknown>} */ (value)[key])}`).join(",")}}`
    : JSON.stringify(value);
/** @param {unknown} value */
const bytes = (value) => Buffer.from(`${canonical(value)}\n`);

/** @param {(value: PackageFixture) => void} modifyPackage @returns {Fixture} */

function fixture(modifyPackage = () => {}) {
  const expected = {
    kind: "draft-qualification", repository: "777genius/infinity-context",
    packageName: "@infinity-context/sdk", packageVersion: "0.3.0",
    sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40), tagObject: "3".repeat(40),
    workflowSha256: sha("synthetic test-only workflow"), runId: 123, runAttempt: 1,
    releaseId: 456, tarballAssetId: 789, manifestAssetId: 790,
    observedDraftUrl: "https://github.com/777genius/infinity-context/releases/tag/untagged-0123456789abcdef0123",
  };
  const pkg = { name: expected.packageName, version: expected.packageVersion,
    repository: { type: "git", url: "git+https://github.com/777genius/infinity-context.git" }, files: ["dist"] };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: { "": { name: pkg.name, version: pkg.version } } };
  /** @type {PackageFixture["identity"]} */
  const identity = { schema_version: "infinity-context-typescript-sdk-artifact-identity.v1",
    package_name: pkg.name, package_version: pkg.version, source_commit: expected.sourceCommit,
    source_git_tree_oid: expected.sourceTree,
    files: [{ path: "dist/index.js", sha256_hex: sha("// synthetic test-only SDK\n") },
      { path: "package.json", sha256_hex: sha(bytes(pkg)) }] };
  modifyPackage({ pkg, lock, identity });
  const packageBytes = bytes(pkg);
  // Normally producer hashes the final package manifest; preserve deliberate
  // inventory tampering while accommodating metadata identity test mutations.
  const packageEntry = identity.files.find((entry) => entry.path === "package.json");
  assert.ok(packageEntry);
  packageEntry.sha256_hex = sha(packageBytes);
  const identityBytes = bytes(identity);
  const root = mkdtempSync(resolve(tmpdir(), "synthetic-sdk-draft-test-"));
  let tarball;
  try {
    mkdirSync(resolve(root, "package/dist"), { recursive: true });
    writeFileSync(resolve(root, "package/package.json"), packageBytes);
    writeFileSync(resolve(root, "package/dist/sdk-artifact-identity.json"), identityBytes);
    writeFileSync(resolve(root, "package/dist/index.js"), "// synthetic test-only SDK\n");
    tarball = execFileSync("tar", ["-czf", "-", "-C", root,
      "package/package.json", "package/dist/sdk-artifact-identity.json", "package/dist/index.js"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const packageLockBytes = bytes(lock);
  const pinnedExpected = { ...expected,
    tarballSha256: sha(tarball), tarballIntegrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    packageManifestSha256: sha(packageBytes), packageLockSha256: sha(packageLockBytes),
  };
  const inventory = [{ path: "src/index.ts", sha256_hex: sha("synthetic test-only source") }];
  const manifest = {
    artifact_byte_length: tarball.length, artifact_name: "infinity-context-sdk-0.3.0.tgz",
    artifact_identity_sha256_hex: sha(identityBytes), artifact_sha256_hex: pinnedExpected.tarballSha256,
    artifact_sri_sha512: pinnedExpected.tarballIntegrity, build_profile: "node24-npm-ci-pack-once.v1",
    build_workflow_path: ".github/workflows/typescript-sdk-release.yml",
    build_workflow_run_attempt: 1, build_workflow_run_id: 123, build_workflow_sha256_hex: expected.workflowSha256,
    contract_fixture_inventory: inventory, contract_fixture_inventory_sha256_hex: sha(Buffer.from(canonical(inventory))),
    git_object_format: "sha1", node_version: "24.18.0", package_lock_sha256_hex: pinnedExpected.packageLockSha256,
    package_name: pkg.name, package_version: "0.3.0", release_tag: "sdk-v0.3.0",
    repository: expected.repository, repository_url: "https://github.com/777genius/infinity-context",
    schema_version: "infinity-context-typescript-sdk-release.v1",
    source_commit: expected.sourceCommit, source_git_tree_oid: expected.sourceTree, tag_object_oid: expected.tagObject,
  };
  const receipt = {
    schema_version: "infinity-context-typescript-sdk-draft-qualification.v1",
    release_state: "draft", immutable_attestation_verified: false,
    evidence_scope: "Observed mutable draft; downloaded bytes match this build. Not public distribution or immutable attestation.",
    repository: expected.repository, source_commit: expected.sourceCommit, tag_object: expected.tagObject,
    workflow_sha256: expected.workflowSha256, run_id: "123", run_attempt: "1", release_id: 456,
    release_tag: "sdk-v0.3.0", observed_draft_url: expected.observedDraftUrl,
    assets: [{ name: manifest.artifact_name, sha256: pinnedExpected.tarballSha256, byte_length: tarball.length, id: 789 },
      { name: "infinity-context-sdk-release-manifest.json", sha256: "", byte_length: 0, id: 790 }],
  };
  const result = { expected: { ...pinnedExpected, manifestSha256: "", receiptSha256: "" }, manifest, receipt,
    inputs: { tarball, packageLockBytes, manifestBytes: Buffer.alloc(0), receiptBytes: Buffer.alloc(0) } };
  repinEvidence(result);
  return result;
}
// For semantic negatives, pin the mutated evidence bytes deliberately. This
// proves cross-bindings reject even a newly observed but inconsistent bundle.
/** @param {Fixture} f */
function repinEvidence(f) {
  f.inputs.manifestBytes = bytes(f.manifest);
  f.expected.manifestSha256 = sha(f.inputs.manifestBytes);
  const manifestAsset = at(f.receipt.assets, 1);
  Object.assign(manifestAsset, { sha256: f.expected.manifestSha256, byte_length: f.inputs.manifestBytes.length });
  repinReceipt(f);
}
/** @param {Fixture} f */
function repinReceipt(f) {
  f.inputs.receiptBytes = Buffer.from(`${JSON.stringify(f.receipt, null, 2)}\n`);
  f.expected.receiptSha256 = sha(f.inputs.receiptBytes);
}
/** @param {Fixture} f */
const verify = (f) => verifyDraftSdkCustody(f.inputs, f.expected);

await test("synthetic draft verifies exact producer semantics without immutable/public claims", () => {
  const f = fixture();
  const result = verify(f);
  assert.equal(result.kind, "draft-qualification");
  assert.equal(result.immutableAttestationVerified, false);
  assert.equal(result.publicDistributionVerified, false);
  assert.equal(result.tarballSha256, sha(f.inputs.tarball));
  assert.ok(Object.isFrozen(result));
  assert.throws(() => verifyDraftSdkCustody(f.inputs), /trusted identity/);
});
await test("exact tagged draft URL is supported", () => {
  const f = fixture();
  f.expected.observedDraftUrl = "https://github.com/777genius/infinity-context/releases/tag/sdk-v0.3.0";
  f.receipt.observed_draft_url = f.expected.observedDraftUrl;
  repinReceipt(f);
  verify(f);
});
for (const field of /** @type {const} */ (["tarball", "manifestBytes", "receiptBytes", "packageLockBytes"])) {
  await test(`changed pinned ${field} rejected`, () => {
    const f = fixture();
    f.inputs[field] = Buffer.concat([f.inputs[field], Buffer.from(" ")]);
    assert.throws(() => verify(f), /SHA256 mismatch/);
  });
}
for (const [field, value] of Object.entries({
  kind: "published", repository: "foreign/repository", packageName: "@foreign/sdk",
  sourceCommit: "4".repeat(40), sourceTree: "4".repeat(40), tagObject: "4".repeat(40),
  workflowSha256: "4".repeat(64), runId: 124, runAttempt: 2, releaseId: 457,
  tarballAssetId: 791, manifestAssetId: 791, tarballIntegrity: "sha512-wrong",
  packageManifestSha256: "4".repeat(64),
})) {
  await test(`independent trusted ${field} cannot be replaced by self-assertion`, () => {
    const f = fixture(); f.expected[field] = value;
    assert.throws(() => verify(f), /Draft SDK custody/);
  });
}
for (const [field, value] of Object.entries({
  schema_version: "infinity-context-typescript-sdk-release-verification-receipt.v1",
  release_state: "published", immutable_attestation_verified: true, evidence_scope: "public attestation",
  repository: "foreign/repository", source_commit: "4".repeat(40), tag_object: "4".repeat(40),
  workflow_sha256: "4".repeat(64), run_id: 123, run_attempt: "2", release_id: 457,
  release_tag: "sdk-v0.2.4", observed_draft_url: "https://github.com/foreign/repository/releases/tag/sdk-v0.3.0",
  unexpected: false,
})) {
  await test(`receipt rejects mixed/unknown ${field} despite fresh byte pin`, () => {
    const f = fixture(); f.receipt[field] = value; repinReceipt(f);
    assert.throws(() => verify(f), /draft receipt mismatch/);
  });
}
for (const mutate of /** @type {((r: Receipt) => void)[]} */ ([
  (r) => { at(r.assets, 0).name = "foreign.tgz"; },
  (r) => { at(r.assets, 0).sha256 = "4".repeat(64); },
  (r) => { at(r.assets, 0).byte_length += 1; },
  (r) => { at(r.assets, 0).id = at(r.assets, 1).id; },
  (r) => { at(r.assets, 0).attestation_verified = true; },
  (r) => { at(r.assets, 1).sha256 = "4".repeat(64); },
  (r) => { r.assets.push(at(r.assets, 0)); },
  (r) => { r.assets.pop(); },
])) {
  await test("receipt asset substitution/unknown field rejected", () => {
    const f = fixture(); mutate(f.receipt); repinReceipt(f);
    assert.throws(() => verify(f), /draft receipt mismatch/);
  });
}
for (const [field, value] of Object.entries({
  schema_version: "infinity-context-typescript-sdk-release.v2", source_commit: "4".repeat(40),
  source_git_tree_oid: "4".repeat(40), tag_object_oid: "4".repeat(40), build_workflow_run_id: 124,
  build_workflow_run_attempt: "1", build_workflow_sha256_hex: "4".repeat(64),
  build_workflow_path: ".github/workflows/foreign.yml", artifact_name: "foreign.tgz",
  artifact_sha256_hex: "4".repeat(64), artifact_sri_sha512: "sha512-wrong", artifact_byte_length: 1,
  artifact_identity_sha256_hex: "4".repeat(64), package_lock_sha256_hex: "4".repeat(64),
  package_name: "@foreign/sdk", package_version: "0.2.4", release_tag: "sdk-v0.2.4",
  repository: "foreign/repository", repository_url: "https://github.com/foreign/repository",
  build_profile: "local-build", node_version: "22.0.0", git_object_format: "sha256",
  contract_fixture_inventory_sha256_hex: "4".repeat(64), unexpected: false,
})) {
  await test(`manifest rejects mixed/unknown ${field} with matching receipt and fresh pins`, () => {
    const f = fixture(); f.manifest[field] = value; repinEvidence(f);
    assert.throws(() => verify(f), /release manifest mismatch/);
  });
}
for (const mutate of /** @type {((value: PackageFixture) => void)[]} */ ([
  ({ identity }) => { identity.source_commit = "4".repeat(40); },
  ({ identity }) => { identity.source_git_tree_oid = "4".repeat(40); },
  ({ identity }) => { identity.schema_version = "unknown"; },
  ({ identity }) => { identity.extra = true; },
  ({ identity }) => { at(identity.files, 0).sha256_hex = "4".repeat(64); },
  ({ identity }) => { at(identity.files, 0).path = "../escape"; },
  ({ pkg }) => { pkg.name = "@foreign/sdk"; },
  ({ pkg }) => { pkg.version = "0.2.4"; },
  ({ pkg }) => { pkg.repository.url = "https://github.com/foreign/repository"; },
  ({ lock }) => { lock.name = "@foreign/sdk"; },
  ({ lock }) => { lock.version = "0.2.4"; },
  ({ lock }) => { lock.packages[""].version = "0.2.4"; },
])) {
  await test("packed metadata/lock/inventory mismatch rejected even when tarball repinned", () => {
    assert.throws(() => verify(fixture(mutate)), /Draft SDK custody/);
  });
}
await test("unchanged published preparer verifies retained 0.2.4 and rejects draft option", () => {
  const script = new URL("../../vendor/infinity-context/prepare-official-sdk.mjs", import.meta.url);
  assert.match(execFileSync(process.execPath, [script.pathname, "--verify-only"], { encoding: "utf8" }), /0.2.4 immutable package verified offline/);
  assert.throws(() => execFileSync(process.execPath, [script.pathname, "--draft"], { stdio: "pipe" }), /Command failed/);
  const source = readFileSync(new URL("../../packages/infinity-context-adapter/src/infinity-sdk-provenance.ts", import.meta.url), "utf8");
  assert.match(source, /packageVersion: "0.2.4"/);
  assert.doesNotMatch(source, /draft-qualification|0\.3\.0/);
});

await test("duplicate receipt keys rejected even when the bytes are repinned", () => {
  const f = fixture();
  f.inputs.receiptBytes = Buffer.from(f.inputs.receiptBytes.toString().replace('"run_id": "123",', '"run_id": "foreign", "run_id": "123",'));
  f.expected.receiptSha256 = sha(f.inputs.receiptBytes);
  assert.throws(() => verify(f), /duplicate key/);
});
await test("unknown future draft schema and missing fields fail closed", () => {
  const f = fixture();
  f.receipt.schema_version = "infinity-context-typescript-sdk-draft-qualification.v2";
  repinReceipt(f);
  assert.throws(() => verify(f), /draft receipt mismatch/);
  delete f.expected.receiptSha256;
  assert.throws(() => verify(f), /trusted identity fields/);
});
for (const mutate of /** @type {((f: Fixture) => void)[]} */ ([
  (f) => { f.expected.runId = Number.MAX_SAFE_INTEGER + 1; },
  (f) => { f.expected.runId = "123"; },
  (f) => { f.expected.runAttempt = 0; },
  (f) => {
    assert.equal(typeof f.expected.observedDraftUrl, "string");
    f.expected.observedDraftUrl += "/suffix";
  },
  (f) => { f.expected.extra = true; },
  (f) => { at(f.manifest.contract_fixture_inventory, 0).extra = true; repinEvidence(f); },
  (f) => { at(f.manifest.contract_fixture_inventory, 0).path = "../source.ts"; repinEvidence(f); },
])) {
  await test("malformed trusted identity or nested manifest inventory fails closed", () => {
    const f = fixture(); mutate(f);
    assert.throws(() => verify(f), /Draft SDK custody/);
  });
}

/** @template T @param {T[]} values @param {number} index @returns {T} */
function at(values, index) {
  const value = values[index];
  assert.ok(value !== undefined);
  return value;
}

for (const mutate of /** @type {((value: PackageFixture) => void)[]} */ ([
  ({ pkg }) => { Object.assign(pkg, { repository: null }); },
  ({ lock }) => { Object.assign(lock, { packages: [] }); },
  ({ lock }) => { Object.assign(lock.packages, { "": null }); },
])) {
  await test("malformed package repository or lock object stays malformed and fails closed", () => {
    assert.throws(() => verify(fixture(mutate)), /Draft SDK custody/);
  });
}

for (const [original, duplicate] of /** @type {[string, string][]} */ ([
  ['"run_id": "123",', '"run\\u005fid": "foreign", "run_id": "123",'],
  ['"id": 789', '"\\u0069d": 790, "id": 789'],
])) {
  await test("escaped duplicate keys fail closed at root and inside asset arrays", () => {
    const f = fixture();
    const text = f.inputs.receiptBytes.toString();
    assert.ok(text.includes(original));
    f.inputs.receiptBytes = Buffer.from(text.replace(original, duplicate));
    f.expected.receiptSha256 = sha(f.inputs.receiptBytes);
    assert.throws(() => verify(f), /duplicate key/);
  });
}
