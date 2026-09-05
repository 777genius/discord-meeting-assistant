import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const provenance = Object.freeze({
  packageManifestSha256: "218762d671873968552ce568ae1a87bb651e5ca5017db4f6b2953252aa7ae67e",
  packageName: "@infinity-context/sdk",
  packageTarballIntegrity:
    "sha512-PpLM+eW84DRsNhYDvX02Y+v5hOCuQJMHJoNinyUwclHtizmpDEh4aBcRsCEvgqyQqYh2pD+zsu3VAZdKfbjKAg==",
  packageTarballSha256: "c838fab52ca10d57119f1964d3ab29d71a2c7194047e15a68a6e189af3779bde",
  packageVersion: "0.2.4",
  packageLockSha256: "c27ee764041ac4e93fd3d19bbf4363590e3dc1641abe4d89c7cbb0cbfc8222da",
  releaseManifestSha256: "8b675d4f4ee00b3effc4208fe24a65f6406b891d6c33d388dafd73ce4b7f71af",
  releaseReceiptSha256: "4dff2fb23ddf2913332d033d0283b5268e24ce88eee7c854bc26e417ae1946cf",
  releaseTag: "sdk-v0.2.4",
  reviewedSourceCommit: "40704f193008f98c52ede93b68a44349907dd2cd",
  reviewedSourceTree: "836cca4d0981f4df73922c5b982975fc9db25ec7",
  tagObject: "60933db64cdc5796b624d97f463b498b28ae3fca",
});

const argumentsSet = new Set(process.argv.slice(2));
const supportedArguments = new Set([
  "--cleanup-source",
  "--prune-dev",
  "--verify-only",
]);
if ([...argumentsSet].some((argument) => !supportedArguments.has(argument))) {
  throw new Error("Unsupported Infinity Context SDK preparation argument");
}

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const retainedPackagePath = resolve(
  vendorRoot,
  "artifacts/infinity-context-sdk-0.2.4.tgz",
);
const releaseManifestPath = resolve(
  vendorRoot,
  "artifacts/infinity-context-sdk-0.2.4-release-manifest.json",
);
const releaseReceiptPath = resolve(
  vendorRoot,
  "artifacts/infinity-context-sdk-0.2.4-release-verification-receipt.json",
);

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function verifyPackedMetadata(tarball) {
  const extractionRoot = mkdtempSync(resolve(tmpdir(), "infinity-context-sdk-metadata-"));
  try {
    execFileSync("tar", ["-xzf", retainedPackagePath, "-C", extractionRoot,
      "package/package.json"], { stdio: "ignore" });
    const manifestBytes = readFileSync(resolve(extractionRoot, "package/package.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (
      digest("sha256", manifestBytes, "hex") !== provenance.packageManifestSha256 ||
      manifest.name !== provenance.packageName ||
      manifest.version !== provenance.packageVersion
    ) {
      throw new Error("Retained Infinity Context SDK package metadata verification failed");
    }
    if (tarball.byteLength === 0) {
      throw new Error("Retained Infinity Context SDK package is empty");
    }
  } finally {
    rmSync(extractionRoot, { force: true, recursive: true });
  }
}

const retained = readFileSync(retainedPackagePath);
if (
  digest("sha256", retained, "hex") !== provenance.packageTarballSha256 ||
  `sha512-${digest("sha512", retained, "base64")}` !== provenance.packageTarballIntegrity
) {
  throw new Error("Retained Infinity Context SDK package provenance verification failed");
}
verifyPackedMetadata(retained);

const releaseManifestBytes = readFileSync(releaseManifestPath);
const releaseReceiptBytes = readFileSync(releaseReceiptPath);
const releaseManifest = JSON.parse(releaseManifestBytes.toString("utf8"));
const releaseReceipt = JSON.parse(releaseReceiptBytes.toString("utf8"));
if (
  digest("sha256", releaseManifestBytes, "hex") !== provenance.releaseManifestSha256 ||
  digest("sha256", releaseReceiptBytes, "hex") !== provenance.releaseReceiptSha256 ||
  releaseManifest.repository !== "777genius/infinity-context" ||
  releaseManifest.schema_version !== "infinity-context-typescript-sdk-release.v1" ||
  releaseManifest.package_lock_sha256_hex !== provenance.packageLockSha256 ||
  releaseManifest.artifact_byte_length !== retained.byteLength ||
  releaseManifest.release_tag !== provenance.releaseTag ||
  releaseManifest.source_commit !== provenance.reviewedSourceCommit ||
  releaseManifest.source_git_tree_oid !== provenance.reviewedSourceTree ||
  releaseManifest.tag_object_oid !== provenance.tagObject ||
  releaseManifest.artifact_name !== "infinity-context-sdk-0.2.4.tgz" ||
  releaseManifest.artifact_sha256_hex !== provenance.packageTarballSha256 ||
  releaseManifest.artifact_sri_sha512 !== provenance.packageTarballIntegrity ||
  releaseManifest.package_name !== provenance.packageName ||
  releaseManifest.package_version !== provenance.packageVersion ||
  releaseReceipt.repository !== "777genius/infinity-context" ||
  releaseReceipt.tag !== provenance.releaseTag ||
  releaseReceipt.schema_version !==
    "infinity-context-typescript-sdk-release-verification-receipt.v1" ||
  releaseReceipt.release_url !==
    `https://github.com/777genius/infinity-context/releases/tag/${provenance.releaseTag}` ||
  releaseReceipt.run_id !== releaseManifest.build_workflow_run_id ||
  releaseReceipt.run_attempt !== releaseManifest.build_workflow_run_attempt ||
  releaseReceipt.release_attestation_verified !== true ||
  !Array.isArray(releaseReceipt.assets) ||
  releaseReceipt.assets.length !== 2 ||
  ![
    [releaseManifest.artifact_name, provenance.packageTarballSha256],
    ["infinity-context-sdk-release-manifest.json", provenance.releaseManifestSha256],
  ].every(([name, sha256]) => releaseReceipt.assets.some((asset) =>
    asset.name === name && asset.sha256_hex === sha256 && asset.attestation_verified === true
  ))
) {
  throw new Error("Retained Infinity Context SDK release evidence verification failed");
}

process.stdout.write(
  `Infinity Context SDK ${provenance.packageVersion} immutable package verified offline ` +
    `(reviewed source ${provenance.reviewedSourceCommit}).\n`,
);
