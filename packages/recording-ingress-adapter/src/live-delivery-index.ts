import { lstatSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RecordingIngressError } from "./errors.js";
import type { SttCompletion, SttRecordingState, SttSpeakerState } from "./live-stt-journal-contracts.js";

// Each disposable STT cache value belongs to its journal-defined key namespace.
type SttCacheKey<T> = T extends SttRecordingState ? "recording"
  : T extends SttSpeakerState ? `speaker:${string}`
    : T extends SttCompletion ? `operation:${number}` : string;

export interface LiveGeneration {
  readonly generation: number;
  readonly recording: string;
  stamp: string;
  remaining: number;
  conflicting: number;
}
export interface LiveOffset {
  readonly packet: string;
  readonly offset: number;
  readonly length: number;
  readonly delivered: number;
}

/** Disposable, payload-free metadata. All transactions finish synchronously.
 * Keys use JSON string encoding to preserve exact JS identity even for legacy
 * lone surrogates or NUL; direct SQLite UTF-8 string bindings can lose those.
 */
export class LiveDeliveryIndex {
  readonly #db: DatabaseSync;
  readonly #generations = new WeakSet<LiveGeneration>();
  readonly #path: string;
  #stamp = "";
  #closed = false;

  private constructor(path: string) {
    this.#path = path;
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`
      PRAGMA cache_size=-16384;
      PRAGMA mmap_size=0;
      PRAGMA temp_store=FILE;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=OFF;
      CREATE TABLE generations (
        generation INTEGER PRIMARY KEY, recording TEXT UNIQUE NOT NULL,
        stamp TEXT NOT NULL, remaining INTEGER NOT NULL, conflicting INTEGER NOT NULL
      );
      CREATE TABLE stt (generation INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(generation,key)) WITHOUT ROWID;
      CREATE TABLE packets (
        generation INTEGER NOT NULL, packet TEXT NOT NULL COLLATE BINARY,
        offset INTEGER NOT NULL, length INTEGER NOT NULL, delivered INTEGER NOT NULL,
        speaker TEXT, time INTEGER, media INTEGER, sequence INTEGER,
        PRIMARY KEY(generation, packet)
      ) WITHOUT ROWID;
      CREATE INDEX eligible_packet_order ON packets(generation,time,speaker,media,sequence,packet)
        WHERE length>0 AND delivered=0;
    `);
      this.#stamp = this.#fileStamp();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  public static async create(root: string): Promise<LiveDeliveryIndex> {
    const directory = join(root, "live-delivery-cache-v1");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "live cache root is unsafe");
    }
    // Called only after the runtime has acquired exclusive spool ownership.
    await rm(directory, { recursive: true });
    await mkdir(directory, { mode: 0o700 });
    return new LiveDeliveryIndex(join(directory, "metadata.sqlite"));
  }

  public close(): void {
    if (!this.#closed) { this.#db.close(); this.#closed = true; }
  }

  #fileStamp(): string {
    const stat = lstatSync(this.#path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) { return "unsafe"; }
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  }

  public valid(): boolean {
    try { return !this.#closed && this.#stamp === this.#fileStamp(); }
    catch { return false; }
  }

  #access<T>(operation: () => T): T {
    if (!this.valid()) {
      throw new RecordingIngressError("corrupt-spool", "live metadata cache invalidated");
    }
    try {
      const result = operation();
      this.#stamp = this.#fileStamp();
      return result;
    } catch (error) {
      this.#stamp = "invalid";
      throw error;
    }
  }

  // Generation numbers are local to one disposable database and can be reused
  // after recreation. Never query or mutate a new cache with an old handle.
  #assertGeneration(index: LiveGeneration): void {
    if (!this.#generations.has(index)) {
      throw new RecordingIngressError("corrupt-spool", "live metadata cache generation changed");
    }
  }

  public find(recording: string): LiveGeneration | undefined {
    const found = this.#access(() => this.#db.prepare("SELECT * FROM generations WHERE recording=?")
      .get(JSON.stringify(recording)) as unknown as LiveGeneration | undefined);
    if (found === undefined) { return undefined; }
    const index = { ...found, recording };
    this.#generations.add(index);
    return index;
  }

  public begin(recording: string): LiveGeneration {
    const generation = Number(this.#access(() => this.#db.prepare(`INSERT INTO generations
      (recording,stamp,remaining,conflicting) VALUES (?,'invalid',0,0)`)
      .run(JSON.stringify(recording)).lastInsertRowid));
    const index = { generation, recording, stamp: "invalid", remaining: 0, conflicting: 0 };
    this.#generations.add(index);
    return index;
  }

  public invalidate(index: LiveGeneration): void {
    this.#assertGeneration(index);
    this.#access(() => this.#db.prepare("UPDATE generations SET stamp='invalid' WHERE generation=?")
      .run(index.generation));
  }

  public publish(index: LiveGeneration): void {
    this.#assertGeneration(index);
    this.#access(() => this.#db.prepare("UPDATE generations SET stamp=?,remaining=?,conflicting=? WHERE generation=?")
      .run(index.stamp, index.remaining, index.conflicting, index.generation));
  }

  public get(index: LiveGeneration, packet: string): LiveOffset | undefined {
    this.#assertGeneration(index);
    const found = this.#access(() => this.#db.prepare("SELECT packet,offset,length,delivered FROM packets WHERE generation=? AND packet=?")
      .get(index.generation, JSON.stringify(packet)) as unknown as LiveOffset | undefined);
    return found === undefined ? undefined : { ...found, packet };
  }

  public put(index: LiveGeneration, row: LiveOffset): void {
    this.#assertGeneration(index);
    this.#access(() => this.#db.prepare(`INSERT INTO packets (generation,packet,offset,length,delivered) VALUES (?,?,?,?,?) ON CONFLICT(generation,packet)
      DO UPDATE SET offset=excluded.offset,length=excluded.length,delivered=excluded.delivered`)
      .run(index.generation, JSON.stringify(row.packet), row.offset, row.length, row.delivered));
  }

  public pending(index: LiveGeneration, after: string): LiveOffset[] {
    this.#assertGeneration(index);
    const rows = this.#access(() => this.#db.prepare(`SELECT packet,offset,length,delivered FROM packets
      WHERE generation=? AND packet>? AND length>0 AND delivered=0 ORDER BY packet LIMIT 256`)
      .all(index.generation, after === "" ? "" : JSON.stringify(after)) as unknown as LiveOffset[]);
    return rows.map((row) => ({ ...row, packet: JSON.parse(row.packet) as string }));
  }

  public packetOrder(index: LiveGeneration, packet: string, speaker: string, order: { time: number; media: number; sequence: number }): void {
    this.#assertGeneration(index);
    this.#access(() => this.#db.prepare(`UPDATE packets SET speaker=?,time=?,media=?,sequence=?
      WHERE generation=? AND packet=?`).run(`speaker:${JSON.stringify(speaker)}`, order.time, order.media, order.sequence,
      index.generation, JSON.stringify(packet)));
  }

  public eligible(index: LiveGeneration, after: string): LiveOffset[] {
    this.#assertGeneration(index);
    const rows = this.#access(() => this.#db.prepare(`SELECT p.packet,p.offset,p.length,p.delivered FROM packets p
      LEFT JOIN stt s ON s.generation=p.generation AND s.key=p.speaker
      WHERE p.generation=? AND p.length>0 AND p.delivered=0 AND json_extract(s.value,'$.fence') IS NULL
      AND (?='' OR (p.time,p.speaker,p.media,p.sequence,p.packet) >
        (SELECT time,speaker,media,sequence,packet FROM packets WHERE generation=p.generation AND packet=?))
      ORDER BY p.time,p.speaker,p.media,p.sequence,p.packet LIMIT 256`)
      .all(index.generation, after, JSON.stringify(after)) as unknown as LiveOffset[]);
    return rows.map((row) => ({ ...row, packet: JSON.parse(row.packet) as string }));
  }

  public sttGet<T>(index: LiveGeneration, key: SttCacheKey<T>): T | undefined {
    this.#assertGeneration(index);
    const row = this.#access(() => this.#db.prepare("SELECT value FROM stt WHERE generation=? AND key=?")
      .get(index.generation, key) as { value: string } | undefined);
    return row === undefined ? undefined : JSON.parse(row.value) as T;
  }

  public sttPut(index: LiveGeneration, key: string, value: unknown): void {
    this.#assertGeneration(index);
    this.#access(() => this.#db.prepare("INSERT INTO stt VALUES (?,?,?) ON CONFLICT(generation,key) DO UPDATE SET value=excluded.value")
      .run(index.generation, key, JSON.stringify(value)));
  }

  public sttSpeakers(index: LiveGeneration, after: string): { key: string; value: string }[] {
    this.#assertGeneration(index);
    return this.#access(() => this.#db.prepare("SELECT key,value FROM stt WHERE generation=? AND key LIKE 'speaker:%' AND key>? ORDER BY key LIMIT 256")
      .all(index.generation, after) as { key: string; value: string }[]);
  }

  public async forget(index: LiveGeneration): Promise<void> {
    this.#assertGeneration(index);
    this.invalidate(index);
    this.#access(() => this.#db.prepare("DELETE FROM stt WHERE generation=?").run(index.generation));
    let removed: number | bigint;
    do {
      removed = this.#access(() => this.#db.prepare(`DELETE FROM packets WHERE generation=? AND packet IN
        (SELECT packet FROM packets WHERE generation=? LIMIT 256)`)
        .run(index.generation, index.generation).changes);
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    } while (removed !== 0 && removed !== 0n);
    this.#access(() => this.#db.prepare("DELETE FROM generations WHERE generation=?").run(index.generation));
  }
}
