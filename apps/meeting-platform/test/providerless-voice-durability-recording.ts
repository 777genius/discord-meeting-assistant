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
  readonly attemptId: string;
  readonly cancellationObservedAtMs?: number;
  readonly meetingId?: string;
  readonly pcmBase64?: string;
  readonly pcmSha256?: string;
  readonly phase: string;
  readonly reason?: string;
  readonly schemaVersion?: number;
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
  private eventListener: (event: CraigPlaybackEvent) => void = () => {};
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
    this.pendingWrites += 1;
    this.peakPendingWrites = Math.max(this.peakPendingWrites, this.pendingWrites);
    const accepted = this.tail.then(() => this.accept(command));
    this.tail = accepted.catch(() => {});
    return accepted.finally(() => {
      this.pendingWrites -= 1;
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
    const stored: StoredPlaybackEvent = {
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
      this.eventListener({
        attemptId: command.attemptId,
        recordingId: command.recordingId,
        schemaVersion: 1,
        startedAtMs: this.input.clock.nowMilliseconds(),
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
}

export async function completedReceiptStates(pool: Pool): Promise<readonly string[]> {
  const result = await pool.query<{ readonly state: string }>(
    "SELECT state FROM meeting_core.conversation_one_shot_receipts ORDER BY receipt_id",
  );
  return result.rows.map(({ state }) => state);
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

export async function readGreetingManifest(): Promise<ReadonlyMap<string, string>> {
  const manifest = JSON.parse(await readFile(
    join(assetRoot, "greeting-cues", "manifest.json"),
    "utf8",
  )) as { readonly cues: readonly { readonly sha256: string; readonly text: string }[] };
  return new Map(manifest.cues.map(({ sha256: digest, text }) => [text, digest]));
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
  const deadline = performance.now() + 2_000;
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
