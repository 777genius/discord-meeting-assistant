import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

interface ProtobufEvolutionEvidence {
  readonly current?: {
    readonly breaking?: {
      readonly fingerprint?: unknown;
      readonly status?: unknown;
    };
    readonly bufConfigDigest?: unknown;
    readonly bufVersion?: unknown;
    readonly descriptorImageDigest?: unknown;
    readonly generationDrift?: {
      readonly expectedGeneratedOutputDigest?: unknown;
      readonly observedGeneratedOutputDigest?: unknown;
    };
  };
}

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);
const bufCliPath = join(
  dirname(require.resolve("@bufbuild/buf/package.json")),
  "bin",
  "buf",
);
const evidenceUrl = new URL(
  "architecture/foundation/protobuf-evolution.yaml",
  repositoryRoot,
);
const baselineImageUrl = new URL(
  "architecture/contracts/protobuf/meeting-platform-rpc-v0.1.0.binpb",
  repositoryRoot,
);
const bufConfigUrl = new URL("buf.yaml", repositoryRoot);
const emptyOutputDigest = digest(new Uint8Array());

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new Error(
      `${field} evidence mismatch: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

function breakingFingerprint(input: {
  readonly bufConfigDigest: string;
  readonly bufVersion: string;
  readonly currentDescriptorDigest: string;
  readonly releasedDescriptorDigest: string;
}): `sha256:${string}` {
  return digest(
    new TextEncoder().encode(
      [
        "buf-breaking-v1",
        input.bufVersion,
        input.bufConfigDigest,
        input.currentDescriptorDigest,
        input.releasedDescriptorDigest,
        "compatible\n",
      ].join("\0"),
    ),
  );
}

async function runBuf(...arguments_: readonly string[]): Promise<string> {
  const result = await execute(bufCliPath, [...arguments_], {
    cwd: repositoryRoot,
    maxBuffer: 4 * 1_024 * 1_024,
  });
  return result.stdout.trim();
}

const evidence = JSON.parse(
  await readFile(evidenceUrl, "utf8"),
) as ProtobufEvolutionEvidence;
const current = evidence.current;
if (current === undefined) {
  throw new Error("Protobuf evolution current evidence is missing");
}

const workspace = await mkdtemp(join(tmpdir(), "meeting-protobuf-evidence-"));
try {
  const currentImagePath = join(workspace, "current.binpb");
  const bufVersion = await runBuf("--version");
  await runBuf("lint");
  await runBuf("build", "--as-file-descriptor-set", "-o", currentImagePath);
  await runBuf("breaking", "--against", baselineImageUrl.pathname);

  const [bufConfig, currentImage, releasedImage] = await Promise.all([
    readFile(bufConfigUrl),
    readFile(currentImagePath),
    readFile(baselineImageUrl),
  ]);
  const bufConfigDigest = digest(bufConfig);
  const currentDescriptorDigest = digest(currentImage);
  const releasedDescriptorDigest = digest(releasedImage);
  requireEqual(current.bufVersion, bufVersion, "current.bufVersion");
  requireEqual(current.bufConfigDigest, bufConfigDigest, "current.bufConfigDigest");
  requireEqual(
    current.descriptorImageDigest,
    currentDescriptorDigest,
    "current.descriptorImageDigest",
  );
  requireEqual(
    current.descriptorImageDigest,
    releasedDescriptorDigest,
    "released descriptor image",
  );
  requireEqual(current.breaking?.status, "compatible", "current.breaking.status");
  requireEqual(
    current.breaking?.fingerprint,
    breakingFingerprint({
      bufConfigDigest,
      bufVersion,
      currentDescriptorDigest,
      releasedDescriptorDigest,
    }),
    "current.breaking.fingerprint",
  );
  requireEqual(
    current.generationDrift?.expectedGeneratedOutputDigest,
    emptyOutputDigest,
    "expected generated output",
  );
  requireEqual(
    current.generationDrift?.observedGeneratedOutputDigest,
    emptyOutputDigest,
    "observed generated output",
  );
} finally {
  await rm(workspace, { force: true, recursive: true });
}

process.stdout.write("Protobuf evolution evidence passed.\n");
