import { createHash } from "node:crypto";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CraigPlaybackCommand, CraigPlaybackEvent } from
  "@discord-meeting/craig-gateway-contracts";
import type { CraigPlaybackTransport } from "@discord-meeting/craig-playback-adapter";
import { PostgresLiveMeetingRepository } from "@discord-meeting/postgres-adapter";
import type { Pool } from "pg";
import { expect } from "vitest";

import type { VirtualClock } from "./providerless-voice-durability-fixtures.js";

const roomId = "voice-room-providerless-durability";
const platformRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const assetRoot = join(platformRoot, "assets");

export interface StoredPlaybackEvent {
  readonly acceptedAtMs?: number;
  readonly attemptId: string;
  readonly cancellationObservedAtMs?: number;
  readonly meetingId?: string;
  readonly pcmBase64?: string;
  readonly pcmSha256?: string;
  readonly phase: string;
  readonly reason?: string;
  readonly schemaVersion?: number;
  readonly sequence?: number;
  readonly turnId: string;
  readonly type: CraigPlaybackCommand["type"];
}

interface DurablePlaybackTransportInput {
  readonly clock: VirtualClock;
  readonly meetingId: string;
  readonly phase: string;
  readonly root: string;
}

export class DurableCraigPlaybackTransport implements CraigPlaybackTransport {
  public activeAttempts = 0;
  public bufferedBytes = 0;
  public readonly identity;
  public peakActiveAttempts = 0;
  public peakBufferedBytes = 0;
  public peakPendingWrites = 0;
  public pendingWrites = 0;
  private closeListener: (reason: string) => void = () => {};
  private readonly deduplicatedAttempts = new Set<string>();
  private readonly durableStartedAtMs = new Map<string, number>();
  private readonly durablyStartedAttempts = new Set<string>();
  private eventListener: (event: CraigPlaybackEvent) => void = () => {};
  private readonly firstAudioAcceptedAt = new Map<string, number>();
  private readonly firstAudioWaiters = new Map<string, Set<(acceptedAt: number) => void>>();
  private readonly eventPath: string;
  private readonly playbackConfirmedAttempts = new Set<string>();
  private readonly startedAttempts = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private readonly trackPath: string;

  private constructor(private readonly input: DurablePlaybackTransportInput) {
    this.identity = {
      channelId: roomId,
      gatewaySessionId: `${input.phase}-gateway-session`,
      guildId: "providerless-guild",
      recordingId: input.meetingId,
    };
    this.eventPath = join(input.root, "botik-track-events.ndjson");
    this.trackPath = join(input.root, "botik-authoritative-track.pcm");
  }

  public static async open(
    input: DurablePlaybackTransportInput,
  ): Promise<DurableCraigPlaybackTransport> {
    const transport = new DurableCraigPlaybackTransport(input);
    await Promise.all([
      writeFile(transport.eventPath, "", { flag: "a" }),
      writeFile(transport.trackPath, "", { flag: "a" }),
    ]);
    for (const event of await readEvents(input.root)) {
      if (event.type === "audio-chunk" && event.acceptedAtMs !== undefined) {
        transport.durablyStartedAttempts.add(event.attemptId);
        if (!transport.durableStartedAtMs.has(event.attemptId)) {
          transport.durableStartedAtMs.set(event.attemptId, event.acceptedAtMs);
        }
      }
    }
    return transport;
  }

  public close(_code: number, reason: string): void {
    this.closeListener(reason);
  }

  public onClose(listener: (reason: string) => void): void {
    this.closeListener = listener;
  }

  public onEvent(listener: (event: CraigPlaybackEvent) => void): void {
    this.eventListener = listener;
  }

  public send(command: CraigPlaybackCommand): Promise<void> {
    const accepted = this.acceptAfter(this.tail, command);
    this.tail = this.ignoreFailure(accepted);
    return accepted;
  }

  private async acceptAfter(
    preceding: Promise<void>,
    command: CraigPlaybackCommand,
  ): Promise<void> {
    await preceding;
    this.pendingWrites += 1;
    this.peakPendingWrites = Math.max(this.peakPendingWrites, this.pendingWrites);
    try {
      await this.accept(command);
    } finally {
      this.pendingWrites -= 1;
    }
  }

  private async ignoreFailure(operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } catch {
      // The returned promise retains the failure; the transport tail only serializes later writes.
    }
  }

  public whenFirstAudioAccepted(
    turnId: string,
    timeoutMs: number,
  ): Promise<number> {
    const observed = this.firstAudioAcceptedAt.get(turnId);
    if (observed !== undefined) {
      return Promise.resolve(observed);
    }
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.firstAudioWaiters.get(turnId)?.delete(accept);
        reject(new Error(`first audio was not accepted for ${turnId}`));
      }, timeoutMs);
      timeout.unref();
      const accept = (acceptedAt: number): void => {
        clearTimeout(timeout);
        this.firstAudioWaiters.get(turnId)?.delete(accept);
        resolve(acceptedAt);
      };
      const waiters = this.firstAudioWaiters.get(turnId) ?? new Set();
      waiters.add(accept);
      this.firstAudioWaiters.set(turnId, waiters);
    });
  }

  public async whenIdle(): Promise<void> {
    await this.tail;
  }

  public async finalizeAuthoritativeRecording(): Promise<void> {
    await this.whenIdle();
    const [track, eventLog] = await Promise.all([
      readFile(this.trackPath),
      readFile(this.eventPath),
    ]);
    await writeFile(
      join(this.input.root, "botik-authoritative-manifest.json"),
      `${JSON.stringify({
        byteLength: track.byteLength,
        eventLogSha256: sha256(eventLog),
        recordingId: this.input.meetingId,
        schemaVersion: 1,
        sha256: sha256(track),
        status: "authoritative-ready",
      })}\n`,
      { flag: "wx" },
    );
  }

  private async accept(command: CraigPlaybackCommand): Promise<void> {
    if (command.type === "audio-chunk") {
      this.observeFirstAudio(command.turnId);
    }
    if (
      command.type === "playback-start" &&
      this.durablyStartedAttempts.has(command.attemptId)
    ) {
      this.deduplicatedAttempts.add(command.attemptId);
      this.eventListener({
        attemptId: command.attemptId,
        recordingId: command.recordingId,
        schemaVersion: 1,
        startedAtMs: this.durableStartedAtMs.get(command.attemptId) ??
          this.input.clock.nowMilliseconds(),
        turnId: command.turnId,
        type: "playback-started",
      });
      return;
    }
    if (this.deduplicatedAttempts.has(command.attemptId)) {
      if (command.type === "playback-finish" || command.type === "playback-cancel") {
        this.deduplicatedAttempts.delete(command.attemptId);
        this.eventListener({
          attemptId: command.attemptId,
          finishedAtMs: this.input.clock.nowMilliseconds(),
          recordingId: command.recordingId,
          schemaVersion: 1,
          turnId: command.turnId,
          type: "playback-finished",
        });
      }
      return;
    }
    if (command.type === "playback-start") {
      this.startedAttempts.add(command.attemptId);
      this.activeAttempts = this.startedAttempts.size;
      this.peakActiveAttempts = Math.max(
        this.peakActiveAttempts,
        this.activeAttempts,
      );
    }
    let pcmBase64: string | undefined;
    let pcmSha256: string | undefined;
    if (command.type === "audio-chunk") {
      const bytes = Buffer.from(command.pcmBase64, "base64");
      this.bufferedBytes += bytes.byteLength;
      this.peakBufferedBytes = Math.max(this.peakBufferedBytes, this.bufferedBytes);
      try {
        await appendFile(this.trackPath, bytes);
        pcmBase64 = command.pcmBase64;
        pcmSha256 = sha256(bytes);
      } finally {
        this.bufferedBytes -= bytes.byteLength;
      }
    }
    const acceptedAtMs = this.input.clock.nowMilliseconds();
    const stored: StoredPlaybackEvent = {
      acceptedAtMs,
      attemptId: command.attemptId,
      ...(command.type === "playback-cancel" && command.schemaVersion === 2
        ? {
            cancellationObservedAtMs: command.cancellationObservedAtMs,
            meetingId: command.meetingId,
            reason: command.reason,
            schemaVersion: command.schemaVersion,
          }
        : {}),
      ...(pcmBase64 === undefined ? {} : { pcmBase64 }),
      ...(pcmSha256 === undefined ? {} : { pcmSha256 }),
      ...(command.type === "audio-chunk" ? { sequence: command.sequence } : {}),
      phase: this.input.phase,
      turnId: command.turnId,
      type: command.type,
    };
    await appendFile(this.eventPath, `${JSON.stringify(stored)}\n`, "utf8");
    if (command.type === "audio-chunk" && !this.startedAttempts.has(command.attemptId)) {
      throw new Error("Craig accepted PCM before playback-start");
    }
    if (
      command.type === "audio-chunk" &&
      !this.playbackConfirmedAttempts.has(command.attemptId)
    ) {
      this.playbackConfirmedAttempts.add(command.attemptId);
      this.durablyStartedAttempts.add(command.attemptId);
      this.durableStartedAtMs.set(command.attemptId, acceptedAtMs);
      this.eventListener({
        attemptId: command.attemptId,
        recordingId: command.recordingId,
        schemaVersion: 1,
        startedAtMs: acceptedAtMs,
        turnId: command.turnId,
        type: "playback-started",
      });
    }
    if (command.type === "playback-finish" || command.type === "playback-cancel") {
      this.playbackConfirmedAttempts.delete(command.attemptId);
      this.startedAttempts.delete(command.attemptId);
      this.activeAttempts = this.startedAttempts.size;
      this.eventListener({
        attemptId: command.attemptId,
        finishedAtMs: this.input.clock.nowMilliseconds(),
        recordingId: command.recordingId,
        schemaVersion: 1,
        turnId: command.turnId,
        type: "playback-finished",
      });
    }
  }

  private observeFirstAudio(turnId: string): void {
    if (this.firstAudioAcceptedAt.has(turnId)) {
      return;
    }
    const acceptedAt = performance.now();
    this.firstAudioAcceptedAt.set(turnId, acceptedAt);
    const waiters = this.firstAudioWaiters.get(turnId);
    this.firstAudioWaiters.delete(turnId);
    for (const accept of waiters ?? []) {
      accept(acceptedAt);
    }
  }
}

export async function completedReceiptStates(
  pool: Pool,
  expectedCount: number,
): Promise<readonly string[]> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const result = await pool.query<{ readonly state: string }>(
      "SELECT state FROM meeting_core.conversation_one_shot_receipts ORDER BY receipt_id",
    );
    const states = result.rows.map(({ state }) => state);
    if (states.length === expectedCount && states.every((state) =>
      state === "completed" || state === "played" || state === "suppressed"
    )) {
      return states;
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `conversation one-shot receipts did not reach ${expectedCount} terminal rows`,
      );
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

export async function readEvents(root: string): Promise<readonly StoredPlaybackEvent[]> {
  const text = await readFile(join(root, "botik-track-events.ndjson"), "utf8");
  const lines = text.split("\n");
  if (!text.endsWith("\n")) {
    lines.pop();
  }
  return lines.filter(Boolean).map((line) =>
    JSON.parse(line) as StoredPlaybackEvent
  );
}

export function playbackStarts(
  events: readonly StoredPlaybackEvent[],
  turnId: string,
): readonly StoredPlaybackEvent[] {
  return events.filter((event) =>
    event.turnId === turnId && event.type === "playback-start"
  );
}

export function greetingStarts(
  events: readonly StoredPlaybackEvent[],
): readonly StoredPlaybackEvent[] {
  return events.filter((event) =>
    event.type === "playback-start" && event.turnId.startsWith("participant-greeting:")
  );
}

export function audioChunks(
  events: readonly StoredPlaybackEvent[],
  turnId: string,
): readonly StoredPlaybackEvent[] {
  return events.filter((event) =>
    event.turnId === turnId && event.type === "audio-chunk"
  );
}

export function completedTurn(events: readonly StoredPlaybackEvent[], turnId: string): boolean {
  return playbackStarts(events, turnId).length === 1 &&
    audioChunks(events, turnId).length > 0 &&
    events.filter((event) =>
      event.turnId === turnId && event.type === "playback-finish"
    ).length === 1 &&
    !events.some((event) =>
      event.turnId === turnId && event.type === "playback-cancel"
    );
}

export function turnPcmSha256(
  events: readonly StoredPlaybackEvent[],
  turnId: string,
): string {
  const bytes = Buffer.concat(audioChunks(events, turnId).map(({ pcmBase64 }) => {
    if (pcmBase64 === undefined) {
      throw new Error("recorded PCM event is missing bytes");
    }
    return Buffer.from(pcmBase64, "base64");
  }));
  return sha256(bytes);
}

export async function farewellSha256(locale: "en" | "ru"): Promise<string> {
  const manifest = JSON.parse(await readFile(
    join(assetRoot, "farewell-cues", "manifest.json"),
    "utf8",
  )) as Record<"en" | "ru", { readonly sha256: string }>;
  return manifest[locale].sha256;
}

export async function expectAuthoritativeRecording(
  root: string,
  meetingId: string,
): Promise<void> {
  const [track, eventLog, manifestText, trackStats] = await Promise.all([
    readFile(join(root, "botik-authoritative-track.pcm")),
    readFile(join(root, "botik-track-events.ndjson")),
    readFile(join(root, "botik-authoritative-manifest.json"), "utf8"),
    stat(join(root, "botik-authoritative-track.pcm")),
  ]);
  const manifest = JSON.parse(manifestText) as {
    readonly byteLength: number;
    readonly eventLogSha256: string;
    readonly recordingId: string;
    readonly schemaVersion: number;
    readonly sha256: string;
    readonly status: string;
  };
  expect(manifest).toEqual({
    byteLength: track.byteLength,
    eventLogSha256: sha256(eventLog),
    recordingId: meetingId,
    schemaVersion: 1,
    sha256: sha256(track),
    status: "authoritative-ready",
  });
  expect(trackStats.size).toBeGreaterThan(0);
}

export async function waitForEvidence(
  root: string,
  condition: (events: readonly StoredPlaybackEvent[]) => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (condition(await readEvents(root))) {
      return;
    }
    if (performance.now() >= deadline) {
      throw new Error("providerless playback evidence condition timed out");
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

export async function waitForPersistedTurn(
  meetings: PostgresLiveMeetingRepository,
  meetingId: string,
  turnId: string,
): Promise<void> {
  // A disposable PostgreSQL process can checkpoint slowly under constrained CI;
  // this bound is test liveness, not a product latency assertion.
  const deadline = performance.now() + 10_000;
  for (;;) {
    const persisted = await meetings.readSnapshotAndTimeline(meetingId);
    if (persisted?.timeline.some(({ turn }) => turn.turnId === turnId) === true) {
      return;
    }
    if (performance.now() >= deadline) {
      throw new Error(`turn ${turnId} was not persisted before the deadline`);
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
