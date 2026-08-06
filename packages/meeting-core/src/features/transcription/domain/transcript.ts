import {
  DomainInvariantError,
  requireNonEmpty,
  requireNonNegativeInteger,
  requirePositiveInteger,
} from "./errors.js";
import {
  createRecordingId,
  createSpeakerId,
  type RecordingId,
  type SpeakerId,
} from "../../recording/index.js";
import {
  createTranscriptId,
  createTranscriptTurnId,
  type TranscriptId,
  type TranscriptTurnId,
} from "./identifiers.js";

export interface TranscriptTurnSnapshot {
  readonly endMs: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
  readonly turnId: string;
}

export interface FinalTranscriptSnapshot {
  readonly recordingId: string;
  readonly transcriptId: string;
  readonly turns: readonly TranscriptTurnSnapshot[];
  readonly version: number;
}

export class TranscriptTurn {
  public readonly turnId: TranscriptTurnId;
  public readonly speakerId: SpeakerId;
  public readonly startMs: number;
  public readonly endMs: number;
  public readonly text: string;

  private constructor(snapshot: TranscriptTurnSnapshot) {
    this.turnId = createTranscriptTurnId(snapshot.turnId);
    this.speakerId = createSpeakerId(snapshot.speakerId);
    this.startMs = requireNonNegativeInteger(snapshot.startMs, "transcriptTurn.startMs");
    this.endMs = requireNonNegativeInteger(snapshot.endMs, "transcriptTurn.endMs");
    if (this.endMs <= this.startMs) {
      throw new DomainInvariantError(
        "INVALID_NUMBER",
        "transcriptTurn.endMs must be greater than startMs",
      );
    }
    this.text = requireNonEmpty(snapshot.text, "transcriptTurn.text");
  }

  public static create(snapshot: TranscriptTurnSnapshot): TranscriptTurn {
    return new TranscriptTurn(snapshot);
  }

  public overlaps(other: TranscriptTurn): boolean {
    return this.startMs < other.endMs && other.startMs < this.endMs;
  }

  public toSnapshot(): TranscriptTurnSnapshot {
    return {
      endMs: this.endMs,
      speakerId: this.speakerId,
      startMs: this.startMs,
      text: this.text,
      turnId: this.turnId,
    };
  }

  public equals(other: TranscriptTurn): boolean {
    return (
      this.turnId === other.turnId &&
      this.speakerId === other.speakerId &&
      this.startMs === other.startMs &&
      this.endMs === other.endMs &&
      this.text === other.text
    );
  }
}

export class FinalTranscript {
  public readonly transcriptId: TranscriptId;
  public readonly recordingId: RecordingId;
  public readonly version: number;
  public readonly turns: readonly TranscriptTurn[];

  private readonly turnsById: ReadonlyMap<TranscriptTurnId, TranscriptTurn>;

  private constructor(snapshot: FinalTranscriptSnapshot) {
    this.transcriptId = createTranscriptId(snapshot.transcriptId);
    this.recordingId = createRecordingId(snapshot.recordingId);
    this.version = requirePositiveInteger(snapshot.version, "transcript.version");

    const turns = snapshot.turns.map((turn) => TranscriptTurn.create(turn));
    this.turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));
    if (this.turnsById.size !== turns.length) {
      throw new DomainInvariantError(
        "DUPLICATE_IDENTIFIER",
        "transcript turn IDs must be unique",
      );
    }
    this.turns = Object.freeze(turns);
  }

  public static create(snapshot: FinalTranscriptSnapshot): FinalTranscript {
    return new FinalTranscript(snapshot);
  }

  public hasTurn(turnId: string): boolean {
    return this.turnsById.has(createTranscriptTurnId(turnId));
  }

  public hasSpeaker(speakerId: string): boolean {
    const expected = createSpeakerId(speakerId);
    return this.turns.some((turn) => turn.speakerId === expected);
  }

  public overlappingPairs(): readonly (readonly [TranscriptTurn, TranscriptTurn])[] {
    const pairs: Array<readonly [TranscriptTurn, TranscriptTurn]> = [];
    for (let leftIndex = 0; leftIndex < this.turns.length; leftIndex += 1) {
      const left = this.turns[leftIndex];
      if (left === undefined) {
        continue;
      }
      for (let rightIndex = leftIndex + 1; rightIndex < this.turns.length; rightIndex += 1) {
        const right = this.turns[rightIndex];
        if (right !== undefined && left.overlaps(right)) {
          pairs.push(Object.freeze([left, right]));
        }
      }
    }

    return Object.freeze(pairs);
  }

  public toSnapshot(): FinalTranscriptSnapshot {
    return {
      recordingId: this.recordingId,
      transcriptId: this.transcriptId,
      turns: this.turns.map((turn) => turn.toSnapshot()),
      version: this.version,
    };
  }

  public equals(other: FinalTranscript): boolean {
    return (
      this.transcriptId === other.transcriptId &&
      this.recordingId === other.recordingId &&
      this.version === other.version &&
      this.turns.length === other.turns.length &&
      this.turns.every((turn, index) => {
        const candidate = other.turns[index];
        return candidate !== undefined && turn.equals(candidate);
      })
    );
  }
}
