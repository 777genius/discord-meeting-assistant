export type RecordingPlaybackStatus = "processing" | "ready" | "unavailable";

export interface RecordingPlaybackTrack {
  readonly audioLocator: string;
  readonly timelineOffsetMs: number;
}

export interface RecordingPlaybackSnapshot {
  readonly status: RecordingPlaybackStatus;
  readonly tracks: readonly RecordingPlaybackTrack[];
}

export interface RecordingPlaybackCatalog {
  findByMeetingId(meetingId: string): Promise<RecordingPlaybackSnapshot>;
}

export type RecordingPlaybackByteRange =
  | { readonly end?: number; readonly start: number }
  | { readonly suffixLength: number };

export interface RecordingPlaybackAudioDescriptor {
  readonly contentType: string;
  readonly eTag?: string;
  readonly sizeBytes: number;
}

export interface RecordingPlaybackAudioReadResult
  extends RecordingPlaybackAudioDescriptor {
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentLength: number;
  readonly range?: { readonly end: number; readonly start: number };
}

export interface RecordingPlaybackAudioReader {
  describe(input: {
    readonly locator: string;
    readonly signal?: AbortSignal;
  }): Promise<RecordingPlaybackAudioDescriptor>;

  read(input: {
    readonly locator: string;
    readonly range?: RecordingPlaybackByteRange;
    readonly signal?: AbortSignal;
  }): Promise<RecordingPlaybackAudioReadResult>;
}

export interface RecordingPlaybackManifest {
  readonly status: RecordingPlaybackStatus;
  readonly tracks: readonly {
    readonly index: number;
    readonly timelineOffsetMs: number;
  }[];
}

export class RecordingPlaybackNotReadyError extends Error {
  public constructor(public readonly status: Exclude<RecordingPlaybackStatus, "ready">) {
    super("Recording playback is not ready");
    this.name = "RecordingPlaybackNotReadyError";
  }
}

export class RecordingPlaybackTrackNotFoundError extends Error {
  public constructor() {
    super("Recording playback track was not found");
    this.name = "RecordingPlaybackTrackNotFoundError";
  }
}

export class GetRecordingPlayback {
  public constructor(
    private readonly catalog: RecordingPlaybackCatalog,
    private readonly audio: RecordingPlaybackAudioReader,
  ) {}

  public async manifest(meetingId: string): Promise<RecordingPlaybackManifest> {
    const snapshot = await this.catalog.findByMeetingId(meetingId);
    return {
      status: snapshot.status,
      tracks: snapshot.status === "ready"
        ? snapshot.tracks.map((track, index) => ({
            index,
            timelineOffsetMs: track.timelineOffsetMs,
          }))
        : [],
    };
  }

  public async describeTrack(input: {
    readonly meetingId: string;
    readonly signal?: AbortSignal;
    readonly trackIndex: number;
  }): Promise<RecordingPlaybackAudioDescriptor> {
    const track = await this.requireTrack(input.meetingId, input.trackIndex);
    return this.audio.describe({
      locator: track.audioLocator,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public async readTrack(input: {
    readonly meetingId: string;
    readonly range?: RecordingPlaybackByteRange;
    readonly signal?: AbortSignal;
    readonly trackIndex: number;
  }): Promise<RecordingPlaybackAudioReadResult> {
    const track = await this.requireTrack(input.meetingId, input.trackIndex);
    return this.audio.read({
      locator: track.audioLocator,
      ...(input.range === undefined ? {} : { range: input.range }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  private async requireTrack(
    meetingId: string,
    trackIndex: number,
  ): Promise<RecordingPlaybackTrack> {
    if (!Number.isSafeInteger(trackIndex) || trackIndex < 0) {
      throw new RecordingPlaybackTrackNotFoundError();
    }
    const snapshot = await this.catalog.findByMeetingId(meetingId);
    if (snapshot.status !== "ready") {
      throw new RecordingPlaybackNotReadyError(snapshot.status);
    }
    const track = snapshot.tracks[trackIndex];
    if (track === undefined) {
      throw new RecordingPlaybackTrackNotFoundError();
    }
    return track;
  }
}
