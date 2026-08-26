import { createPublicKey, verify } from "node:crypto";

import { canonicalJson, digest, exactRecord, publicKeyFingerprintSha256,
  safeId, sha256 } from "./canonical.js";
import type { SignedValue } from "./execution.js";

export const FROZEN_ANSWER_EXECUTION = Object.freeze({
  model: "gpt-5.6-sol",
  reasoning: "xhigh",
  serviceTier: "default",
});

export interface QualityCampaignRelease {
  readonly artifactKeyCustodySha256: string;
  readonly answerImageSha256: string;
  readonly answerProcessIdentitySha256: string;
  readonly answerReleaseSha256: string;
  readonly discordCommitSha256: string;
  readonly discordImageSha256: string;
  readonly discordReleaseSha256: string;
  readonly infinityCapabilitySha256: string;
  readonly infinityCommitSha256: string;
  readonly infinityImageSha256: string;
  readonly infinityProfileSha256: string;
  readonly infinityReleaseSha256: string;
  readonly mapperSha256: string;
  readonly model: "gpt-5.6-sol";
  readonly policySha256: string;
  readonly promptSha256: string;
  readonly reasoning: "xhigh";
  readonly sdkArchiveSha256: string;
  readonly serviceTier: "default";
  readonly tokenizerSha256: string;
  readonly targetInventoryAuthorityKeySha256: string;
}

export interface PinnedReleaseDocument {
  readonly authorityKeyId: string;
  readonly authorityPublicKeyPem: string;
  readonly document: unknown;
  readonly releaseRootSha256: string;
}

export interface VerifiedReleaseDocument {
  readonly authorityKeyFingerprintSha256: string;
  readonly authorityKeyId: string;
  readonly document: SignedValue<QualityCampaignRelease>;
  readonly release: QualityCampaignRelease;
  readonly releaseRootSha256: string;
}

export function assertObservedRelease(expected: QualityCampaignRelease,
  observed: QualityCampaignRelease): void {
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    throw new Error("observed release, image, SDK, tokenizer, prompt, mapper, or policy drifted");
  }
}

export function verifyReleaseRoot(input: { readonly authorityKeyId: string;
  readonly authorityPublicKeyPem: string; readonly document: unknown }): VerifiedReleaseDocument {
  const document = exactRecord(input.document, ["payload", "signatureBase64", "signerKeyId"],
    "release root");
  safeId(input.authorityKeyId, "release authority key ID");
  if (document.signerKeyId !== input.authorityKeyId ||
    typeof document.signatureBase64 !== "string") {
    throw new Error("release root signer is invalid");
  }
  let valid = false;
  try {valid = verify(null, Buffer.from(canonicalJson(document.payload)),
    createPublicKey(input.authorityPublicKeyPem), Buffer.from(document.signatureBase64, "base64"));}
  catch {valid = false;}
  if (!valid) {throw new Error("release root signature is invalid");}
  const keys = ["answerImageSha256", "answerProcessIdentitySha256", "answerReleaseSha256",
    "artifactKeyCustodySha256",
    "discordCommitSha256", "discordImageSha256", "discordReleaseSha256",
    "infinityCapabilitySha256", "infinityCommitSha256", "infinityImageSha256",
    "infinityProfileSha256", "infinityReleaseSha256", "mapperSha256", "model",
    "policySha256", "promptSha256", "reasoning", "sdkArchiveSha256", "serviceTier",
    "targetInventoryAuthorityKeySha256", "tokenizerSha256"];
  const record = exactRecord(document.payload, keys, "release binding");
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith("Sha256")) {digest(value, key);}
  }
  if (record.model !== FROZEN_ANSWER_EXECUTION.model ||
    record.reasoning !== FROZEN_ANSWER_EXECUTION.reasoning ||
    record.serviceTier !== FROZEN_ANSWER_EXECUTION.serviceTier) {
    throw new Error("answer execution is not frozen to gpt-5.6-sol/xhigh/default");
  }
  return Object.freeze({ authorityKeyFingerprintSha256:
    publicKeyFingerprintSha256(input.authorityPublicKeyPem, "release authority"),
  authorityKeyId: input.authorityKeyId,
  document: Object.freeze(document as unknown as SignedValue<QualityCampaignRelease>),
  release: Object.freeze(record as unknown as QualityCampaignRelease),
  releaseRootSha256: sha256(document) });
}

export function verifyPinnedReleaseDocument(input: PinnedReleaseDocument):
VerifiedReleaseDocument {
  const verified = verifyReleaseRoot(input);
  if (verified.releaseRootSha256 !== digest(input.releaseRootSha256,
    "pinned release root")) {
    throw new Error("verified release document is not the pinned release root");
  }
  return verified;
}
