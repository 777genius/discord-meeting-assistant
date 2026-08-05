import type {
  DurableCraigRecordingIngressOptions,
  RecordingIngressLimits,
} from "./contracts.js";
import { RecordingIngressAbortedError, RecordingIngressError } from "./errors.js";
import { journalFileSize, journalPacketIdentity, scanJournal } from "./journal.js";
import {
  journalPacketFingerprint,
  normalizeLocatorPrefix,
  validateLimits,
} from "./recording-ingress-invariants.js";
import { DurableSpool, type StoredSpeaker } from "./spool.js";

const ACTIVE_CAPACITY_LOCK = Symbol("active-capacity");
const MAX_CACHED_JOURNAL_PACKETS = 1_000_000;
const noOperation = (): void => undefined;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new RecordingIngressAbortedError();
  }
}

export interface CachedJournalIndex {
  journalBytes: number;
  opusBytes: number;
  packetCount: number;
  readonly packetFingerprintsByIdentity: Map<string, string>;
}

export class RecordingIngressRuntime {
  public readonly artifactLocatorPrefix: string;
  public readonly limits: RecordingIngressLimits;
  public readonly spool: DurableSpool;
  public readonly writer: DurableCraigRecordingIngressOptions["writer"];
  #cachedJournalPackets = 0;
  #activeOperations = 0;
  #closing: Promise<void> | undefined;
  #idleResolver: (() => void) | undefined;
  #ownership: Promise<void> | undefined;
  readonly #journalIndexes = new Map<string, Map<string, CachedJournalIndex>>();
  readonly #locks = new Map<string | symbol, Promise<void>>();

  public constructor(options: DurableCraigRecordingIngressOptions) {
    this.artifactLocatorPrefix = normalizeLocatorPrefix(options.artifactLocatorPrefix);
    this.limits = validateLimits(options.limits);
    this.spool = new DurableSpool(options.spoolRoot);
    this.writer = options.writer;
  }

  public async exclusive<T>(key: string | symbol, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release = noOperation;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === tail) {
        this.#locks.delete(key);
      }
    }
  }

  /**
   * Admits work only while this runtime owns the complete local spool. Keeping
   * ownership for the runtime lifetime makes a rolling replacement fail before
   * either process can mutate a recording journal or receipt.
   */
  public async withExclusiveSpoolOwnership<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    await this.acquireExclusiveSpoolOwnership();
    throwIfAborted(signal);
    if (this.#closing !== undefined) {
      throw new RecordingIngressError("invalid-state", "recording ingress runtime is closed");
    }
    this.#activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        this.#idleResolver?.();
        this.#idleResolver = undefined;
      }
    }
  }

  public close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  public async acquireExclusiveSpoolOwnership(): Promise<void> {
    if (this.#closing !== undefined) {
      throw new RecordingIngressError("invalid-state", "recording ingress runtime is closed");
    }
    this.#ownership ??= this.spool.claimExclusiveOwnership();
    await this.#ownership;
  }

  public async reserveActiveRecordingCapacity<T>(operation: () => Promise<T>): Promise<T> {
    return this.exclusive(ACTIVE_CAPACITY_LOCK, operation);
  }

  public async journalIndex(
    recordingId: string,
    speaker: StoredSpeaker,
  ): Promise<CachedJournalIndex> {
    const journalPath = this.spool.speakerJournalPath(recordingId, speaker.fileToken);
    const recordingIndexes = this.#journalIndexes.get(recordingId);
    const cached = recordingIndexes?.get(speaker.speakerId);
    if (cached !== undefined && recordingIndexes !== undefined) {
      if (await journalFileSize(journalPath) === cached.journalBytes) {
        this.#refreshCachedJournalIndex(recordingId, speaker.speakerId, recordingIndexes, cached);
        return cached;
      }
      this.forgetJournalIndex(recordingId, speaker.speakerId);
    }
    const scan = await scanJournal(journalPath, {
      maxOpusBytesPerPacket: this.limits.maxOpusBytesPerPacket,
      maxPackets: this.limits.maxPacketsPerSpeaker,
      repairIncompleteTail: true,
    });
    const index: CachedJournalIndex = {
      journalBytes: scan.journalBytes,
      opusBytes: scan.opusBytes,
      packetCount: scan.packets.length,
      packetFingerprintsByIdentity: new Map(
        scan.packets.map((packet) => [
          journalPacketIdentity(packet),
          journalPacketFingerprint(packet),
        ]),
      ),
    };
    this.#cacheJournalIndex(recordingId, speaker.speakerId, index);
    return index;
  }

  public noteJournalAppend(
    recordingId: string,
    speakerId: string,
    index: CachedJournalIndex,
    packetCount: number,
  ): void {
    if (this.#journalIndexes.get(recordingId)?.get(speakerId) !== index) {
      return;
    }
    this.#cachedJournalPackets += packetCount;
    if (this.#cachedJournalPackets > MAX_CACHED_JOURNAL_PACKETS) {
      this.forgetJournalIndexes(recordingId);
    }
  }

  public forgetJournalIndexes(recordingId: string): void {
    const recordingIndexes = this.#journalIndexes.get(recordingId);
    if (recordingIndexes === undefined) {
      return;
    }
    for (const index of recordingIndexes.values()) {
      this.#cachedJournalPackets -= index.packetCount;
    }
    this.#journalIndexes.delete(recordingId);
  }

  public async cleanupAfterSuccess(recordingId: string): Promise<void> {
    this.forgetJournalIndexes(recordingId);
    try {
      await this.spool.cleanupActive(recordingId);
    } catch {
      // The durable completion receipt is authoritative. A later replay retries
      // cleanup, but cleanup failure cannot turn confirmed artifact writes into
      // an unknown outcome.
    }
  }

  async #close(): Promise<void> {
    const ownership = this.#ownership;
    if (ownership !== undefined) {
      try {
        await ownership;
      } catch {
        // This runtime did not claim the marker, so it cannot release it.
        return;
      }
    }
    if (this.#activeOperations > 0) {
      await new Promise<void>((resolve) => {
        this.#idleResolver = resolve;
      });
    }
    await this.spool.releaseExclusiveOwnership();
  }

  #refreshCachedJournalIndex(
    recordingId: string,
    speakerId: string,
    recordingIndexes: Map<string, CachedJournalIndex>,
    cached: CachedJournalIndex,
  ): void {
    if (this.#journalIndexes.get(recordingId)?.get(speakerId) === cached) {
      // Map insertion order acts as a recording-level LRU.
      this.#journalIndexes.delete(recordingId);
      this.#journalIndexes.set(recordingId, recordingIndexes);
      return;
    }
    // Another recording may have evicted this index while the file stat was in
    // flight. Re-cache through the accounting path.
    this.#cacheJournalIndex(recordingId, speakerId, cached);
  }

  #cacheJournalIndex(recordingId: string, speakerId: string, index: CachedJournalIndex): void {
    for (const cachedRecordingId of this.#journalIndexes.keys()) {
      if (
        this.#cachedJournalPackets + index.packetCount <= MAX_CACHED_JOURNAL_PACKETS ||
        cachedRecordingId === recordingId
      ) {
        continue;
      }
      this.forgetJournalIndexes(cachedRecordingId);
    }
    if (this.#cachedJournalPackets + index.packetCount > MAX_CACHED_JOURNAL_PACKETS) {
      return;
    }
    let recordingIndexes = this.#journalIndexes.get(recordingId);
    if (recordingIndexes === undefined) {
      recordingIndexes = new Map();
      this.#journalIndexes.set(recordingId, recordingIndexes);
    }
    const replaced = recordingIndexes.get(speakerId);
    if (replaced !== undefined) {
      this.#cachedJournalPackets -= replaced.packetCount;
    }
    recordingIndexes.set(speakerId, index);
    this.#cachedJournalPackets += index.packetCount;
  }

  private forgetJournalIndex(recordingId: string, speakerId: string): void {
    const recordingIndexes = this.#journalIndexes.get(recordingId);
    const forgotten = recordingIndexes?.get(speakerId);
    if (recordingIndexes === undefined || forgotten === undefined) {
      return;
    }
    recordingIndexes.delete(speakerId);
    this.#cachedJournalPackets -= forgotten.packetCount;
    if (recordingIndexes.size === 0) {
      this.#journalIndexes.delete(recordingId);
    }
  }
}
