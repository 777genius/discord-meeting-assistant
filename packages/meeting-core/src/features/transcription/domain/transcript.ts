import {
  DomainInvariantError,
  requireNonEmpty,
  requireNonNegativeInteger,
  requirePositiveInteger,
} from "./errors.js";
import {
  createRecordingId,
  createSpeakerId,
  RecordingInvariantError,
  type RecordingId,
  type SpeakerId,
} from "../../recording/index.js";
import {
  createTranscriptId,
  createTranscriptTurnId,
  type TranscriptId,
  type TranscriptTurnId,
} from "./identifiers.js";

function translateRecordingIdentifier<Value>(create: () => Value): Value {
  try {
    return create();
  } catch (error) {
    if (error instanceof RecordingInvariantError) {
      throw new DomainInvariantError(error.code, error.message);
    }
    throw error;
  }
}

export interface TranscriptTurnSnapshot {
  readonly endMs: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
  readonly turnId: string;
}

export interface TranscriptReadableSegmentSnapshot {
  readonly segmentId: string;
  readonly speakerId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly sourceTurnIds: readonly string[];
}

export interface FinalTranscriptSnapshot {
  /** Optional only while reading legacy persisted snapshots; new snapshots always emit it. */
  readonly readableSegments?: readonly TranscriptReadableSegmentSnapshot[];
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
    this.speakerId = translateRecordingIdentifier(() =>
      createSpeakerId(snapshot.speakerId),
    );
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
  public readonly readableSegments: readonly TranscriptReadableSegmentSnapshot[];

  private readonly turnsById: ReadonlyMap<TranscriptTurnId, TranscriptTurn>;

  private constructor(snapshot: FinalTranscriptSnapshot) {
    this.transcriptId = createTranscriptId(snapshot.transcriptId);
    this.recordingId = translateRecordingIdentifier(() =>
      createRecordingId(snapshot.recordingId),
    );
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

    this.readableSegments = this.normalizeReadableSegments(snapshot.readableSegments);
  }

  public static create(snapshot: FinalTranscriptSnapshot): FinalTranscript {
    return new FinalTranscript(snapshot);
  }

  public hasTurn(turnId: string): boolean {
    return this.turnsById.has(createTranscriptTurnId(turnId));
  }

  public hasSpeaker(speakerId: string): boolean {
    const expected = translateRecordingIdentifier(() =>
      createSpeakerId(speakerId),
    );
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
      readableSegments: this.readableSegments,
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
      this.readableSegments.length === other.readableSegments.length &&
      this.readableSegments.every((segment, index) => {
        const candidate = other.readableSegments[index];
        return (
          candidate !== undefined &&
          segment.segmentId === candidate.segmentId &&
          segment.speakerId === candidate.speakerId &&
          segment.startMs === candidate.startMs &&
          segment.endMs === candidate.endMs &&
          segment.text === candidate.text &&
          segment.sourceTurnIds.length === candidate.sourceTurnIds.length &&
          segment.sourceTurnIds.every(
            (sourceTurnId, sourceIndex) =>
              sourceTurnId === candidate.sourceTurnIds[sourceIndex],
          )
        );
      }) &&
      this.turns.length === other.turns.length &&
      this.turns.every((turn, index) => {
        const candidate = other.turns[index];
        return candidate !== undefined && turn.equals(candidate);
      })
    );
  }

  private validateReadableSegment(
    snapshot: TranscriptReadableSegmentSnapshot,
  ): TranscriptReadableSegmentSnapshot {
    const segmentId = requireNonEmpty(snapshot.segmentId, "readableSegment.segmentId");
    const speakerId = translateRecordingIdentifier(() =>
      createSpeakerId(snapshot.speakerId),
    );
    const startMs = requireNonNegativeInteger(
      snapshot.startMs,
      "readableSegment.startMs",
    );
    const endMs = requireNonNegativeInteger(snapshot.endMs, "readableSegment.endMs");
    if (endMs <= startMs) {
      throw new DomainInvariantError(
        "INVALID_NUMBER",
        "readableSegment.endMs must be greater than startMs",
      );
    }
    const text = requireNonEmpty(snapshot.text, "readableSegment.text");
    if (snapshot.sourceTurnIds.length === 0) {
      throw new DomainInvariantError(
        "EMPTY_VALUE",
        "readableSegment.sourceTurnIds must not be empty",
      );
    }
    const normalizedSourceTurnIds = snapshot.sourceTurnIds.map((sourceTurnId, index) =>
      createTranscriptTurnId(
        requireNonEmpty(sourceTurnId, `readableSegment.sourceTurnIds[${index}]`),
      )
    );
    if (new Set(normalizedSourceTurnIds).size !== normalizedSourceTurnIds.length) {
      throw new DomainInvariantError(
        "DUPLICATE_IDENTIFIER",
        "readableSegment.sourceTurnIds must be unique",
      );
    }

    const sourceTurns = normalizedSourceTurnIds.map((normalizedId) => {
      const turn = this.turnsById.get(normalizedId);
      if (turn === undefined) {
        throw new DomainInvariantError(
          "INVALID_REFERENCE",
          `readable segment references unknown transcript turn ${normalizedId}`,
        );
      }
      if (turn.speakerId !== speakerId) {
        throw new DomainInvariantError(
          "INVALID_REFERENCE",
          "readable segment source turns must all have the segment speaker",
        );
      }
      return turn;
    });
    const envelopeStartMs = Math.min(...sourceTurns.map((turn) => turn.startMs));
    const envelopeEndMs = Math.max(...sourceTurns.map((turn) => turn.endMs));
    if (startMs < envelopeStartMs || endMs > envelopeEndMs) {
      throw new DomainInvariantError(
        "INVALID_NUMBER",
        "readable segment interval must be contained within its source turn envelope",
      );
    }

    return Object.freeze({
      endMs,
      segmentId,
      sourceTurnIds: Object.freeze(
        sourceTurns.map((sourceTurn) => sourceTurn.turnId),
      ),
      speakerId,
      startMs,
      text,
    });
  }

  private normalizeReadableSegments(
    snapshots: readonly TranscriptReadableSegmentSnapshot[] | undefined,
  ): readonly TranscriptReadableSegmentSnapshot[] {
    if (snapshots === undefined) {
      return Object.freeze([]);
    }
    try {
      const readableSegments = snapshots.map((segment) =>
        this.validateReadableSegment(segment),
      );
      const segmentIds = new Set(readableSegments.map((segment) => segment.segmentId));
      if (segmentIds.size !== readableSegments.length) {
        throw new DomainInvariantError(
          "DUPLICATE_IDENTIFIER",
          "transcript readable segment IDs must be unique",
        );
      }
      const coveredTurnIds = new Set(
        readableSegments.flatMap(({ sourceTurnIds }) => sourceTurnIds),
      );
      if (
        readableSegments.length > 0 &&
        this.turns.some((turn) => !coveredTurnIds.has(turn.turnId))
      ) {
        throw new DomainInvariantError(
          "INVALID_REFERENCE",
          "transcript readable segments must cover every authoritative turn",
        );
      }
      return Object.freeze(readableSegments);
    } catch {
      // Readability is derived and cannot invalidate authoritative raw turns.
      return Object.freeze([]);
    }
  }
}
