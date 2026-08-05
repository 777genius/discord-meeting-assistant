import { VoicetextAdapterError } from "./errors.js";

interface TimelineAnchor {
  readonly providerStartSamples: number;
  readonly sourceStartSamples: number;
}

export interface VoicetextLiveTimelineCheckpoint {
  readonly anchorCount: number;
  readonly providerCursorSamples: number;
  readonly sourceCursorSamples: number | undefined;
}

export class VoicetextLiveTimeline {
  private providerCursorSamples = 0;
  private sourceCursorSamples: number | undefined;
  private readonly timelineAnchors: TimelineAnchor[] = [];

  public get hasAnchors(): boolean {
    return this.timelineAnchors.length > 0;
  }

  public checkpoint(): VoicetextLiveTimelineCheckpoint {
    return {
      anchorCount: this.timelineAnchors.length,
      providerCursorSamples: this.providerCursorSamples,
      sourceCursorSamples: this.sourceCursorSamples,
    };
  }

  public restore(checkpoint: VoicetextLiveTimelineCheckpoint): void {
    this.providerCursorSamples = checkpoint.providerCursorSamples;
    this.sourceCursorSamples = checkpoint.sourceCursorSamples;
    this.timelineAnchors.length = checkpoint.anchorCount;
  }

  public reserve(relativeTimeMs: number, durationSamples48Khz: number): void {
    const sourceStartSamples = relativeTimeMs * 48;
    if (
      this.sourceCursorSamples === undefined ||
      sourceStartSamples !== this.sourceCursorSamples
    ) {
      this.timelineAnchors.push({
        providerStartSamples: this.providerCursorSamples,
        sourceStartSamples,
      });
    }
    const nextProviderCursorSamples = this.providerCursorSamples + durationSamples48Khz;
    if (!Number.isSafeInteger(nextProviderCursorSamples)) {
      throw new VoicetextAdapterError(
        "limit_exceeded",
        "Live provider timeline exceeds the safe integer range",
        false,
      );
    }
    this.providerCursorSamples = nextProviderCursorSamples;
    this.sourceCursorSamples = sourceStartSamples + durationSamples48Khz;
  }

  public mapProviderTimeToSource(
    providerTimeMs: number,
    boundary: "end" | "start",
  ): number {
    const providerTimeSamples = providerTimeMs * 48;
    if (!Number.isSafeInteger(providerTimeSamples)) {
      throw new VoicetextAdapterError(
        "protocol_error",
        "Live provider timeline exceeds the safe integer range",
        false,
      );
    }
    let lower = 0;
    let upper = this.timelineAnchors.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      const anchor = this.timelineAnchors[middle];
      if (anchor === undefined) {
        throw new VoicetextAdapterError("protocol_error", "Live timeline anchor is missing", false);
      }
      const belongsToAnchor = boundary === "start"
        ? anchor.providerStartSamples <= providerTimeSamples
        : anchor.providerStartSamples < providerTimeSamples;
      if (belongsToAnchor) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    const anchor = this.timelineAnchors[Math.max(0, lower - 1)];
    if (anchor === undefined) {
      throw new VoicetextAdapterError("protocol_error", "Live timeline anchor is missing", false);
    }
    return Math.round(
      (anchor.sourceStartSamples + providerTimeSamples - anchor.providerStartSamples) / 48,
    );
  }
}
