import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, exactRecord, sha256 } from "./canonical.js";

export interface CampaignDeadlineCheckpoint {
  readonly campaignDeadlineEpochMs: number;
  readonly campaignRootSha256: string;
  readonly createdAtEpochMs: number;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_deadline.v1";
}

export class ProductionCheckpointStore {
  private readonly root: string;
  public constructor(root: string) {
    if (!isAbsolute(root) || root.includes("\0")) {throw new Error("checkpoint root must be absolute");}
    this.root = resolve(root);
  }

  public async deadline(input: { readonly campaignRootSha256: string;
    readonly nowEpochMs: number }): Promise<CampaignDeadlineCheckpoint> {
    const path = join(this.root, "campaign-deadline.json");
    const existing = await optional(path);
    if (existing !== null) {
      const record = exactRecord(existing, ["campaignDeadlineEpochMs", "campaignRootSha256",
        "createdAtEpochMs", "schemaVersion"], "campaign deadline") as unknown as
        CampaignDeadlineCheckpoint;
      if (record.campaignRootSha256 !== input.campaignRootSha256 ||
        record.schemaVersion !== "meeting_knowledge.semantic_quality_deadline.v1") {
        throw new Error("campaign deadline checkpoint is bound to another campaign");
      }
      return record;
    }
    if (!Number.isSafeInteger(input.nowEpochMs) || input.nowEpochMs < 0) {
      throw new Error("campaign clock is invalid");
    }
    const record = Object.freeze({ campaignDeadlineEpochMs: input.nowEpochMs + 72 * 60 * 60 * 1_000,
      campaignRootSha256: input.campaignRootSha256, createdAtEpochMs: input.nowEpochMs,
      schemaVersion: "meeting_knowledge.semantic_quality_deadline.v1" as const });
    await createOnly(path, canonicalJson(record));
    return record;
  }

  public async completePhase(input: { readonly campaignRootSha256: string;
    readonly phase: string; readonly receipt: Readonly<Record<string, unknown>> }): Promise<string> {
    const value = Object.freeze({ campaignRootSha256: input.campaignRootSha256,
      phase: input.phase, receiptSha256: sha256(input.receipt), schemaVersion:
      "meeting_knowledge.semantic_quality_phase_checkpoint.v1" });
    await createOnly(join(this.root, "phases", `${input.phase}.json`), canonicalJson(value));
    return sha256(value);
  }

  public async requirePhase(campaignRootSha256: string, phase: string): Promise<string> {
    const value = await optional(join(this.root, "phases", `${phase}.json`));
    if (value === null) {throw new Error(`required ${phase} phase is incomplete`);}
    const record = exactRecord(value, ["campaignRootSha256", "phase", "receiptSha256",
      "schemaVersion"], "phase checkpoint");
    if (record.campaignRootSha256 !== campaignRootSha256 || record.phase !== phase ||
      record.schemaVersion !== "meeting_knowledge.semantic_quality_phase_checkpoint.v1" ||
      typeof record.receiptSha256 !== "string") {
      throw new Error("phase checkpoint is invalid or belongs to another campaign");
    }
    return record.receiptSha256;
  }
}

async function createOnly(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    if ((await readFile(path, "utf8")) !== bytes) {throw new Error("checkpoint conflicts");}
    return null;
  });
  if (handle === null) {return;}
  try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
  const directory = await open(dirname(path), "r");
  try {await directory.sync();} finally {await directory.close();}
}

async function optional(path: string): Promise<unknown | null> {
  try {return JSON.parse(await readFile(path, "utf8")) as unknown;}
  catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") {return null;} throw error;}
}
