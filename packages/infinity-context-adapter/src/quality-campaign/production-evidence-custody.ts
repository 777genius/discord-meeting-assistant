import { createDecipheriv } from "node:crypto";

import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { verifyExternalSignedValue } from "./execution.js";
import type { ExactCampaignEvidence } from "./production-evidence.js";
import type { CampaignEvidenceCustodyPort, RawAuthenticatedEvidence } from
  "./production-ports.js";
import type { RetainedArtifact } from "./retention.js";

interface EvidenceReceiptPayload {
  readonly attemptInventorySha256: string;
  readonly campaignRootSha256: string;
  readonly envelopeSha256: string;
  readonly evidenceKind: "holdout" | "main";
  readonly keyId: string;
  readonly plaintextSha256: string;
  readonly releaseRootSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_evidence_receipt.v1";
  readonly terminalState: "complete";
}

/** Adapter-owned AES-256-GCM custody. Plain evidence exists only after receipt and exact AAD pass. */
export function createLocalEvidenceCustody(input: { readonly authority: {
  readonly keyId: string; readonly publicKeyPem: string }; readonly key: Uint8Array;
  readonly keyId: string }): CampaignEvidenceCustodyPort {
  if (input.key.byteLength !== 32) {throw new Error("evidence custody requires an AES-256 key");}
  safeId(input.keyId, "evidence custody key ID");
  return Object.freeze({ open: async (request: Parameters<CampaignEvidenceCustodyPort["open"]>[0]) => {
    const receipt = verifyExternalSignedValue<EvidenceReceiptPayload>(request.delivery.signedReceipt,
      input.authority.keyId, input.authority.publicKeyPem, "authenticated evidence receipt");
    const payload = decodeReceipt(receipt.payload);
    const expectedAttempts = sha256([...request.attemptIds].toSorted());
    const envelopeSha256 = sha256(request.delivery.envelopeBytes);
    if (payload.attemptInventorySha256 !== expectedAttempts || payload.campaignRootSha256 !==
      request.campaignRootSha256 || payload.envelopeSha256 !== envelopeSha256 ||
      payload.evidenceKind !== request.kind || payload.keyId !== input.keyId ||
      payload.releaseRootSha256 !== request.releaseRootSha256) {
      throw new Error("evidence receipt is foreign to campaign, attempts, release, or custody");
    }
    const plaintext = openEnvelope(request.delivery, input.key, payload);
    const decoded = decodeEvidence(JSON.parse(plaintext.toString("utf8")) as unknown);
    for (const artifact of decoded.artifacts) {
      openRetainedArtifact(artifact, input.key, request.campaignRootSha256,
        request.releaseRootSha256, input.keyId);
    }
    return Object.freeze(decoded);
  } });
}

function decodeReceipt(value: unknown): EvidenceReceiptPayload {
  const record = exactRecord(value, ["attemptInventorySha256", "campaignRootSha256",
    "envelopeSha256", "evidenceKind", "keyId", "plaintextSha256", "releaseRootSha256",
    "schemaVersion", "terminalState"], "authenticated evidence receipt payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_evidence_receipt.v1" ||
    record.terminalState !== "complete" || typeof record.evidenceKind !== "string" ||
    !["holdout", "main"].includes(record.evidenceKind)) {
    throw new Error("authenticated evidence receipt is not terminal");
  }
  for (const receiptDigest of [record.attemptInventorySha256, record.campaignRootSha256,
    record.envelopeSha256, record.plaintextSha256, record.releaseRootSha256]) {
    digest(receiptDigest, "evidence receipt digest");
  }
  safeId(record.keyId, "evidence receipt key");
  return record as unknown as EvidenceReceiptPayload;
}

function openEnvelope(delivery: RawAuthenticatedEvidence, key: Uint8Array,
  receipt: EvidenceReceiptPayload): Buffer {
  const envelope = decodeEnvelope(JSON.parse(Buffer.from(delivery.envelopeBytes).toString("utf8")));
  const expectedAad = { attemptInventorySha256: receipt.attemptInventorySha256,
    campaignRootSha256: receipt.campaignRootSha256, evidenceKind: receipt.evidenceKind,
    keyId: receipt.keyId, plaintextSha256: receipt.plaintextSha256,
    releaseRootSha256: receipt.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_evidence_aad.v1" };
  if (canonicalJson(envelope.aad) !== canonicalJson(expectedAad)) {
    throw new Error("evidence envelope AAD is not exact");
  }
  const plaintext = decrypt(envelope, key, expectedAad);
  if (sha256(plaintext) !== receipt.plaintextSha256) {
    throw new Error("evidence plaintext digest is invalid");
  }
  return plaintext;
}

function openRetainedArtifact(artifact: RetainedArtifact, key: Uint8Array, campaignRootSha256: string,
  releaseRootSha256: string, keyId: string): void {
  const bytes = Buffer.from(artifact.envelopeBase64, "base64");
  if (bytes.byteLength !== artifact.storedBytes || sha256(bytes) !== artifact.envelopeSha256 ||
    artifact.campaignRootSha256 !== campaignRootSha256 || artifact.releaseRootSha256 !==
    releaseRootSha256 || artifact.keyId !== keyId) {
    throw new Error("retained artifact bytes or custody identity are substituted");
  }
  const envelope = decodeEnvelope(JSON.parse(bytes.toString("utf8")) as unknown);
  const expectedAad = { artifactCallKind: artifact.artifactCallKind,
    artifactCallOrdinal: artifact.artifactCallOrdinal, artifactKind: artifact.kind,
    attemptId: artifact.attemptId, campaignRootSha256, keyId, plaintextSha256:
    artifact.plaintextSha256, questionDigestSha256: artifact.questionDigestSha256,
    questionId: artifact.questionId, releaseRootSha256, repetition: artifact.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_retained_artifact_aad.v1" };
  if (canonicalJson(envelope.aad) !== canonicalJson(expectedAad)) {
    throw new Error("retained artifact AAD is not exact");
  }
  const plaintext = decrypt(envelope, key, expectedAad);
  if (sha256(plaintext) !== artifact.plaintextSha256) {
    throw new Error("retained artifact plaintext digest is invalid");
  }
}

function decodeEnvelope(value: unknown): { readonly aad: unknown; readonly algorithm: "A256GCM";
  readonly ciphertextBase64: string; readonly nonceBase64: string; readonly tagBase64: string } {
  const record = exactRecord(value, ["aad", "algorithm", "ciphertextBase64", "nonceBase64",
    "tagBase64"], "AES-256-GCM evidence envelope");
  if (record.algorithm !== "A256GCM" || ![record.ciphertextBase64, record.nonceBase64,
    record.tagBase64].every((encoded) => typeof encoded === "string")) {
    throw new Error("evidence envelope algorithm or encoding is invalid");
  }
  return record as ReturnType<typeof decodeEnvelope>;
}

function decrypt(envelope: ReturnType<typeof decodeEnvelope>, key: Uint8Array, aad: unknown): Buffer {
  try {
    const nonce = Buffer.from(envelope.nonceBase64, "base64");
    const tag = Buffer.from(envelope.tagBase64, "base64");
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) {throw new Error("invalid GCM sizes");}
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(canonicalJson(aad))); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertextBase64, "base64")),
      decipher.final()]);
  } catch {throw new Error("AES-256-GCM evidence authentication failed");}
}

function decodeEvidence(value: unknown): ExactCampaignEvidence {
  const record = exactRecord(value, ["adjudications", "artifacts", "campaignByteCeiling",
    "outcomes"], "decrypted exact campaign evidence");
  if (!Array.isArray(record.adjudications) || !Array.isArray(record.artifacts) ||
    !Array.isArray(record.outcomes) || !Number.isSafeInteger(record.campaignByteCeiling) ||
    (record.campaignByteCeiling as number) < 1) {
    throw new Error("decrypted exact campaign evidence is structurally invalid");
  }
  return record as unknown as ExactCampaignEvidence;
}
