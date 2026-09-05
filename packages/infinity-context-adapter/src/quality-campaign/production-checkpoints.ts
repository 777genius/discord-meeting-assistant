import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { createOperatorSafeReceipt } from "./operator-cli.js";
import type { ExactAdjudicationEvidence } from "./production-evidence.js";
import { joinFromHandle, openOrCreatePrivateQualityCampaignDirectory,
  readCanonicalQualityCampaignJsonAt, readQualityCampaignBytesAt } from
  "./production-execution-corpus-custody.js";

export interface CampaignDeadlineCheckpoint {
  readonly campaignDeadlineEpochMs: number; readonly campaignRootSha256: string;
  readonly createdAtEpochMs: number;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_deadline.v1";
}

export type CleanupReservationState =
  | { readonly state: "created" | "reserved_existing" | "outcome_unknown" }
  | { readonly evidence: unknown; readonly state: "completed" };

export function adjudicationCheckpointReceipt(campaignRootSha256: string,
  adjudications: readonly ExactAdjudicationEvidence[]) {
  return createOperatorSafeReceipt(campaignRootSha256, { adjudicationCount: adjudications.length,
    adjudicationSetSha256: sha256(adjudications.map(({ attemptId, decisionDigestSha256,
      outcomeDigestSha256, resolverReceipt }) => ({ attemptId, decisionDigestSha256,
      outcomeDigestSha256, resolverReceiptSha256: resolverReceipt === null ? null :
        sha256(resolverReceipt) })).toSorted((a, b) => a.attemptId.localeCompare(b.attemptId))) });
}

export function assertAdjudicationCheckpoint(receiptSha256: string, campaignRootSha256: string,
  adjudications: readonly ExactAdjudicationEvidence[]): void {
  if (sha256(adjudicationCheckpointReceipt(campaignRootSha256, adjudications)) !== receiptSha256) {
    throw new Error("exact adjudication evidence changed or is not locally reconstructed");
  }
}

export function retentionCheckpointReceipt(campaignRootSha256: string, reconstructed: {
  readonly inventorySha256: string; readonly metricsSha256ByRepetition: unknown },
  localCanonicalInventorySha256: string) {
  return createOperatorSafeReceipt(campaignRootSha256, { inventorySha256:
    reconstructed.inventorySha256, metricsSha256:
    sha256(reconstructed.metricsSha256ByRepetition), outcomeCount: 720,
    localCanonicalInventorySha256: digest(localCanonicalInventorySha256,
      "local canonical retained inventory") });
}

/** Durable campaign state stays beneath one private descriptor-pinned root for its lifetime. */
export class ProductionCheckpointStore {
  private readonly root: Promise<FileHandle>;
  private readonly phases: Promise<FileHandle>;
  private readonly cleanupReservations: Promise<FileHandle>;
  private closePromise: Promise<void> | undefined;
  public constructor(root: string) {
    if (!isAbsolute(root) || root.includes("\0")) {throw new Error("checkpoint root must be absolute");}
    const target = resolve(root);
    this.root = openOrCreatePrivateQualityCampaignDirectory(target, "checkpoint root");
    this.phases = this.child(this.root, "phases", "checkpoint phases");
    this.cleanupReservations = this.child(this.root, "cleanup-reservations",
      "cleanup reservations");
    void this.root.catch(() => null); void this.phases.catch(() => null);
    void this.cleanupReservations.catch(() => null);
  }

  public async close(): Promise<void> {
    this.closePromise ??= (async () => {
      let failure: unknown;
      const initialized = await Promise.allSettled(
        [this.cleanupReservations, this.phases, this.root]);
      for (const item of initialized) {
        if (item.status === "rejected") {failure ??= item.reason; continue;}
        try {await item.value.close();} catch (error) {failure ??= error;}
      }
      if (failure !== undefined) {throw new Error("checkpoint store close failed", { cause: failure });}
    })();
    await this.closePromise;
  }

  public async [Symbol.asyncDispose](): Promise<void> {await this.close();}

  public async deadline(input: { readonly campaignRootSha256: string;
    readonly nowEpochMs: number }): Promise<CampaignDeadlineCheckpoint> {
    const root = await this.root; const existing = await optional(root, "campaign-deadline.json");
    if (existing !== null) {
      const raw = exactRecord(existing, ["campaignDeadlineEpochMs", "campaignRootSha256",
        "createdAtEpochMs", "schemaVersion"], "campaign deadline");
      if (raw.campaignRootSha256 !== input.campaignRootSha256 ||
        raw.schemaVersion !== "meeting_knowledge.semantic_quality_deadline.v1" ||
        !Number.isSafeInteger(raw.campaignDeadlineEpochMs) ||
        !Number.isSafeInteger(raw.createdAtEpochMs)) {
        throw new Error("campaign deadline checkpoint is bound to another campaign");
      }
      return raw as unknown as CampaignDeadlineCheckpoint;
    }
    if (!Number.isSafeInteger(input.nowEpochMs) || input.nowEpochMs < 0) {
      throw new Error("campaign clock is invalid");
    }
    const record = Object.freeze({ campaignDeadlineEpochMs: input.nowEpochMs + 72 * 60 * 60 * 1_000,
      campaignRootSha256: digest(input.campaignRootSha256, "checkpoint campaign root"),
      createdAtEpochMs: input.nowEpochMs,
      schemaVersion: "meeting_knowledge.semantic_quality_deadline.v1" as const });
    await createOnly(root, "campaign-deadline.json", canonicalJson(record)); return record;
  }

  public async completePhase(input: { readonly campaignRootSha256: string;
    readonly phase: string; readonly receipt: Readonly<Record<string, unknown>> }): Promise<string> {
    const value = Object.freeze({ campaignRootSha256: input.campaignRootSha256,
      phase: safeId(input.phase, "checkpoint phase"), receiptSha256: sha256(input.receipt),
      schemaVersion: "meeting_knowledge.semantic_quality_phase_checkpoint.v1" });
    await createOnly(await this.phases, `${input.phase}.json`, canonicalJson(value)); return sha256(value);
  }

  public async completeEvidencePhase(input: { readonly campaignRootSha256: string;
    readonly evidence: unknown; readonly phase: string;
    readonly receipt: Readonly<Record<string, unknown>> }): Promise<string> {
    const value = Object.freeze({ campaignRootSha256: input.campaignRootSha256,
      evidence: input.evidence, evidenceSha256: sha256(input.evidence),
      phase: safeId(input.phase, "evidence checkpoint phase"), receiptSha256: sha256(input.receipt),
      schemaVersion: "meeting_knowledge.semantic_quality_evidence_phase_checkpoint.v1" });
    await createOnly(await this.phases, `${input.phase}-evidence.json`, canonicalJson(value));
    return sha256(value);
  }

  public async requirePhase(campaignRootSha256: string, phase: string): Promise<string> {
    const value = await optional(await this.phases, `${safeId(phase, "checkpoint phase")}.json`);
    if (value === null) {throw new Error(`required ${phase} phase is incomplete`);}
    const record = exactRecord(value, ["campaignRootSha256", "phase", "receiptSha256",
      "schemaVersion"], "phase checkpoint");
    if (record.campaignRootSha256 !== campaignRootSha256 || record.phase !== phase ||
      record.schemaVersion !== "meeting_knowledge.semantic_quality_phase_checkpoint.v1") {
      throw new Error("phase checkpoint is invalid or belongs to another campaign");
    }
    return digest(record.receiptSha256, "phase checkpoint receipt");
  }

  public async requireEvidencePhase(campaignRootSha256: string, phase: string): Promise<unknown> {
    const value = await optional(await this.phases,
      `${safeId(phase, "evidence checkpoint phase")}-evidence.json`);
    if (value === null) {throw new Error(`required ${phase} evidence phase is incomplete`);}
    const record = exactRecord(value, ["campaignRootSha256", "evidence", "evidenceSha256",
      "phase", "receiptSha256", "schemaVersion"], "evidence phase checkpoint");
    if (record.campaignRootSha256 !== campaignRootSha256 || record.phase !== phase ||
      record.schemaVersion !== "meeting_knowledge.semantic_quality_evidence_phase_checkpoint.v1" ||
      record.evidenceSha256 !== sha256(record.evidence)) {
      throw new Error("evidence phase checkpoint is invalid or belongs to another campaign");
    }
    digest(record.receiptSha256, "evidence checkpoint receipt"); return record.evidence;
  }

  public async reserveCleanup(input: { readonly campaignRootSha256: string;
    readonly cleanupManifestSha256: string }): Promise<CleanupReservationState> {
    const directory = await this.cleanupReservations; const id = cleanupId(input);
    const completed = await optional(directory, `${id}.completed.json`);
    if (completed !== null) {return { evidence: decodeCleanupCompletion(completed, input),
      state: "completed" };}
    if (await optional(directory, `${id}.unknown.json`) !== null) {return { state: "outcome_unknown" };}
    const reservation = cleanupReservation(input);
    const created = await createOnly(directory, `${id}.reserved.json`, canonicalJson(reservation));
    return { state: created ? "created" : "reserved_existing" };
  }

  public async markCleanupOutcomeUnknown(input: { readonly campaignRootSha256: string;
    readonly cleanupManifestSha256: string }): Promise<void> {
    const value = { ...cleanupReservation(input), state: "outcome_unknown",
      schemaVersion: "meeting_knowledge.semantic_quality_cleanup_outcome_unknown.v1" };
    await createOnly(await this.cleanupReservations, `${cleanupId(input)}.unknown.json`,
      canonicalJson(value));
  }

  public async completeCleanup(input: { readonly campaignRootSha256: string;
    readonly cleanupManifestSha256: string; readonly evidence: unknown }): Promise<void> {
    const value = { ...cleanupReservation(input), evidence: input.evidence,
      evidenceSha256: sha256(input.evidence), state: "completed",
      schemaVersion: "meeting_knowledge.semantic_quality_cleanup_completion.v1" };
    await createOnly(await this.cleanupReservations, `${cleanupId(input)}.completed.json`,
      canonicalJson(value));
  }

  private async child(parentPromise: Promise<FileHandle>, name: string, label: string) {
    const parent = await parentPromise;
    try {await mkdir(joinFromHandle(parent, name), { mode: 0o700 }); await parent.sync();}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}}
    const child = await open(joinFromHandle(parent, name), constants.O_RDONLY |
      constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const metadata = await child.stat();
      if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
        throw new Error(`${label} is not private`);
      }
      return child;
    } catch (error) {await child.close(); throw error;}
  }
}

function cleanupReservation(input: { readonly campaignRootSha256: string;
  readonly cleanupManifestSha256: string }) {
  return { campaignRootSha256: digest(input.campaignRootSha256, "cleanup campaign root"),
    cleanupManifestSha256: digest(input.cleanupManifestSha256, "cleanup manifest"),
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_reservation.v1",
    state: "reserved" };
}
function cleanupId(input: { readonly campaignRootSha256: string;
  readonly cleanupManifestSha256: string }): string {return sha256({ campaignRootSha256:
    input.campaignRootSha256, cleanupManifestSha256: input.cleanupManifestSha256,
  purpose: "derived_cleanup_reservation" });}
function decodeCleanupCompletion(value: unknown, input: { readonly campaignRootSha256: string;
  readonly cleanupManifestSha256: string }): unknown {
  const record = exactRecord(value, ["campaignRootSha256", "cleanupManifestSha256", "evidence",
    "evidenceSha256", "schemaVersion", "state"], "cleanup completion");
  if (record.campaignRootSha256 !== input.campaignRootSha256 ||
    record.cleanupManifestSha256 !== input.cleanupManifestSha256 || record.state !== "completed" ||
    record.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup_completion.v1" ||
    record.evidenceSha256 !== sha256(record.evidence)) {throw new Error("cleanup completion is corrupt");}
  return record.evidence;
}

async function createOnly(directory: FileHandle, name: string, bytes: string): Promise<boolean> {
  let handle: FileHandle;
  try {handle = await open(joinFromHandle(directory, name), constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    if ((await readQualityCampaignBytesAt(directory, name, "existing checkpoint",
      8_000_000)).toString("utf8") !== bytes) {
      throw new Error("checkpoint conflicts", { cause: error });
    }
    return false;
  }
  try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
  await directory.sync(); return true;
}

async function optional(directory: FileHandle, name: string): Promise<unknown> {
  try {return await readCanonicalQualityCampaignJsonAt(directory, name, "checkpoint", 8_000_000);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
    (error as Error & { cause?: NodeJS.ErrnoException }).cause?.code === "ENOENT") {return null;}
    throw error;}
}
