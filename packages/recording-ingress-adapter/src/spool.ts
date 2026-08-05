import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";

import { RecordingIngressError } from "./errors.js";
import { SpoolOwnerLock } from "./spool-owner-lock.js";
import { terminalReceiptTokens } from "./spool-terminal-receipts.js";

type RecordingSpoolStatus = "active" | "aborted" | "finalizing";

export interface StoredLifecycleEvent {
  readonly digest: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly type: string;
}

export interface StoredSpeaker {
  readonly fileToken: string;
  readonly speakerId: string;
}

export interface StoredAuthoritativeTrack {
  readonly audioLocator: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly speakerId: string;
  readonly timelineOffsetMs: number;
  readonly trackNumber: number;
  readonly uploadId: string;
}

export interface RecordingSpoolState {
  readonly authoritativeTracks: readonly StoredAuthoritativeTrack[];
  readonly channelId: string;
  readonly endedAt?: string;
  readonly events: readonly StoredLifecycleEvent[];
  readonly finalEventDigest?: string;
  readonly finalEventId?: string;
  readonly guildId: string;
  readonly pendingAuthoritativeTracks: readonly StoredAuthoritativeTrack[];
  readonly recordingId: string;
  readonly schemaVersion: 1;
  readonly speakers: readonly StoredSpeaker[];
  readonly startedAt: string;
  readonly status: RecordingSpoolStatus;
}

export type AbortedRecordingState = RecordingSpoolState & {
  readonly endedAt: string;
  readonly status: "aborted";
};

export interface CompletedRecordingState {
  /**
   * Immutable identities of the bytes accepted before finalization. This is
   * deliberately retained beside the public recording snapshot: the snapshot
   * alone cannot prove whether a later upload is an exact retry.
   */
  readonly authoritativeTracks: readonly StoredAuthoritativeTrack[];
  readonly channelId: string;
  readonly events: readonly StoredLifecycleEvent[];
  readonly finalEventDigest: string;
  readonly finalEventId: string;
  readonly guildId: string;
  readonly recording: {
    readonly manifestLocator: string;
    readonly recordingId: string;
    readonly speakerAudio: readonly {
      readonly audioLocator: string;
      readonly speakerId: string;
      readonly timelineOffsetMs: number;
    }[];
  };
  readonly recordingId: string;
  readonly schemaVersion: 2;
}

let atomicWriteSequence = 0;

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordingIngressError("corrupt-spool", "spool metadata is not an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecordingIngressError("corrupt-spool", `invalid spool field: ${field}`);
  }
  return value;
}

function parseStoredEvent(value: unknown): StoredLifecycleEvent {
  const record = objectValue(value);
  return {
    digest: stringValue(record.digest, "events.digest"),
    eventId: stringValue(record.eventId, "events.eventId"),
    occurredAt: stringValue(record.occurredAt, "events.occurredAt"),
    type: stringValue(record.type, "events.type"),
  };
}

function parseStoredSpeaker(value: unknown): StoredSpeaker {
  const record = objectValue(value);
  return {
    fileToken: stringValue(record.fileToken, "speakers.fileToken"),
    speakerId: stringValue(record.speakerId, "speakers.speakerId"),
  };
}

function parseStoredAuthoritativeTrack(value: unknown): StoredAuthoritativeTrack {
  const record = objectValue(value);
  if (
    !Number.isSafeInteger(record.sizeBytes) ||
    (record.sizeBytes as number) <= 0 ||
    !Number.isSafeInteger(record.timelineOffsetMs) ||
    (record.timelineOffsetMs as number) < 0 ||
    !Number.isSafeInteger(record.trackNumber) ||
    (record.trackNumber as number) < 1
  ) {
    throw new RecordingIngressError("corrupt-spool", "invalid authoritative track metadata");
  }
  const checksumSha256 = stringValue(record.checksumSha256, "authoritativeTracks.checksumSha256");
  if (!/^[0-9a-f]{64}$/u.test(checksumSha256)) {
    throw new RecordingIngressError("corrupt-spool", "invalid authoritative track checksum");
  }
  return {
    audioLocator: stringValue(record.audioLocator, "authoritativeTracks.audioLocator"),
    checksumSha256,
    sizeBytes: record.sizeBytes as number,
    speakerId: stringValue(record.speakerId, "authoritativeTracks.speakerId"),
    timelineOffsetMs: record.timelineOffsetMs as number,
    trackNumber: record.trackNumber as number,
    uploadId: stringValue(record.uploadId, "authoritativeTracks.uploadId"),
  };
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}

function parseRecordingSpoolState(input: unknown): RecordingSpoolState {
  const record = objectValue(input);
  if (record.schemaVersion !== 1 || !Array.isArray(record.events) || !Array.isArray(record.speakers)) {
    throw new RecordingIngressError("corrupt-spool", "unsupported spool metadata schema");
  }
  if (record.status !== "active" && record.status !== "aborted" && record.status !== "finalizing") {
    throw new RecordingIngressError("corrupt-spool", "invalid spool recording status");
  }
  const endedAt = optionalString(record.endedAt, "endedAt");
  const finalEventDigest = optionalString(record.finalEventDigest, "finalEventDigest");
  const finalEventId = optionalString(record.finalEventId, "finalEventId");
  return {
    authoritativeTracks: Array.isArray(record.authoritativeTracks)
      ? record.authoritativeTracks.map(parseStoredAuthoritativeTrack)
      : [],
    channelId: stringValue(record.channelId, "channelId"),
    ...(endedAt === undefined ? {} : { endedAt }),
    events: record.events.map(parseStoredEvent),
    ...(finalEventDigest === undefined ? {} : { finalEventDigest }),
    ...(finalEventId === undefined ? {} : { finalEventId }),
    guildId: stringValue(record.guildId, "guildId"),
    pendingAuthoritativeTracks: Array.isArray(record.pendingAuthoritativeTracks)
      ? record.pendingAuthoritativeTracks.map(parseStoredAuthoritativeTrack)
      : [],
    recordingId: stringValue(record.recordingId, "recordingId"),
    schemaVersion: 1,
    speakers: record.speakers.map(parseStoredSpeaker),
    startedAt: stringValue(record.startedAt, "startedAt"),
    status: record.status,
  };
}

function parseAbortedRecordingState(input: unknown): AbortedRecordingState {
  const state = parseRecordingSpoolState(input);
  if (state.status !== "aborted" || state.endedAt === undefined) {
    throw new RecordingIngressError("corrupt-spool", "aborted receipt is not terminal");
  }
  return { ...state, endedAt: state.endedAt, status: "aborted" };
}

function parseCompletedRecordingState(input: unknown): CompletedRecordingState {
  const record = objectValue(input);
  const recording = objectValue(record.recording);
  if (
    record.schemaVersion !== 2 ||
    !Array.isArray(record.events) ||
    !Array.isArray(record.authoritativeTracks) ||
    !Array.isArray(recording.speakerAudio)
  ) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion receipt does not contain immutable authoritative track identities",
    );
  }
  const authoritativeTracks = record.authoritativeTracks.map(parseStoredAuthoritativeTrack);
  const speakerAudio = recording.speakerAudio.map((value) => {
    const reference = objectValue(value);
    if (!Number.isSafeInteger(reference.timelineOffsetMs) || (reference.timelineOffsetMs as number) < 0) {
      throw new RecordingIngressError("corrupt-spool", "invalid completion timeline offset");
    }
    return {
      audioLocator: stringValue(reference.audioLocator, "audioLocator"),
      speakerId: stringValue(reference.speakerId, "speakerId"),
      timelineOffsetMs: reference.timelineOffsetMs as number,
    };
  });
  const recordingId = stringValue(record.recordingId, "recordingId");
  if (recording.recordingId !== recordingId) {
    throw new RecordingIngressError("corrupt-spool", "completion recording identity does not match");
  }
  assertCompletedTrackIdentity(authoritativeTracks, speakerAudio);
  return {
    authoritativeTracks,
    channelId: stringValue(record.channelId, "channelId"),
    events: record.events.map(parseStoredEvent),
    finalEventDigest: stringValue(record.finalEventDigest, "finalEventDigest"),
    finalEventId: stringValue(record.finalEventId, "finalEventId"),
    guildId: stringValue(record.guildId, "guildId"),
    recording: {
      manifestLocator: stringValue(recording.manifestLocator, "manifestLocator"),
      recordingId: stringValue(recording.recordingId, "recording.recordingId"),
      speakerAudio,
    },
    recordingId,
    schemaVersion: 2,
  };
}

function assertCompletedTrackIdentity(
  tracks: readonly StoredAuthoritativeTrack[],
  speakerAudio: readonly {
    readonly audioLocator: string;
    readonly speakerId: string;
    readonly timelineOffsetMs: number;
  }[],
): void {
  if (tracks.length !== speakerAudio.length) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion receipt track identity does not match the recording snapshot",
    );
  }
  const referencesBySpeaker = new Map<string, (typeof speakerAudio)[number]>();
  const uploadIds = new Set<string>();
  const trackNumbers = new Set<number>();
  for (const reference of speakerAudio) {
    if (referencesBySpeaker.has(reference.speakerId)) {
      throw new RecordingIngressError("corrupt-spool", "completion receipt repeats a speaker");
    }
    referencesBySpeaker.set(reference.speakerId, reference);
  }
  for (const track of tracks) {
    if (uploadIds.has(track.uploadId) || trackNumbers.has(track.trackNumber)) {
      throw new RecordingIngressError("corrupt-spool", "completion receipt repeats a track identity");
    }
    uploadIds.add(track.uploadId);
    trackNumbers.add(track.trackNumber);
    const reference = referencesBySpeaker.get(track.speakerId);
    if (
      reference === undefined ||
      reference.audioLocator !== track.audioLocator ||
      reference.timelineOffsetMs !== track.timelineOffsetMs
    ) {
      throw new RecordingIngressError(
        "corrupt-spool",
        "completion receipt track identity does not match the recording snapshot",
      );
    }
  }
}

export function spoolToken(namespace: string, identifier: string): string {
  return createHash("sha256").update(namespace).update("\0").update(identifier).digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  atomicWriteSequence += 1;
  const temporaryPath = `${path}.tmp-${process.pid}-${atomicWriteSequence}`;
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporaryPath, path);
  await syncDirectory(dirname(path));
}

export class DurableSpool {
  public readonly abortedRoot: string;
  public readonly activeRoot: string;
  public readonly completedRoot: string;
  public readonly root: string;
  #initialization: Promise<void> | undefined;
  readonly #ownerLock: SpoolOwnerLock;

  public constructor(root: string) {
    if (!isAbsolute(root)) {
      throw new RecordingIngressError("path-policy", "spool root must be absolute");
    }
    this.root = resolve(root);
    if (this.root === parse(this.root).root) {
      throw new RecordingIngressError("path-policy", "filesystem root cannot be used as spool root");
    }
    this.abortedRoot = join(this.root, "aborted-v1");
    this.activeRoot = join(this.root, "active-v1");
    this.completedRoot = join(this.root, "completed-v1");
    this.#ownerLock = new SpoolOwnerLock(this.root);
  }

  async #initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStats = await lstat(this.root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "spool root cannot be a symlink");
    }
    await mkdir(this.abortedRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.activeRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.completedRoot, { recursive: true, mode: 0o700 });
    for (const path of [this.abortedRoot, this.activeRoot, this.completedRoot]) {
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new RecordingIngressError("path-policy", "spool namespace is unsafe");
      }
    }
  }

  public async ready(): Promise<void> {
    this.#initialization ??= this.#initialize();
    await this.#initialization;
  }

  public recordingDirectory(recordingId: string): string {
    return join(this.activeRoot, spoolToken("recording-v1", recordingId));
  }

  public metadataPath(recordingId: string): string {
    return join(this.recordingDirectory(recordingId), "metadata.json");
  }

  public speakerDirectory(recordingId: string): string {
    return join(this.recordingDirectory(recordingId), "speakers");
  }

  public speakerJournalPath(recordingId: string, fileToken: string): string {
    if (!/^[a-f\d]{64}$/u.test(fileToken)) {
      throw new RecordingIngressError("path-policy", "invalid speaker spool token");
    }
    return join(this.speakerDirectory(recordingId), `${fileToken}.packets`);
  }

  public completedPath(recordingId: string): string {
    return join(this.completedRoot, `${spoolToken("recording-v1", recordingId)}.json`);
  }

  public abortedPath(recordingId: string): string {
    return join(this.abortedRoot, `${spoolToken("recording-v1", recordingId)}.json`);
  }

  public async createRecordingDirectories(recordingId: string): Promise<void> {
    await this.ready();
    const recordingDirectory = this.recordingDirectory(recordingId);
    await mkdir(recordingDirectory, { recursive: true, mode: 0o700 });
    const stats = await lstat(recordingDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "recording spool path is unsafe");
    }
    const speakerDirectory = this.speakerDirectory(recordingId);
    await mkdir(speakerDirectory, { recursive: true, mode: 0o700 });
    const speakerStats = await lstat(speakerDirectory);
    if (!speakerStats.isDirectory() || speakerStats.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "speaker spool path is unsafe");
    }
  }

  public async activeRecordingCount(): Promise<number> {
    await this.ready();
    const [activeEntries, abortedTokens, completedTokens] = await Promise.all([
      readdir(this.activeRoot, { withFileTypes: true }),
      terminalReceiptTokens(this.abortedRoot, parseAbortedRecordingState, (recordingId) => spoolToken("recording-v1", recordingId)),
      terminalReceiptTokens(this.completedRoot, parseCompletedRecordingState, (recordingId) => spoolToken("recording-v1", recordingId)),
    ]);
    const terminalTokens = new Set([...abortedTokens, ...completedTokens]);
    return activeEntries.filter(
      (entry) =>
        entry.isDirectory() &&
        /^[a-f\d]{64}$/u.test(entry.name) &&
        !terminalTokens.has(entry.name),
    ).length;
  }

  public async claimExclusiveOwnership(): Promise<void> {
    await this.ready();
    await this.#ownerLock.claim();
  }

  public async releaseExclusiveOwnership(): Promise<void> {
    await this.#ownerLock.release();
  }

  public async readRecording(recordingId: string): Promise<RecordingSpoolState | undefined> {
    await this.ready();
    try {
      return parseRecordingSpoolState(JSON.parse(await readFile(this.metadataPath(recordingId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        throw new RecordingIngressError("corrupt-spool", "spool metadata is invalid JSON", {
          cause: error,
        });
      }
      throw error;
    }
  }

  public async writeRecording(state: RecordingSpoolState): Promise<void> {
    await this.createRecordingDirectories(state.recordingId);
    await atomicWriteJson(this.metadataPath(state.recordingId), state);
  }

  public async readAborted(recordingId: string): Promise<AbortedRecordingState | undefined> {
    await this.ready();
    try {
      return parseAbortedRecordingState(
        JSON.parse(await readFile(this.abortedPath(recordingId), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        throw new RecordingIngressError("corrupt-spool", "aborted receipt is invalid JSON", {
          cause: error,
        });
      }
      throw error;
    }
  }

  public async archiveAborted(state: RecordingSpoolState): Promise<AbortedRecordingState> {
    await this.ready();
    const aborted = parseAbortedRecordingState(state);
    await atomicWriteJson(this.abortedPath(aborted.recordingId), aborted);
    await this.cleanupActive(aborted.recordingId);
    return aborted;
  }

  public async readCompleted(recordingId: string): Promise<CompletedRecordingState | undefined> {
    await this.ready();
    try {
      return parseCompletedRecordingState(
        JSON.parse(await readFile(this.completedPath(recordingId), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        throw new RecordingIngressError("corrupt-spool", "completion receipt is invalid JSON", {
          cause: error,
        });
      }
      throw error;
    }
  }

  public async writeCompleted(state: CompletedRecordingState): Promise<void> {
    await this.ready();
    await atomicWriteJson(this.completedPath(state.recordingId), state);
  }

  public async cleanupActive(recordingId: string): Promise<void> {
    await this.ready();
    await rm(this.recordingDirectory(recordingId), { recursive: true, force: true });
    await syncDirectory(this.activeRoot);
  }
}
