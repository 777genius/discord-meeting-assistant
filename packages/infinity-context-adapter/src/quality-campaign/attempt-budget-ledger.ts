import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink, type FileHandle } from "node:fs/promises";

import { acquireLedgerFlock } from "./budget-ledger-file-lock.js";
import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { CALL_KINDS, type AttemptIdentity, type CallKind, type SpendReservation } from
  "./execution.js";
import { joinFromHandle } from "./production-execution-corpus-custody.js";

const MAXIMUM_LEDGER_BYTES = 64 * 1024 * 1024;
const MAXIMUM_LOCK_IDENTITY_BYTES = 64 * 1024;
const MAXIMUM_CHAIN_IDENTITY_BYTES = MAXIMUM_LEDGER_BYTES;

interface BudgetClaim {
  readonly admissionId: string; readonly attemptId: string; readonly callKind: CallKind;
  readonly campaignRootSha256: string; readonly requestedEncryptedBytes: number;
  readonly requestedTokens: number; readonly requestDigestSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1";
  readonly spendReservationSha256: string;
}

interface LedgerFile {
  readonly directory: FileHandle; readonly name: string;
}

interface LedgerIdentity {
  readonly dev: number; readonly ino: number; readonly size: number;
}

interface BoundLedgerIdentity {
  readonly chainSha256: string | null; readonly sidecarSize: number;
}

export async function loadAdmittedAttemptBudgetClaims(input: { readonly campaignRootSha256: string;
  readonly directory: FileHandle; readonly identityDirectory: FileHandle;
  readonly identityName: string; readonly ledgerName: string; readonly spendReservationSha256: string;
  readonly spend: SpendReservation }): Promise<readonly BudgetClaim[]> {
  const identityFile = { directory: input.identityDirectory, name: input.identityName };
  const ledger = { directory: input.directory, name: input.ledgerName };
  return await withLedgerLock(input.directory, input.ledgerName, async () => {
    const claims = await readBudgetClaims(ledger, identityFile, input.spendReservationSha256,
      input.campaignRootSha256);
    const admitted = admittedBudgetClaims(claims, input.spend);
    return Object.freeze(claims.filter(({ admissionId }) => admitted.has(admissionId)));
  });
}

export async function claimDurableAttemptBudget(input: { readonly admissionId: string;
  readonly directory: FileHandle; readonly identity: AttemptIdentity;
  readonly identityDirectory: FileHandle; readonly identityName: string; readonly ledgerName: string;
  readonly requestDigestSha256: string; readonly requestedEncryptedBytes: number;
  readonly requestedTokens: number; readonly spend: SpendReservation }): Promise<{
    readonly acceptedAttempt?: BudgetClaim; readonly admitted: boolean }> {
  const claim: BudgetClaim = { admissionId: input.admissionId,
    attemptId: input.identity.attemptId, callKind: input.identity.callKind,
    campaignRootSha256: input.identity.campaignRootSha256,
    requestedEncryptedBytes: input.requestedEncryptedBytes,
    requestedTokens: input.requestedTokens,
    requestDigestSha256: digest(input.requestDigestSha256, "budget request digest"),
    repetition: input.identity.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1",
    spendReservationSha256: input.identity.spendReservationSha256 };
  const identityFile = { directory: input.identityDirectory, name: input.identityName };
  const ledger = { directory: input.directory, name: input.ledgerName };
  return await withLedgerLock(input.directory, input.ledgerName, async () => {
    await appendDurableClaim(ledger, identityFile, canonicalJson(claim));
    const claims = await readBudgetClaims(ledger, identityFile,
      input.identity.spendReservationSha256, input.identity.campaignRootSha256);
    const admitted = admittedBudgetClaims(claims, input.spend);
    const acceptedAttempt = claims.find((candidate) => candidate.attemptId ===
      input.identity.attemptId && admitted.has(candidate.admissionId));
    return Object.freeze({ ...(acceptedAttempt === undefined ? {} : { acceptedAttempt }),
      admitted: admitted.has(input.admissionId) });
  });
}

async function withLedgerLock<T>(directory: FileHandle, name: string,
  task: () => Promise<T>): Promise<T> {
  const lockName = `.${name}.lock`;
  const lock = await open(joinFromHandle(directory, lockName), constants.O_RDWR |
    constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    await acquireLedgerFlock(lock);
    const identity = await lock.stat();
    if (!identity.isFile() || (identity.mode & 0o077) !== 0) {
      throw new Error("budget ledger lock is not a private regular file");
    }
    await bindAndCheckLockIdentity(directory, lockName, identity);
    await assertLockPathIdentity(directory, lockName, identity);
    return await task();
  } finally {await lock.close();}
}

async function bindAndCheckLockIdentity(directory: FileHandle, lockName: string,
  identity: LedgerIdentity): Promise<void> {
  const identityName = `${lockName}.identity`;
  const binding = canonicalJson({ dev: identity.dev, ino: identity.ino, lockName,
    schemaVersion: "meeting_knowledge.semantic_quality_budget_lock_identity.v1" });
  const finalPath = joinFromHandle(directory, identityName);
  try {
    await validateLockIdentity(finalPath, binding); return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
  }
  const temporaryName = `.${identityName}.${randomUUID()}.tmp`;
  const temporaryPath = joinFromHandle(directory, temporaryName);
  let created: FileHandle | undefined;
  let ownsTemporary = false;
  try {
    created = await open(temporaryPath, constants.O_WRONLY |
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    ownsTemporary = true;
    await created.writeFile(binding); await created.sync();
    const metadata = await created.stat();
    if (!metadata.isFile() || metadata.size !== Buffer.byteLength(binding)) {
      throw new Error("budget ledger lock identity temporary file changed during write");
    }
    if (process.env.DISCORD_MEETING_TEST_PAUSE_LOCK_IDENTITY_AFTER_SYNC === "1" &&
      process.send !== undefined) {
      process.send({ state: "lock_identity_temporary_synced" });
      await new Promise<void>((resolve) => {process.once("message", () => {resolve();});});
    }
  } catch (error) {
    await created?.close(); created = undefined;
    if (ownsTemporary) {
      await unlink(temporaryPath).catch((cleanupError: unknown) => {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {throw cleanupError;}
      });
      await directory.sync();
    }
    throw error;
  } finally {await created?.close();}
  try {
    await link(temporaryPath, finalPath);
    await directory.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    // Atomic publication prevents a new partial final file. A malformed or foreign final
    // identity is still unknown authority and is validated fail-closed below, never replaced.
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
    });
    await directory.sync();
  }
  await validateLockIdentity(finalPath, binding);
}

async function validateLockIdentity(path: string, binding: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 ||
      await readBoundedIdentityText(handle, "budget ledger lock identity",
        MAXIMUM_LOCK_IDENTITY_BYTES) !== binding) {
      throw new Error("budget ledger lock was replaced");
    }
  } finally {await handle.close();}
}

async function assertLockPathIdentity(directory: FileHandle, lockName: string,
  identity: LedgerIdentity): Promise<void> {
  const pathHandle = await open(joinFromHandle(directory, lockName), constants.O_RDONLY |
    constants.O_NOFOLLOW);
  try {
    const pathIdentity = await pathHandle.stat();
    if (!pathIdentity.isFile() || pathIdentity.dev !== identity.dev ||
      pathIdentity.ino !== identity.ino) {throw new Error("budget ledger lock was replaced");}
  } finally {await pathHandle.close();}
}

async function appendDurableClaim(ledger: LedgerFile, identityFile: LedgerFile,
  line: string): Promise<void> {
  const bytes = Buffer.from(`${line}\n`);
  if (bytes.byteLength > 4096) {throw new Error("budget claim exceeds atomic record bound");}
  const handle = await open(joinFromHandle(ledger.directory, ledger.name), constants.O_WRONLY |
    constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let identity: { readonly dev: number; readonly ino: number; readonly size: number } | undefined;
  let previousChainSha256: string | null = null;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size + bytes.byteLength > MAXIMUM_LEDGER_BYTES) {
      throw new Error("budget ledger exceeds its byte limit");
    }
    const bound = await requireLedgerIdentity(identityFile, ledger.name, before);
    previousChainSha256 = bound.chainSha256;
    const nextIdentity = { dev: before.dev, ino: before.ino,
      size: before.size + bytes.byteLength };
    if (bound.sidecarSize + Buffer.byteLength(ledgerIdentityLine(ledger.name, nextIdentity,
      previousChainSha256, bytes)) > MAXIMUM_CHAIN_IDENTITY_BYTES) {
      throw new Error("budget ledger identity exceeds its byte limit");
    }
    const result = await handle.write(bytes, 0, bytes.byteLength);
    if (result.bytesWritten !== bytes.byteLength) {throw new Error("budget claim append was partial");}
    await handle.sync();
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
      after.size < before.size + bytes.byteLength) {
      throw new Error("budget ledger changed during append");
    }
    identity = after;
  } finally {await handle.close();}
  if (identity === undefined) {throw new Error("budget ledger identity was not established");}
  await bindLedgerIdentity(identityFile, ledger.name, identity, previousChainSha256, bytes);
  await ledger.directory.sync();
}

async function bindLedgerIdentity(identityFile: LedgerFile, ledgerName: string,
  identity: LedgerIdentity,
  previousChainSha256: string | null, recordBytes: Uint8Array): Promise<void> {
  const line = ledgerIdentityLine(ledgerName, identity, previousChainSha256, recordBytes);
  const handle = await open(joinFromHandle(identityFile.directory, identityFile.name), constants.O_WRONLY |
    constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {await handle.writeFile(line); await handle.sync();} finally {await handle.close();}
  await identityFile.directory.sync();
}

async function readBudgetClaims(ledger: LedgerFile, identityFile: LedgerFile,
  spendReservationSha256: string, campaignRootSha256: string):
Promise<readonly BudgetClaim[]> {
  const text = await readCompleteLedger(ledger, identityFile);
  if (text === "") {return Object.freeze([]);}
  return Object.freeze(text.slice(0, -1).split("\n").map((line) => {
    let value: unknown;
    try {value = JSON.parse(line) as unknown;} catch {throw new Error("budget claim is not JSON");}
    const record = exactRecord(value, ["admissionId", "attemptId", "callKind",
      "campaignRootSha256", "repetition", "requestedEncryptedBytes", "requestedTokens",
      "requestDigestSha256", "schemaVersion", "spendReservationSha256"], "budget claim");
    if (record.schemaVersion !== "meeting_knowledge.semantic_quality_budget_claim.v1" ||
      record.campaignRootSha256 !== campaignRootSha256 ||
      record.spendReservationSha256 !== spendReservationSha256 ||
      !CALL_KINDS.includes(record.callKind as CallKind) ||
      ![1, 2, 3].includes(Number(record.repetition)) ||
      ![record.requestedEncryptedBytes, record.requestedTokens].every((number) =>
        Number.isSafeInteger(number) && Number(number) >= 0) || Number(record.requestedTokens) < 1) {
      throw new Error("budget claim binding is invalid");
    }
    safeId(record.admissionId, "budget admission ID"); safeId(record.attemptId,
      "budget attempt ID"); digest(record.requestDigestSha256, "budget request digest");
    return record as unknown as BudgetClaim;
  }));
}

async function readCompleteLedger(ledger: LedgerFile, identityFile: LedgerFile): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let handle: FileHandle;
    try {handle = await open(joinFromHandle(ledger.directory, ledger.name), constants.O_RDONLY |
      constants.O_NOFOLLOW);}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await assertLedgerIdentityAbsent(identityFile); return "";
      }
      throw error;
    }
    let text: string | undefined;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAXIMUM_LEDGER_BYTES) {
        throw new Error("budget ledger exceeds its byte limit");
      }
      const bytes = Buffer.allocUnsafe(before.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, before.size + 1, 0);
      const after = await handle.stat();
      if (!after.isFile() || bytesRead > MAXIMUM_LEDGER_BYTES || before.dev !== after.dev ||
        before.ino !== after.ino || before.mode !== after.mode || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        bytesRead !== after.size) {text = undefined;} else {
        if (bytesRead === 0) {await assertLedgerIdentityAbsent(identityFile);}
        else {await assertLedgerIdentity(identityFile, ledger.name, after,
          ledgerChain(bytes.subarray(0, bytesRead)));}
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
      }
    } finally {await handle.close();}
    if (text === undefined) {await new Promise<void>((resolve) => {setImmediate(resolve);}); continue;}
    if (text === "" || text.endsWith("\n")) {return text;}
    await new Promise<void>((resolve) => {setImmediate(resolve);});
  }
  throw new Error("budget ledger contains a partial claim");
}

async function assertLedgerIdentityAbsent(identityFile: LedgerFile): Promise<void> {
  let handle: FileHandle;
  try {handle = await open(joinFromHandle(identityFile.directory, identityFile.name),
    constants.O_RDONLY | constants.O_NOFOLLOW);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") {return;} throw error;}
  await handle.close(); throw new Error("budget ledger disappeared after durable identity binding");
}

async function assertLedgerIdentity(identityFile: LedgerFile, ledgerName: string,
  identity: LedgerIdentity, chainSha256: string): Promise<void> {
  const bound = await requireLedgerIdentity(identityFile, ledgerName, identity);
  if (bound.chainSha256 !== chainSha256) {
    throw new Error("budget ledger content chain is invalid");
  }
}

async function requireLedgerIdentity(identityFile: LedgerFile, ledgerName: string,
  identity: LedgerIdentity): Promise<BoundLedgerIdentity> {
  let handle: FileHandle;
  try {handle = await open(joinFromHandle(identityFile.directory, identityFile.name),
    constants.O_RDONLY | constants.O_NOFOLLOW);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && identity.size === 0) {
      return { chainSha256: null, sidecarSize: 0 };
    }
    throw error;
  }
  try {
    const text = await readBoundedIdentityText(handle, "budget ledger identity",
      MAXIMUM_CHAIN_IDENTITY_BYTES);
    const lines = text.trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1) ?? "null") as { chainSha256?: unknown; dev?: unknown;
      ino?: unknown; ledgerName?: unknown; schemaVersion?: unknown; size?: unknown };
    if (last.dev !== identity.dev || last.ino !== identity.ino || last.ledgerName !== ledgerName ||
      last.schemaVersion !== "meeting_knowledge.semantic_quality_budget_identity.v1" ||
      !Number.isSafeInteger(last.size) || Number(last.size) !== identity.size) {
      throw new Error("budget ledger was replaced or truncated");
    }
    return { chainSha256: digest(last.chainSha256, "budget ledger chain"),
      sidecarSize: Buffer.byteLength(text) };
  } finally {await handle.close();}
}

function ledgerIdentityLine(ledgerName: string, identity: LedgerIdentity,
  previousChainSha256: string | null,
  recordBytes: Uint8Array): string {
  const chainSha256 = nextLedgerChain(previousChainSha256, recordBytes, identity.size);
  return canonicalJson({ chainSha256, dev: identity.dev, ino: identity.ino, ledgerName,
    schemaVersion: "meeting_knowledge.semantic_quality_budget_identity.v1",
    size: identity.size }) + "\n";
}

async function readBoundedIdentityText(handle: FileHandle, label: string,
  maximumBytes: number): Promise<string> {
  const before = await handle.stat();
  if (!before.isFile() || (before.mode & 0o077) !== 0) {
    throw new Error(`${label} is not a private regular file`);
  }
  if (before.size > maximumBytes) {throw new Error(`${label} exceeds its byte limit`);}
  const bytes = Buffer.allocUnsafe(Math.min(before.size + 1, maximumBytes + 1));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead === 0) {break;}
    offset += result.bytesRead;
  }
  const after = await handle.stat();
  if (offset > maximumBytes || after.size > maximumBytes) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
    before.mode !== after.mode || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    offset !== after.size) {
    throw new Error(`${label} changed during bounded read`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
}

function ledgerChain(bytes: Uint8Array): string {
  let chain: string | null = null; let offset = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) {continue;}
    const record = bytes.subarray(offset, index + 1); offset = index + 1;
    chain = nextLedgerChain(chain, record, offset);
  }
  if (offset !== bytes.byteLength || chain === null) {
    throw new Error("budget ledger content chain is incomplete");
  }
  return chain;
}

function nextLedgerChain(previousChainSha256: string | null, recordBytes: Uint8Array,
  size: number): string {
  return sha256({ previousChainSha256, recordSha256: sha256(recordBytes), size });
}

function admittedBudgetClaims(claims: readonly BudgetClaim[], spend: SpendReservation):
ReadonlySet<string> {
  const admitted = new Set<string>(); const attempts = new Set<string>();
  const callsByKind = Object.fromEntries(CALL_KINDS.map((kind) => [kind, 0])) as
    Record<CallKind, number>;
  let calls = 0, encryptedBytes = 0, tokens = 0;
  for (const claim of claims) {
    if (claim.repetition !== spend.repetition || !spend.allowedCallKinds.includes(claim.callKind)) {
      throw new Error("budget claim is outside its signed reservation scope");
    }
    if (attempts.has(claim.attemptId)) {continue;}
    attempts.add(claim.attemptId);
    const fits = calls + 1 <= spend.maxCalls &&
      callsByKind[claim.callKind] + 1 <= spend.maxCallsByKind[claim.callKind] &&
      tokens + claim.requestedTokens <= spend.maxTokens &&
      encryptedBytes + claim.requestedEncryptedBytes <= spend.maxEncryptedBytes;
    if (!fits) {continue;}
    admitted.add(claim.admissionId); calls += 1; callsByKind[claim.callKind] += 1;
    tokens += claim.requestedTokens; encryptedBytes += claim.requestedEncryptedBytes;
  }
  return admitted;
}
