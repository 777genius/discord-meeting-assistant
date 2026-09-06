import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { indexSchema, planSchema, type OssPlan } from "./oss-campaign-profile.js";

export function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}
export async function readRegular(path: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireEvidence(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, "Invalid artifact size/type");
    const bytes = await handle.readFile();
    requireEvidence(bytes.length === stat.size, "Artifact changed while reading");
    return bytes;
  } finally { await handle.close(); }
}
export type Artifact = ReturnType<typeof indexSchema.parse>["artifacts"][number];
export interface Archive {
  readonly plan: OssPlan;
  readonly planSha256: string;
  readonly indexSha256: string;
  readonly index: ReturnType<typeof indexSchema.parse>;
  bytes(path: string, system?: Artifact["source"]["system"]): Buffer;
  artifact(path: string): Artifact;
  json(path: string, system?: Artifact["source"]["system"]): unknown;
}
export async function loadArchive(planPath: string, rootPath: string): Promise<Archive> {
  const planBytes = await readRegular(planPath);
  const plan = planSchema.parse(JSON.parse(planBytes.toString("utf8")));
  const root = await realpath(rootPath);
  const read = async (path: string, size?: number): Promise<Buffer> => {
    const full = resolve(root, path);
    requireEvidence(full.startsWith(`${root}${sep}`) && await realpath(full) === full,
      "Artifact escape or symlink");
    return readRegular(full, size);
  };
  const indexBytes = await read("collection.json");
  const signature = await read("collection.sig", 64);
  const key = createPublicKey(plan.collectorPublicKeyPem);
  requireEvidence(key.asymmetricKeyType === "ed25519" && signature.length === 64 &&
    verify(null, indexBytes, key, signature), "Invalid independent collector signature");
  const index = indexSchema.parse(JSON.parse(indexBytes.toString("utf8")));
  const planSha256 = sha256(planBytes);
  requireEvidence(index.planSha256 === planSha256 && index.collectorRevision === plan.collectorRevision,
    "Collection plan/source identity mismatch");
  const artifacts = new Map<string, Artifact>();
  const contents = new Map<string, Buffer>();
  const sources = new Set<string>();
  let total = 0;
  for (const artifact of index.artifacts) {
    const sourceKey = JSON.stringify(artifact.source);
    requireEvidence(!artifacts.has(artifact.path) && !sources.has(sourceKey) &&
      !["collection.json", "collection.sig"].includes(artifact.path), "Duplicate artifact/source identity");
    total += artifact.size;
    requireEvidence(total <= 1024 * 1024 * 1024, "Archive exceeds 1 GiB bound");
    const bytes = await read(artifact.path, artifact.size);
    requireEvidence(bytes.length === artifact.size && sha256(bytes) === artifact.sha256,
      `Artifact checksum mismatch: ${artifact.path}`);
    artifacts.set(artifact.path, artifact);
    contents.set(artifact.path, bytes);
    sources.add(sourceKey);
  }
  const artifact = (path: string): Artifact => {
    const found = artifacts.get(path);
    requireEvidence(found !== undefined, `Missing retained artifact: ${path}`);
    return found;
  };
  const bytes = (path: string, system?: Artifact["source"]["system"]): Buffer => {
    requireEvidence(system === undefined || artifact(path).source.system === system, "Source role mismatch");
    const found = contents.get(path);
    requireEvidence(found !== undefined, `Missing retained bytes: ${path}`);
    return found;
  };
  return { plan, planSha256, index, indexSha256: sha256(indexBytes), artifact, bytes,
    json: (path, system) => JSON.parse(bytes(path, system).toString("utf8")) as unknown };
}

// The temporary filename is deterministic: concurrent or interrupted writers fail closed.
export async function createReceipt(path: string, receipt: unknown): Promise<void> {
  const temporary = `${path}.pending`;
  const handle = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
