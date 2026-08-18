import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const provenance = Object.freeze({
  archiveSha256: "4d96f50ae01f9000e9ac4c50eaa61b4d875c3a452aed58f7e2efe1d69ee8d08d",
  commit: "b77b490cebbf9d80d4204425df3d795b4866ea19",
  packageLockSha256: "068b3129a4ccd449c50cdc6a72755dbae3d4a977c5a468565e2f3841529cac0e",
  packageManifestSha256: "a646c42b1f8948b0f1b81d3d988f79b4f2c64616a1c5e2711648b2686ce1e135",
  packagePath: "packages/infinity_context_ts_sdk",
  packageTarballIntegrity:
    "sha512-YurXjgFGoRxwc5zJghj69ZFyZx8WLS1ucvgVvV2EFjZMCATxr9YrJW1ueeyLqwkaLKnO1JEvbTpqn7Q8K33b+A==",
  packageTarballSha256: "2e4bcced4df632a7953c7ff767a4076ce6cfff1aa4469a40e8b36659f29a90c8",
  repository: "https://github.com/777genius/infinity-context.git",
  tree: "ac25c12c4733953bf7a4882d5c2c4476589455f2",
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
if (argumentsSet.has("--prune-dev") && argumentsSet.has("--verify-only")) {
  throw new Error("Infinity Context SDK verification cannot prune dependencies");
}

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = resolve(vendorRoot, ".upstream");
const packageRoot = resolve(checkoutRoot, provenance.packagePath);
const retainedPackagePath = resolve(
  vendorRoot,
  "artifacts/infinity-context-sdk-0.1.0-b77b490c.tgz",
);
const npmCache = resolve(tmpdir(), "discord-meeting-infinity-sdk-npm-cache");
const stampPath = resolve(checkoutRoot, ".git", "meeting-knowledge-sdk-build.json");

function command(executable, argumentsList, options = {}) {
  return execFileSync(executable, argumentsList, {
    cwd: options.cwd ?? vendorRoot,
    encoding: options.encoding,
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? 32 * 1_024 * 1_024,
    stdio: options.capture === true || options.encoding !== undefined
      ? ["ignore", "pipe", "inherit"]
      : "inherit",
  });
}

function git(argumentsList, options = {}) {
  // Docker COPY intentionally changes the checkout owner to the runtime UID,
  // while this immutable provenance check runs in the root-owned build stage.
  // Trust only this exact bundled checkout instead of weakening Git globally.
  return command("git", ["-c", `safe.directory=${checkoutRoot}`, "-C", checkoutRoot, ...argumentsList], options);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function verifyRetainedPackageTarball() {
  if (!existsSync(retainedPackagePath)) {
    throw new Error("Retained Infinity Context SDK package is missing");
  }
  const retained = readFileSync(retainedPackagePath);
  if (
    sha256(retained) !== provenance.packageTarballSha256 ||
    packageIntegrity(retained) !== provenance.packageTarballIntegrity
  ) {
    throw new Error("Retained Infinity Context SDK package provenance verification failed");
  }
}

function verifyPackageTarball() {
  const packRoot = mkdtempSync(resolve(tmpdir(), "infinity-context-sdk-pack-"));
  try {
    const output = command("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packRoot,
    ], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCache },
    });
    const entries = JSON.parse(output);
    const entry = Array.isArray(entries) ? entries[0] : undefined;
    if (
      entries.length !== 1 ||
      typeof entry?.filename !== "string" ||
      entry.integrity !== provenance.packageTarballIntegrity
    ) {
      throw new Error("Infinity Context SDK package integrity verification failed");
    }
    const tarball = readFileSync(resolve(packRoot, entry.filename));
    if (sha256(tarball) !== provenance.packageTarballSha256) {
      throw new Error("Infinity Context SDK package SHA-256 verification failed");
    }
  } finally {
    rmSync(packRoot, { force: true, recursive: true });
  }
}

function cleanupTemporaryBuildInputs() {
  rmSync(checkoutRoot, { force: true, recursive: true });
  rmSync(npmCache, { force: true, recursive: true });
  if (existsSync(checkoutRoot)) {
    throw new Error("Infinity Context SDK source workspace cleanup failed");
  }
}

function prepareCheckout() {
  if (existsSync(checkoutRoot)) {
    if (!existsSync(resolve(checkoutRoot, ".git"))) {
      throw new Error("Infinity Context source workspace exists without Git provenance");
    }
    return;
  }
  mkdirSync(checkoutRoot, { recursive: true });
  command("git", ["init", checkoutRoot]);
  git(["remote", "add", "origin", provenance.repository]);
  git(["sparse-checkout", "init", "--cone"]);
  git(["sparse-checkout", "set", provenance.packagePath]);
  git(["fetch", "--depth=1", "--no-tags", "origin", provenance.commit]);
  git(["checkout", "--detach", "FETCH_HEAD"]);
}

function verifyCheckout() {
  const head = git(["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = git(
    ["rev-parse", `${provenance.commit}:${provenance.packagePath}`],
    { encoding: "utf8" },
  ).trim();
  const trackedChanges = git(
    ["status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" },
  ).trim();
  const archive = git([
    "archive",
    "--format=tar",
    provenance.commit,
    provenance.packagePath,
  ], { capture: true });
  if (
    head !== provenance.commit ||
    tree !== provenance.tree ||
    trackedChanges.length > 0 ||
    sha256(archive) !== provenance.archiveSha256 ||
    sha256(readFileSync(resolve(packageRoot, "package.json"))) !==
      provenance.packageManifestSha256 ||
    sha256(readFileSync(resolve(packageRoot, "package-lock.json"))) !==
      provenance.packageLockSha256
  ) {
    throw new Error("Infinity Context SDK source provenance verification failed");
  }
}

const expectedExports = Object.freeze([
  "index",
  "instrumentation",
  "pagination",
  "runtime",
  "canary",
  "proof",
  "workflows",
]);

function expectedBuildStamp() {
  return JSON.stringify({
    ...provenance,
    nodeVersion: process.version,
    schemaVersion: 1,
  });
}

function preparedBuildExists(stamp) {
  return existsSync(stampPath) &&
    readFileSync(stampPath, "utf8") === stamp &&
    expectedExports.every((entrypoint) =>
      ["cjs", "d.ts", "js"].every((extension) =>
        existsSync(resolve(packageRoot, "dist", `${entrypoint}.${extension}`))
      )
    );
}

function npm(argumentsList) {
  mkdirSync(npmCache, { recursive: true });
  command("npm", argumentsList, {
    cwd: packageRoot,
    env: { ...process.env, npm_config_cache: npmCache },
  });
}

prepareCheckout();
verifyCheckout();
verifyRetainedPackageTarball();
const stamp = expectedBuildStamp();
if (argumentsSet.has("--verify-only")) {
  if (!expectedExports.every((entrypoint) =>
    ["cjs", "d.ts", "js"].every((extension) =>
      existsSync(resolve(packageRoot, "dist", `${entrypoint}.${extension}`))
    )
  )) {
    throw new Error("Infinity Context SDK exports have not been prepared");
  }
} else if (!preparedBuildExists(stamp)) {
  npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  npm(["run", "build"]);
  npm(["run", "check:exports"]);
  npm(["run", "check:consumer"]);
  writeFileSync(stampPath, stamp, "utf8");
}
verifyPackageTarball();
if (argumentsSet.has("--prune-dev")) {
  npm(["prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
}
if (argumentsSet.has("--cleanup-source")) {
  cleanupTemporaryBuildInputs();
  process.stdout.write(
    "Infinity Context SDK package verified; temporary source workspace removed.\n",
  );
} else {
  process.stdout.write("Infinity Context SDK source workspace prepared.\n");
}
