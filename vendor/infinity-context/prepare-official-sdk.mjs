import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const provenance = Object.freeze({
  packageManifestSha256: "d1c84a8c9e1eeb9987247616731fd3b3d7ad3002b9a84607c36cd60f8c642367",
  packageName: "@infinity-context/sdk",
  packageTarballIntegrity:
    "sha512-c/qRsUrKGOm7fxUZh5o7Vkg5AAuCg2UeyftZsBbcOpFKUqrmMRALjwQAJpLqhlNh3NKrWcRvZZZMUvkXJmnVQQ==",
  packageTarballSha256: "ecaa837b0a07ff31a786d070c6c0c34acf3b919241928ed75af5645541b790b2",
  packageVersion: "0.2.0",
  reviewedSourceCommit: "4ea98c141770666dcbae3d46f9dddb2b974b5879",
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
  "artifacts/infinity-context-sdk-0.2.0.tgz",
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

process.stdout.write(
  `Infinity Context SDK ${provenance.packageVersion} immutable package verified offline ` +
    `(reviewed source ${provenance.reviewedSourceCommit}).\n`,
);
