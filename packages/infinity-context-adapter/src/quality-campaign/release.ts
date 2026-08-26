import { createPublicKey, verify } from "node:crypto";

import { canonicalJson, digest, exactRecord, sha256 } from "./canonical.js";

export const FROZEN_ANSWER_EXECUTION = Object.freeze({
  model: "gpt-5.6-sol",
  reasoning: "xhigh",
  serviceTier: "default",
});

export interface QualityCampaignRelease {
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
}

export function verifyReleaseRoot(input: { readonly authorityPublicKeyPem: string;
  readonly document: unknown }): { readonly release: QualityCampaignRelease;
    readonly releaseRootSha256: string } {
  const document = exactRecord(input.document, ["payload", "signatureBase64", "signerKeyId"],
    "release root");
  if (typeof document.signerKeyId !== "string" || typeof document.signatureBase64 !== "string") {
    throw new Error("release root signer is invalid");
  }
  let valid = false;
  try {valid = verify(null, Buffer.from(canonicalJson(document.payload)),
    createPublicKey(input.authorityPublicKeyPem), Buffer.from(document.signatureBase64, "base64"));}
  catch {valid = false;}
  if (!valid) {throw new Error("release root signature is invalid");}
  const keys = ["answerImageSha256", "answerProcessIdentitySha256", "answerReleaseSha256",
    "discordCommitSha256", "discordImageSha256", "discordReleaseSha256",
    "infinityCapabilitySha256", "infinityCommitSha256", "infinityImageSha256",
    "infinityProfileSha256", "infinityReleaseSha256", "mapperSha256", "model",
    "policySha256", "promptSha256", "reasoning", "sdkArchiveSha256", "serviceTier",
    "tokenizerSha256"];
  const release = exactRecord(document.payload, keys, "release binding") as unknown as
    QualityCampaignRelease;
  for (const [key, value] of Object.entries(release)) {
    if (key.endsWith("Sha256")) {digest(value, key);}
  }
  if (release.model !== FROZEN_ANSWER_EXECUTION.model ||
    release.reasoning !== FROZEN_ANSWER_EXECUTION.reasoning ||
    release.serviceTier !== FROZEN_ANSWER_EXECUTION.serviceTier) {
    throw new Error("answer execution is not frozen to gpt-5.6-sol/xhigh/default");
  }
  return Object.freeze({ release, releaseRootSha256: sha256(document) });
}
