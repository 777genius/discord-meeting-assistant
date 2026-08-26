import { createPublicKey, verify } from "node:crypto";

import { canonicalJson, digest, exactRecord, publicKeyFingerprintSha256,
  safeId, sha256 } from "./canonical.js";
import type { SignedValue } from "./execution.js";

export const FROZEN_ANSWER_EXECUTION = Object.freeze({
  model: "gpt-5.6-sol",
  reasoning: "xhigh",
  serviceTier: "default",
});

export const QUALITY_AUTHORITY_ROLES = Object.freeze(["artifact_custody", "cleanup",
  "holdout_authorization", "holdout_provider_result", "holdout_question", "inventory", "locator",
  "main_proof", "provider_result", "release", "repetition", "resolver", "reviewer_1", "reviewer_2",
  "spend"] as const);
export type QualityAuthorityRole = typeof QUALITY_AUTHORITY_ROLES[number];

export interface TrustedAuthorityPin {
  readonly keyId: string;
  readonly publicKeyFingerprintSha256: string;
  readonly publicKeyPem: string;
}

/** Operator/composition-owned trust roots. Effect requests contain key references, never keys. */
export class QualityCampaignAuthorityPolicy {
  public readonly bindingSha256: string;
  private readonly pins: Readonly<Record<QualityAuthorityRole, TrustedAuthorityPin>>;

  public constructor(input: Readonly<Record<QualityAuthorityRole, TrustedAuthorityPin>>) {
    const record = exactRecord(input, QUALITY_AUTHORITY_ROLES, "quality authority policy");
    const pins = Object.fromEntries(QUALITY_AUTHORITY_ROLES.map((role) => {
      const pin = exactRecord(record[role], ["keyId", "publicKeyFingerprintSha256",
        "publicKeyPem"], `${role} authority pin`);
      const keyId = safeId(pin.keyId, `${role} authority key ID`);
      if (typeof pin.publicKeyPem !== "string") {
        throw new Error(`${role} authority public key is invalid`);
      }
      const fingerprint = publicKeyFingerprintSha256(pin.publicKeyPem, `${role} authority`);
      if (fingerprint !== digest(pin.publicKeyFingerprintSha256,
        `${role} authority fingerprint`)) {
        throw new Error(`${role} authority fingerprint does not match its trusted key`);
      }
      return [role, Object.freeze({ keyId, publicKeyFingerprintSha256: fingerprint,
        publicKeyPem: pin.publicKeyPem })];
    })) as unknown as Record<QualityAuthorityRole, TrustedAuthorityPin>;
    const keyIds = QUALITY_AUTHORITY_ROLES.map((role) => pins[role].keyId);
    const fingerprints = QUALITY_AUTHORITY_ROLES.map((role) =>
      pins[role].publicKeyFingerprintSha256);
    if (new Set(keyIds).size !== keyIds.length ||
      new Set(fingerprints).size !== fingerprints.length) {
      throw new Error("quality authority roles are not cryptographically separated");
    }
    this.pins = Object.freeze(pins);
    this.bindingSha256 = sha256(QUALITY_AUTHORITY_ROLES.map((role) => ({ keyId:
      pins[role].keyId, publicKeyFingerprintSha256: pins[role].publicKeyFingerprintSha256,
    role })));
    Object.freeze(this);
  }

  public authority(role: QualityAuthorityRole): TrustedAuthorityPin {
    return this.pins[role];
  }

  public assertReference(role: QualityAuthorityRole, keyId: unknown): TrustedAuthorityPin {
    const pin = this.pins[role];
    if (keyId !== pin.keyId) {throw new Error(`${role} authority reference is not trusted`);}
    return pin;
  }
}

export interface QualityCampaignRelease {
  readonly authorityPolicySha256: string;
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

export function verifyReleaseRoot(policy: QualityCampaignAuthorityPolicy, input: {
  readonly authorityKeyId: string; readonly document: unknown }): VerifiedReleaseDocument {
  const authority = policy.assertReference("release", input.authorityKeyId);
  const document = exactRecord(input.document, ["payload", "signatureBase64", "signerKeyId"],
    "release root");
  safeId(input.authorityKeyId, "release authority key ID");
  if (document.signerKeyId !== input.authorityKeyId ||
    typeof document.signatureBase64 !== "string") {
    throw new Error("release root signer is invalid");
  }
  let valid = false;
  try {valid = verify(null, Buffer.from(canonicalJson(document.payload)),
    createPublicKey(authority.publicKeyPem), Buffer.from(document.signatureBase64, "base64"));}
  catch {valid = false;}
  if (!valid) {throw new Error("release root signature is invalid");}
  const keys = ["answerImageSha256", "answerProcessIdentitySha256", "answerReleaseSha256",
    "authorityPolicySha256",
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
  if (record.authorityPolicySha256 !== policy.bindingSha256 ||
    record.targetInventoryAuthorityKeySha256 !==
      policy.authority("inventory").publicKeyFingerprintSha256 ||
    record.artifactKeyCustodySha256 !==
      policy.authority("artifact_custody").publicKeyFingerprintSha256) {
    throw new Error("release does not bind the trusted quality authority policy");
  }
  return Object.freeze({ authorityKeyFingerprintSha256:
    authority.publicKeyFingerprintSha256,
  authorityKeyId: input.authorityKeyId,
  document: Object.freeze(document as unknown as SignedValue<QualityCampaignRelease>),
  release: Object.freeze(record as unknown as QualityCampaignRelease),
  releaseRootSha256: sha256(document) });
}

export function verifyPinnedReleaseDocument(policy: QualityCampaignAuthorityPolicy,
  input: PinnedReleaseDocument):
VerifiedReleaseDocument {
  const verified = verifyReleaseRoot(policy, input);
  if (verified.releaseRootSha256 !== digest(input.releaseRootSha256,
    "pinned release root")) {
    throw new Error("verified release document is not the pinned release root");
  }
  return verified;
}
