import { createPublicKey, verify } from "node:crypto";

import { canonicalIntegerJson, canonicalSha256 } from "./semantic-quality-v4-manifest.js";

export type SemanticQualityV4ReceiptRole =
  | "artifact_retention"
  | "claim_citation_adjudication"
  | "claim_citation_conflict_resolution"
  | "derived_cleanup"
  | "execution_observation"
  | "per_question_adjudication"
  | "question_rubric_review"
  | "service_execution_attestation";

export interface SemanticQualityV4PinnedReviewerKey {
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly roles: readonly SemanticQualityV4ReceiptRole[];
}

export interface SemanticQualityV4SignedReceipt {
  readonly binding: Readonly<Record<string, string | number>>;
  readonly decisionDigestSha256: string;
  readonly receiptId: string;
  readonly reviewerKeyId: string;
  readonly role: SemanticQualityV4ReceiptRole;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_review_receipt.v1";
  readonly signatureBase64: string;
}

export interface VerifiedSemanticQualityV4Receipt {
  readonly digestSha256: string;
  readonly receipt: SemanticQualityV4SignedReceipt;
}

export interface SemanticQualityV4ExecutionObservationBinding {
  readonly artifactBindingSha256: string;
  readonly campaignRunId: string;
  readonly endpointIdentitySha256: string;
  readonly infinityServiceIdentitySha256: string;
  readonly infinityServiceProcessIdentitySha256: string;
  readonly modelIdentitySha256: string;
  readonly processIdentitySha256: string;
  readonly promptMapperSha256: string;
  readonly providerOrdinalContractSha256: string;
  readonly runtimeServiceIdentitySha256: string;
  readonly runtimeServiceProcessIdentitySha256: string;
  readonly stableAttemptId: string;
  readonly tokenizerSha256: string;
}

const digestPattern = /^[a-f0-9]{64}$/u;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export interface SemanticQualityV4ReleaseArtifactBinding {
  readonly answerModelConfigurationSha256: string;
  readonly answerPolicySha256: string;
  readonly discordSourceCommit: string;
  readonly discordSourceTree: string;
  readonly discordRuntimeModuleSha256: string;
  readonly infinityServiceImageSha256: string;
  readonly infinitySourceCommit: string;
  readonly infinitySourceTree: string;
  readonly promptMapperSha256: string;
  readonly reviewerKeyRegistrySha256: string;
  readonly runtimeArtifactSha256: string;
  readonly runtimeLauncherSha256: string;
  readonly sdkPackageSha256: string;
  readonly sdkPackageSriSha512: string;
  readonly tokenizerSha256: string;
  readonly verifierModuleSetSha256: string;
}

export interface SemanticQualityV4VerifiedTrustAnchor {
  readonly artifactBinding: SemanticQualityV4ReleaseArtifactBinding;
  readonly anchorSha256: string;
  readonly reviewerKeys: readonly SemanticQualityV4PinnedReviewerKey[];
}

export function assertSemanticQualityV4ObservedArtifactBinding(
  anchor: SemanticQualityV4VerifiedTrustAnchor,
  observed: SemanticQualityV4ReleaseArtifactBinding,
): void {
  if (canonicalIntegerJson(observed) !== canonicalIntegerJson(anchor.artifactBinding)) {
    throw new Error("semantic quality V4 observed artifacts differ from independent trust anchor");
  }
}

/** Verifies the independently pinned root before accepting any operator-selected path or key. */
export function verifySemanticQualityV4ReleaseTrustAnchor(
  value: unknown,
  externalRootPublicKeyPem: string,
): SemanticQualityV4VerifiedTrustAnchor {
  const record = exactRecord(value, ["artifactBinding", "reviewerKeys", "schemaVersion",
    "signatureBase64"]);
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_release_trust_anchor.v1" ||
    !Array.isArray(record.reviewerKeys) || typeof record.signatureBase64 !== "string") {
    throw new Error("semantic quality V4 release trust anchor schema is invalid");
  }
  const reviewerKeys = record.reviewerKeys as unknown as readonly SemanticQualityV4PinnedReviewerKey[];
  assertPinnedKeyRegistry(reviewerKeys);
  const artifactBinding = exactStringIntegerRecord(record.artifactBinding) as unknown as
    SemanticQualityV4ReleaseArtifactBinding;
  const expectedKeys = ["answerModelConfigurationSha256", "answerPolicySha256",
    "discordRuntimeModuleSha256", "discordSourceCommit", "discordSourceTree",
    "infinityServiceImageSha256",
    "infinitySourceCommit", "infinitySourceTree", "promptMapperSha256",
    "reviewerKeyRegistrySha256", "runtimeArtifactSha256", "runtimeLauncherSha256",
    "sdkPackageSha256", "sdkPackageSriSha512", "tokenizerSha256",
    "verifierModuleSetSha256"];
  if (canonicalIntegerJson(Object.keys(artifactBinding).toSorted()) !==
      canonicalIntegerJson(expectedKeys) || artifactBinding.reviewerKeyRegistrySha256 !==
      semanticQualityV4ReviewerKeyRegistrySha256(reviewerKeys)) {
    throw new Error("semantic quality V4 release trust anchor binding is invalid");
  }
  const unsigned = { artifactBinding, reviewerKeys, schemaVersion: record.schemaVersion };
  let valid = false;
  try {
    const externalRoot = createPublicKey(externalRootPublicKeyPem);
    if (externalRoot.asymmetricKeyType !== "ed25519") {
      throw new Error("semantic quality V4 external release root is not Ed25519");
    }
    valid = verify(null, new TextEncoder().encode(canonicalIntegerJson(unsigned)),
      externalRoot, Buffer.from(record.signatureBase64, "base64"));
  } catch {valid = false;}
  if (!valid) {throw new Error("semantic quality V4 release trust anchor signature is invalid");}
  return Object.freeze({ artifactBinding, anchorSha256: canonicalSha256(record),
    reviewerKeys: Object.freeze([...reviewerKeys]) });
}

export function semanticQualityV4ReceiptSigningBytes(
  receipt: Omit<SemanticQualityV4SignedReceipt, "signatureBase64">,
): Uint8Array {
  return new TextEncoder().encode(canonicalIntegerJson(receipt));
}

export function verifySemanticQualityV4Receipt(
  value: unknown,
  pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[],
): VerifiedSemanticQualityV4Receipt {
  assertPinnedKeyRegistry(pinnedKeys);
  const receipt = decodeReceipt(value);
  const key = pinnedKeys.find(({ keyId }) => keyId === receipt.reviewerKeyId);
  if (key === undefined || !key.roles.includes(receipt.role)) {
    throw new Error("semantic quality V4 receipt reviewer is not pinned for this role");
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(receipt.signatureBase64, "base64");
  } catch {
    throw new Error("semantic quality V4 receipt signature encoding is invalid");
  }
  const { signatureBase64: _signature, ...unsigned } = receipt;
  let valid = false;
  try {
    valid = signature.length === 64 && verify(
      null,
      semanticQualityV4ReceiptSigningBytes(unsigned),
      createPublicKey(key.publicKeyPem),
      signature,
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new Error("semantic quality V4 receipt signature is invalid");
  }
  return Object.freeze({ digestSha256: canonicalSha256(receipt), receipt });
}

export function semanticQualityV4ReviewerKeyRegistrySha256(
  pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[],
): string {
  assertPinnedKeyRegistry(pinnedKeys);
  return canonicalSha256(pinnedKeys.map((key) => ({ keyId: key.keyId,
    publicKeyDerBase64: createPublicKey(key.publicKeyPem)
      .export({ format: "der", type: "spki" }).toString("base64"),
    roles: [...key.roles].toSorted() })).toSorted((left, right) =>
    left.keyId.localeCompare(right.keyId)));
}

export function requireIndependentSemanticQualityV4Receipts(input: {
  readonly binding: Readonly<Record<string, string | number>>;
  readonly minimum: number;
  readonly pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[];
  readonly receipts: readonly unknown[];
  readonly role: SemanticQualityV4ReceiptRole;
}): readonly VerifiedSemanticQualityV4Receipt[] {
  const expectedBinding = canonicalIntegerJson(input.binding);
  const verified = input.receipts.map((receipt) =>
    verifySemanticQualityV4Receipt(receipt, input.pinnedKeys));
  if (
    verified.length < input.minimum ||
    new Set(verified.map(({ receipt }) => receipt.reviewerKeyId)).size !== verified.length ||
    new Set(verified.map(({ receipt }) => receipt.receiptId)).size !== verified.length ||
    verified.some(({ receipt }) => receipt.role !== input.role ||
      canonicalIntegerJson(receipt.binding) !== expectedBinding)
  ) {
    throw new Error("semantic quality V4 receipts are not independent exact-binding receipts");
  }
  return Object.freeze(verified);
}

/**
 * Verifies one externally observed, current-process execution receipt. Remote
 * process identities are reviewer-observed values; every locally measurable
 * field must equal the running verifier before the receipt can be admitted.
 */
export function requireSemanticQualityV4ExecutionObservation(input: {
  readonly expected: Omit<SemanticQualityV4ExecutionObservationBinding,
    "infinityServiceIdentitySha256" | "infinityServiceProcessIdentitySha256" |
    "runtimeServiceIdentitySha256" | "runtimeServiceProcessIdentitySha256">;
  readonly pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[];
  readonly receipt: unknown;
}): VerifiedSemanticQualityV4Receipt {
  const verified = verifySemanticQualityV4Receipt(input.receipt, input.pinnedKeys);
  const binding = verified.receipt.binding as unknown as
    SemanticQualityV4ExecutionObservationBinding;
  const expectedKeys = ["artifactBindingSha256", "campaignRunId", "endpointIdentitySha256",
    "infinityServiceIdentitySha256", "infinityServiceProcessIdentitySha256",
    "modelIdentitySha256", "processIdentitySha256", "promptMapperSha256",
    "providerOrdinalContractSha256", "runtimeServiceIdentitySha256",
    "runtimeServiceProcessIdentitySha256", "stableAttemptId", "tokenizerSha256"];
  if (verified.receipt.role !== "execution_observation" ||
    canonicalIntegerJson(Object.keys(binding).toSorted()) !== canonicalIntegerJson(expectedKeys) ||
    Object.entries(input.expected).some(([key, value]) =>
      binding[key as keyof SemanticQualityV4ExecutionObservationBinding] !== value) ||
    [binding.infinityServiceIdentitySha256, binding.infinityServiceProcessIdentitySha256,
      binding.runtimeServiceIdentitySha256, binding.runtimeServiceProcessIdentitySha256]
      .some((value) => !validBoundDigest(value))) {
    throw new Error("semantic quality V4 execution observation is not current-process bound");
  }
  return verified;
}

export function requireSemanticQualityV4ServiceExecutionAttestation(input: {
  readonly binding: Readonly<Record<string, string | number>>;
  readonly pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[];
  readonly receipt: unknown;
}): VerifiedSemanticQualityV4Receipt {
  return requireIndependentSemanticQualityV4Receipts({ binding: input.binding, minimum: 1,
    pinnedKeys: input.pinnedKeys, receipts: [input.receipt],
    role: "service_execution_attestation" })[0]!;
}

export function requireSemanticQualityV4AdjudicationReceipts(input: {
  readonly binding: Readonly<Record<string, string | number>>;
  readonly conflictReceipt?: unknown;
  readonly pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[];
  readonly receipts: readonly unknown[];
}): readonly VerifiedSemanticQualityV4Receipt[] {
  const reviews = requireIndependentSemanticQualityV4Receipts({
    ...input,
    minimum: 2,
    role: "claim_citation_adjudication",
  });
  const decisions = new Set(reviews.map(({ receipt }) => receipt.decisionDigestSha256));
  if (decisions.size === 1) {
    if (input.conflictReceipt !== undefined) {
      throw new Error("semantic quality V4 conflict receipt is not applicable");
    }
    return reviews;
  }
  if (input.conflictReceipt === undefined) {
    throw new Error("semantic quality V4 conflicting reviews require resolution");
  }
  const resolution = requireIndependentSemanticQualityV4Receipts({
    binding: input.binding,
    minimum: 1,
    pinnedKeys: input.pinnedKeys,
    receipts: [input.conflictReceipt],
    role: "claim_citation_conflict_resolution",
  })[0]!;
  if (reviews.some(({ receipt }) => receipt.reviewerKeyId ===
      resolution.receipt.reviewerKeyId)) {
    throw new Error("semantic quality V4 conflict reviewer must be independent");
  }
  return Object.freeze([...reviews, resolution]);
}

function decodeReceipt(value: unknown): SemanticQualityV4SignedReceipt {
  const record = exactRecord(value, ["binding", "decisionDigestSha256", "receiptId",
    "reviewerKeyId", "role", "schemaVersion", "signatureBase64"]);
  const binding = exactStringIntegerRecord(record.binding);
  if (
    record.schemaVersion !== "meeting_knowledge.semantic_quality_review_receipt.v1" ||
    !isRole(record.role) ||
    typeof record.receiptId !== "string" || !safeIdPattern.test(record.receiptId) ||
    typeof record.reviewerKeyId !== "string" || !safeIdPattern.test(record.reviewerKeyId) ||
    typeof record.decisionDigestSha256 !== "string" ||
      !validBoundDigest(record.decisionDigestSha256) ||
    typeof record.signatureBase64 !== "string" || record.signatureBase64.length < 80 ||
    Object.keys(binding).length === 0
  ) {
    throw new Error("semantic quality V4 receipt schema is invalid");
  }
  return Object.freeze({
    binding: Object.freeze(binding),
    decisionDigestSha256: record.decisionDigestSha256,
    receiptId: record.receiptId,
    reviewerKeyId: record.reviewerKeyId,
    role: record.role,
    schemaVersion: record.schemaVersion,
    signatureBase64: record.signatureBase64,
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonicalIntegerJson(Object.keys(value).toSorted()) !==
      canonicalIntegerJson([...keys].toSorted())) {
    throw new Error("semantic quality V4 receipt schema is invalid");
  }
  return value as Record<string, unknown>;
}

function exactStringIntegerRecord(value: unknown): Record<string, string | number> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("semantic quality V4 receipt binding is invalid");
  }
  const record = value as Record<string, unknown>;
  const output: Record<string, string | number> = {};
  for (const key of Object.keys(record).toSorted()) {
    const item = record[key];
    if (!safeIdPattern.test(key) ||
      !(typeof item === "string" || (typeof item === "number" &&
        Number.isSafeInteger(item)))) {
      throw new Error("semantic quality V4 receipt binding is invalid");
    }
    output[key] = item;
  }
  return output;
}

function isRole(value: unknown): value is SemanticQualityV4ReceiptRole {
  return value === "artifact_retention" || value === "claim_citation_adjudication" ||
    value === "claim_citation_conflict_resolution" ||
    value === "derived_cleanup" ||
    value === "execution_observation" ||
    value === "per_question_adjudication" ||
    value === "question_rubric_review" || value === "service_execution_attestation";
}

function assertPinnedKeyRegistry(keys: readonly SemanticQualityV4PinnedReviewerKey[]): void {
  const keyIds = new Set<string>();
  const publicKeys = new Set<string>();
  for (const key of keys) {
    let fingerprint: string;
    try {
      const parsed = createPublicKey(key.publicKeyPem);
      if (parsed.asymmetricKeyType !== "ed25519") {throw new Error("type");}
      fingerprint = parsed.export({ format: "der", type: "spki" }).toString("base64");
    } catch {
      throw new Error("semantic quality V4 pinned reviewer key is invalid");
    }
    if (!safeIdPattern.test(key.keyId) || key.roles.length === 0 || keyIds.has(key.keyId) ||
      publicKeys.has(fingerprint) || new Set(key.roles).size !== key.roles.length ||
      key.roles.some((role) => !isRole(role))) {
      throw new Error("semantic quality V4 pinned reviewer registry is ambiguous");
    }
    keyIds.add(key.keyId);
    publicKeys.add(fingerprint);
  }
}

function validBoundDigest(value: string): boolean {
  return digestPattern.test(value) && !/^([a-f0-9])\1{63}$/u.test(value);
}
