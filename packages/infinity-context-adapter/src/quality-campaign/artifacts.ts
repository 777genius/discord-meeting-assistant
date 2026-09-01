import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, safeId, sha256 } from "./canonical.js";
import { assertArtifactAttemptIdentity, type ArtifactAad,
  type ArtifactReceipt, type EncryptedArtifactKind } from "./artifact-policy.js";
import { assertAttemptIdentity, type AttemptIdentity } from "./execution.js";

export * from "./artifact-policy.js";

export class CampaignEncryptedArtifactStore {
  private consumedBytes = 0;
  private readonly root: string;
  public constructor(root: string, private readonly maximumCampaignBytes: number) {
    if (!isAbsolute(root) || root.includes("\0") || !Number.isSafeInteger(maximumCampaignBytes) ||
      maximumCampaignBytes < 1) {throw new Error("encrypted artifact store configuration is invalid");}
    this.root = resolve(root);
  }
  public async seal(input: { readonly artifactKind: EncryptedArtifactKind;
    readonly campaignRootSha256: string; readonly identity: AttemptIdentity;
    readonly key: Uint8Array; readonly keyId: string; readonly plaintext: Uint8Array;
    readonly releaseRootSha256: string; readonly spendReservationSha256: string }):
  Promise<ArtifactReceipt> {
    assertAttemptIdentity(input.identity, { campaignRootSha256: input.campaignRootSha256,
      releaseRootSha256: input.releaseRootSha256,
      spendReservationSha256: input.spendReservationSha256 });
    if (!ARTIFACT_KINDS.includes(input.artifactKind) || input.key.byteLength !== 32 ||
      input.plaintext.byteLength < 1) {
      throw new Error("artifact encryption input is invalid");
    }
    assertArtifactAttemptIdentity(input.artifactKind, input.identity);
    safeId(input.keyId, "artifact key ID");
    const plaintextSha256 = createHash("sha256").update(input.plaintext).digest("hex");
    const aad: ArtifactAad = { artifactKind: input.artifactKind,
      attemptId: input.identity.attemptId, callKind: input.identity.callKind,
      callOrdinal: input.identity.callOrdinal, campaignRootSha256: input.campaignRootSha256,
      keyId: input.keyId, plaintextSha256, questionDigestSha256:
      input.identity.questionDigestSha256, questionId: input.identity.questionId,
      releaseRootSha256: input.releaseRootSha256, repetition: input.identity.repetition,
      schemaVersion: "meeting_knowledge.semantic_quality_artifact_aad.v3",
      spendReservationSha256: input.spendReservationSha256 };
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
    cipher.setAAD(Buffer.from(canonicalJson(aad)));
    const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
    const envelope = { aad, algorithm: "A256GCM", ciphertextBase64:
      ciphertext.toString("base64"), nonceBase64: nonce.toString("base64"),
      tagBase64: cipher.getAuthTag().toString("base64") };
    const bytes = Buffer.from(canonicalJson(envelope));
    if (this.consumedBytes + bytes.byteLength > this.maximumCampaignBytes) {
      throw new Error("campaign encrypted byte ceiling exceeded");
    }
    const envelopeSha256 = sha256(bytes);
    await writeCreateOnly(join(this.root, `${envelopeSha256}.enc.json`), bytes);
    this.consumedBytes += bytes.byteLength;
    const aadSha256 = sha256(aad);
    const keyBindingSha256 = sha256({ attemptId: input.identity.attemptId, keyId: input.keyId,
      kind: input.artifactKind, questionId: input.identity.questionId,
      repetition: input.identity.repetition,
      schemaVersion: "meeting_knowledge.semantic_quality_retained_key_binding.v1" });
    const artifactBindingSha256 = sha256({ aadSha256, attemptId: input.identity.attemptId,
      envelopeSha256, keyBindingSha256, keyId: input.keyId, kind: input.artifactKind,
      plaintextSha256, questionId: input.identity.questionId,
      repetition: input.identity.repetition, storedBytes: bytes.byteLength,
      schemaVersion: "meeting_knowledge.semantic_quality_retained_artifact_binding.v1" });
    return Object.freeze({ aadSha256, artifactBindingSha256, artifactKind: input.artifactKind,
      attemptId: input.identity.attemptId, envelopeSha256, keyBindingSha256, keyId: input.keyId,
      plaintextBytes: input.plaintext.byteLength, plaintextSha256,
      questionId: input.identity.questionId, repetition: input.identity.repetition,
      storedBytes: bytes.byteLength });
  }
}

const ARTIFACT_KINDS: readonly EncryptedArtifactKind[] = ["adjudication_input",
  "adjudicator_1_result", "adjudicator_2_result", "answer_request", "answer_response",
  "capability_request", "capability_response", "evidence", "final_adjudication", "raw_outcome",
  "resolver_result", "retrieval_request", "retrieval_response"];

async function writeCreateOnly(path: string, bytes: Uint8Array): Promise<void> {
  await ensureDirectory(dirname(path));
  const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    if (!(await readFile(path)).equals(bytes)) {throw new Error("create-only artifact conflicts");}
    return null;
  });
  if (handle === null) {return;}
  try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
  const directory = await open(dirname(path), "r");
  try {await directory.sync();} finally {await directory.close();}
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await stat(path)).isDirectory()) {throw new Error("durable path is not a directory");}
}
