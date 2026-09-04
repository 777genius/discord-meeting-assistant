import { createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

import type { AdmissionAuthority } from "./admission.js";
import { canonicalJson, digest, exactRecord, publicKeyFingerprintSha256, safeId, sha256 } from
  "./canonical.js";
import type { QualificationExecutionPacket } from
  "./execute-admitted-qualification-question.js";
import { validateQualificationExecutionPacket } from "./qualification-corpus-packets.js";
import { QUALITY_AUTHORITY_ROLES, QualityCampaignAuthorityPolicy } from "./release.js";

interface CorpusAuthority { readonly keyId: string; readonly publicKeyPem: string }

const CANONICAL_ADMISSION_ARTIFACTS = Object.freeze([
  "InputManifest.v4.json", "acceptance-receipt.json", "automatic-questions.json",
  "execution-authorization.json", "execution-corpus.json", "forbidden-locator-manifest.json",
  "forbidden-locators.json", "gold-relevance.json", "independent-review-questions.json",
  "locator-inventory.json", "question-review-1.json", "question-review-2.json",
  "turn-to-block-manifest.json",
].toSorted());

export async function loadProductionExecutionCorpus(input: {
  readonly authority: CorpusAuthority;
  readonly campaignRootSha256: string;
  readonly expectedQuestionCount: number;
  readonly executionPacketPath: string;
}): Promise<readonly QualificationExecutionPacket[]> {
  digest(input.campaignRootSha256, "execution corpus campaign root");
  const completed = await readCompletedCorpusReceipt(input.executionPacketPath, input.authority,
    "execution corpus", input.campaignRootSha256, CANONICAL_ADMISSION_ARTIFACTS);
  const signed = completed.document;
  const payload = exactRecord(signed.payload, ["campaignRootSha256", "packets",
    "schemaVersion"], "execution corpus payload");
  if (payload.schemaVersion !== "meeting_knowledge.quality_execution_corpus.v1" ||
    payload.campaignRootSha256 !== input.campaignRootSha256 ||
    !Array.isArray(payload.packets) || input.expectedQuestionCount !== 240 ||
    completed.questionCount !== 240 || payload.packets.length !== completed.questionCount) {
    throw new Error("execution corpus binding or cardinality is invalid");
  }
  const packets = payload.packets.map(validateQualificationExecutionPacket);
  if (new Set(packets.map(({ questionId }) => questionId)).size !== packets.length ||
    packets.filter(({ source }) => source === "automatic").length !== 200 ||
    packets.filter(({ source }) => source === "independent_review").length !== 40) {
    throw new Error("execution corpus question membership or source receipt is invalid");
  }
  return Object.freeze(packets);
}

export async function readCompletedCorpusDocument(path: string, authority: CorpusAuthority, label: string,
  campaignRootSha256: string) {
  return (await readCompletedCorpusReceipt(path, authority, label, campaignRootSha256)).document;
}

async function readCompletedCorpusReceipt(path: string, authority: CorpusAuthority, label: string,
  campaignRootSha256: string, requiredArtifactNames?: readonly string[]) {
  const target = absolute(path, label);
  const directory = await openQualityCampaignDirectory(dirname(target), `${label} output`, true);
  try {
    const completed = await assertCompletedAdmission(directory, basename(target),
      campaignRootSha256, requiredArtifactNames);
    const signed = verifySignedCorpusValue(parseCanonicalQualityCampaignJsonBytes(
      completed.artifactBytes, label), authority, label);
    if (sha256(signed) !== completed.expectedArtifactSha256) {
      throw new Error(`${label} differs from the completed admission inventory`);
    }
    await assertDirectoryInventory(directory, completed.expectedNames);
    return Object.freeze({ document: signed, questionCount: completed.questionCount,
      questionSetSha256: completed.questionSetSha256 });
  } finally {await directory.close();}
}

export async function readSignedCorpusDocument(path: string, authority: CorpusAuthority,
  label: string) {
  if (!isAbsolute(path) || path.includes("\0") || authority.keyId.trim() === "") {
    throw new Error(`${label} custody configuration is invalid`);
  }
  const value = await readCanonicalQualityCampaignJson(resolve(path), label);
  return verifySignedCorpusValue(value, authority, label);
}

function verifySignedCorpusValue(value: unknown, authority: CorpusAuthority, label: string) {
  const record = exactRecord(value,
    ["payload", "signatureBase64", "signerKeyId"], `${label} signed document`);
  if (record.signerKeyId !== authority.keyId || typeof record.signatureBase64 !== "string") {
    throw new Error(`${label} authority is invalid`);
  }
  let valid = false;
  try {valid = verify(null, Buffer.from(canonicalJson(record.payload)),
    createPublicKey(authority.publicKeyPem), Buffer.from(record.signatureBase64, "base64"));}
  catch {valid = false;}
  if (!valid) {throw new Error(`${label} signature is invalid`);}
  return Object.freeze({ payload: record.payload, signatureBase64: record.signatureBase64,
    signerKeyId: record.signerKeyId });
}

// oxlint-disable-next-line complexity -- the exact closed inventory is one fail-closed boundary
async function assertCompletedAdmission(directory: FileHandle, artifactName: string,
  campaignRootSha256: string, requiredArtifactNames?: readonly string[]) {
  let manifestValue: unknown;
  try {manifestValue = await readCanonicalQualityCampaignJsonAt(directory,
    "corpus-admission-manifest.json", "corpus admission completion manifest");}
  catch (error) {throw new Error("corpus admission completion manifest is unavailable", { cause: error });}
  const manifest = exactRecord(manifestValue,
  ["artifactInventory", "authorizationComparisonEpochMs", "campaignRootSha256", "completionState",
    "corpusDigestSha256", "questionCount", "questionSetSha256", "releaseRootSha256",
    "schemaVersion"], "corpus admission completion manifest");
  if (manifest.schemaVersion !== "meeting_knowledge.semantic_quality_corpus_admission_manifest.v1" ||
    manifest.completionState !== "complete" || manifest.campaignRootSha256 !== campaignRootSha256 ||
    !Number.isSafeInteger(manifest.authorizationComparisonEpochMs) ||
    Number(manifest.authorizationComparisonEpochMs) < 0 ||
    !Number.isSafeInteger(manifest.questionCount) || Number(manifest.questionCount) < 1 ||
    !/^[a-f0-9]{64}$/u.test(String(manifest.corpusDigestSha256)) ||
    !/^[a-f0-9]{64}$/u.test(String(manifest.questionSetSha256)) ||
    !/^[a-f0-9]{64}$/u.test(String(manifest.releaseRootSha256)) ||
    !Array.isArray(manifest.artifactInventory)) {
    throw new Error("corpus admission is incomplete or foreign");
  }
  const inventory = manifest.artifactInventory.map((value) => exactRecord(value,
    ["path", "sha256"], "corpus admission artifact inventory entry"));
  const inventoryNames = inventory.map(({ path: name }) => String(name));
  const expectedNames = [...inventoryNames, "corpus-admission-manifest.json"].toSorted();
  const artifact = inventory.find(({ path: name }) => name === artifactName);
  if (inventory.length === 0 || new Set(inventoryNames).size !== inventory.length ||
    requiredArtifactNames !== undefined && canonicalJson(inventoryNames.toSorted()) !==
      canonicalJson([...requiredArtifactNames].toSorted()) || artifact === undefined) {
    throw new Error("corpus admission completion inventory is invalid");
  }
  await assertDirectoryInventory(directory, expectedNames);
  let artifactBytes: Buffer | undefined;
  for (const entry of inventory) {
    if (typeof entry.path !== "string" || basename(entry.path) !== entry.path) {
      throw new Error("corpus admission artifact inventory differs from output");
    }
    const bytes = await readQualityCampaignBytesAt(directory, entry.path,
      `corpus admission artifact ${entry.path}`);
    if (sha256(bytes) !== digest(entry.sha256, "corpus admission artifact digest")) {
      throw new Error("corpus admission artifact inventory differs from output");
    }
    if (entry.path === artifactName) {artifactBytes = bytes;}
  }
  await assertDirectoryInventory(directory, expectedNames);
  if (artifactBytes === undefined) {throw new Error("corpus admission artifact is unavailable");}
  return Object.freeze({ artifactBytes, expectedArtifactSha256:
    digest(artifact.sha256, "corpus admission artifact digest"), expectedNames,
    questionCount: Number(manifest.questionCount), questionSetSha256:
    digest(manifest.questionSetSha256, "corpus admission question set") });
}

async function assertDirectoryInventory(directory: FileHandle,
  expectedNames: readonly string[]): Promise<void> {
  const actualNames = (await readdir(descriptorPath(directory), { withFileTypes: true }))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("corpus admission output contains a non-file entry");
      }
      return entry.name;
    }).toSorted();
  if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) {
    throw new Error("corpus admission completion inventory is invalid");
  }
}

/** Canonical, bounded input opened through descriptor-pinned no-symlink ancestors. */
export async function readCanonicalQualityCampaignJson(path: string, label: string,
  maximumBytes = 8_000_000): Promise<unknown> {
  const text = await readQualityCampaignText(path, label, maximumBytes);
  let value: unknown;
  try {value = JSON.parse(text) as unknown;} catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
  if (canonicalJson(value) !== text) {throw new Error(`${label} is not canonical`);}
  return value;
}

export async function readCanonicalQualityCampaignJsonAt(directory: FileHandle, name: string,
  label: string, maximumBytes = 8_000_000): Promise<unknown> {
  return parseCanonicalQualityCampaignJsonBytes(
    await readQualityCampaignBytesAt(directory, name, label, maximumBytes), label);
}

export function parseCanonicalQualityCampaignJsonBytes(bytes: Uint8Array,
  label: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  try {value = JSON.parse(text) as unknown;} catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
  if (canonicalJson(value) !== text) {throw new Error(`${label} is not canonical`);}
  return value;
}

export async function loadSecureQualityAuthorityPolicy(path: string) {
  const record = exactRecord(await readCanonicalQualityCampaignJson(path,
    "quality authority policy"), QUALITY_AUTHORITY_ROLES, "quality authority policy paths");
  const entries = await Promise.all(QUALITY_AUTHORITY_ROLES.map(async (role) => {
    const authority = await loadSecureQualityAuthority(String(record[role]));
    return [role, Object.freeze({ keyId: authority.keyId,
      publicKeyFingerprintSha256: publicKeyFingerprintSha256(authority.publicKeyPem, role),
      publicKeyPem: authority.publicKeyPem })] as const;
  }));
  return new QualityCampaignAuthorityPolicy(Object.fromEntries(entries) as never);
}

export async function loadSecureQualityAuthority(path: string): Promise<AdmissionAuthority> {
  const record = exactRecord(await readCanonicalQualityCampaignJson(path, "authority"),
    ["keyId", "publicKeyPath"], "authority");
  return Object.freeze({ keyId: safeId(record.keyId, "authority key ID"),
    publicKeyPem: await readQualityCampaignText(String(record.publicKeyPath), "public key", 16_384) });
}

export async function readQualityCampaignText(path: string, label: string,
  maximumBytes: number): Promise<string> {
  const target = absolute(path, label);
  const parent = await openQualityCampaignDirectory(dirname(target), `${label} parent`);
  let file: FileHandle | undefined;
  try {
    file = await open(joinFromHandle(parent, basename(target)), constants.O_RDONLY |
      constants.O_NOFOLLOW);
    const bytes = await readBoundedStableFile(file, label, maximumBytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {await file?.close(); await parent.close();}
}

export async function readQualityCampaignBytes(path: string, label: string,
  maximumBytes: number): Promise<Buffer> {
  const target = absolute(path, label);
  const parent = await openQualityCampaignDirectory(dirname(target), `${label} parent`);
  try {return await readQualityCampaignBytesAt(parent, basename(target), label, maximumBytes);}
  finally {await parent.close();}
}

export async function readQualityCampaignBytesAt(directory: FileHandle, name: string, label: string,
  maximumBytes = 8_000_000): Promise<Buffer> {
  const file = await open(joinFromHandle(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {return await readBoundedStableFile(file, label, maximumBytes);}
  finally {await file.close();}
}

async function readBoundedStableFile(file: FileHandle, label: string,
  maximumBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error(`${label} byte limit is invalid`);
  }
  const before = await file.stat();
  if (!before.isFile() || before.size === 0) {throw new Error(`${label} size is invalid`);}
  const bytes = Buffer.allocUnsafe(maximumBytes + 1);
  const { bytesRead } = await file.read(bytes, 0, maximumBytes + 1, 0);
  const after = await file.stat();
  if (bytesRead === 0 || bytesRead > maximumBytes || before.dev !== after.dev ||
    before.ino !== after.ino || before.mode !== after.mode || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs || bytesRead !== after.size) {
    throw new Error(`${label} changed or exceeds its byte limit`);
  }
  return bytes.subarray(0, bytesRead);
}

export async function openQualityCampaignDirectory(path: string, label: string,
  requirePrivate = false): Promise<FileHandle> {
  const target = absolute(path, label); const root = parse(target).root;
  let current = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const segment of relative(root, target).split(sep).filter(Boolean)) {
      const next = await open(joinFromHandle(current, segment), constants.O_RDONLY |
        constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await current.close(); current = next;
    }
    const metadata = await current.stat();
    if (!metadata.isDirectory() || requirePrivate && (metadata.mode & 0o077) !== 0) {
      throw new Error(`${label} must be a private directory`);
    }
    return current;
  } catch (error) {await current.close(); throw error;}
}

export async function openOrCreatePrivateQualityCampaignDirectory(path: string,
  label: string): Promise<FileHandle> {
  const target = absolute(path, label);
  const parent = await openQualityCampaignDirectory(dirname(target), `${label} parent`);
  try {
    try {await mkdir(joinFromHandle(parent, basename(target)), { mode: 0o700 }); await parent.sync();}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}}
    const directory = await open(joinFromHandle(parent, basename(target)), constants.O_RDONLY |
      constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const metadata = await directory.stat();
    if ((metadata.mode & 0o077) !== 0) {await directory.close();
      throw new Error(`${label} must be a private directory`);}
    return directory;
  } finally {await parent.close();}
}

export function joinFromHandle(directory: FileHandle, name: string): string {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error("quality campaign path component is invalid");
  }
  return `${descriptorPath(directory)}/${name}`;
}

function descriptorPath(directory: FileHandle): string {return `/proc/self/fd/${directory.fd}`;}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error(`${label} must be absolute`);}
  return resolve(path);
}
