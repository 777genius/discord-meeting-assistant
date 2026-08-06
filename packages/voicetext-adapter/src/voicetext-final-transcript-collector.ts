import {
  type SpeakerAudioReferenceSnapshot,
} from "@discord-meeting/meeting-core/recording";

import { VoicetextAdapterError } from "./errors.js";
import {
  voicetextFinalPcmBytesPerSecond,
  type ValidatedVoicetextFinalTranscriptionOptions,
} from "./voicetext-final-transcription-configuration.js";
import {
  addVoicetextFinalSafeIntegers,
  stableVoicetextFinalId,
  type VoicetextFinalProviderTurn,
} from "./voicetext-final-transcription-support.js";
import type { VoicetextFinalSegment } from "./protocol.js";

export class VoicetextFinalTranscriptCollector {
  private readonly fingerprints = new Set<string>();
  private readonly segments: VoicetextFinalSegment[] = [];
  private totalCharacters = 0;

  public constructor(
    private readonly options: Pick<
      ValidatedVoicetextFinalTranscriptionOptions,
      | "maxSegmentOverrunMs"
      | "maxSegmentsPerSpeaker"
      | "maxTranscriptCharsPerSpeaker"
    >,
  ) {}

  public collect(message: VoicetextFinalSegment): void {
    if (this.segments.length >= this.options.maxSegmentsPerSpeaker) {
      throw new VoicetextAdapterError(
        "limit_exceeded",
        "Voicetext returned too many final segments",
        false,
      );
    }
    const fingerprint = message.startMs + ":" + message.durationMs + ":" + message.text;
    if (this.fingerprints.has(fingerprint)) {
      return;
    }
    const totalCharacters = this.totalCharacters + message.text.length;
    if (
      !Number.isSafeInteger(totalCharacters) ||
      totalCharacters > this.options.maxTranscriptCharsPerSpeaker
    ) {
      throw new VoicetextAdapterError(
        "limit_exceeded",
        "Voicetext transcript exceeded its configured character limit",
        false,
      );
    }
    this.fingerprints.add(fingerprint);
    this.segments.push(message);
    this.totalCharacters = totalCharacters;
  }

  public toTurns(
    pcmBytes: number,
    reference: SpeakerAudioReferenceSnapshot,
    speakerIndex: number,
    idempotencyKey: string,
  ): readonly VoicetextFinalProviderTurn[] {
    const audioDurationMs = Math.floor(
      pcmBytes / voicetextFinalPcmBytesPerSecond * 1_000,
    );
    let previousEndMs = -1;
    return this.segments.flatMap((segment, segmentIndex): readonly VoicetextFinalProviderTurn[] => {
      const text = segment.text.trim();
      if (text.length === 0) {
        return [];
      }
      if (segment.durationMs < 1 || segment.startMs < previousEndMs) {
        throw new VoicetextAdapterError(
          "invalid_provider_response",
          "Voicetext final segments are overlapping or out of order",
          false,
        );
      }
      const relativeEndMs = addVoicetextFinalSafeIntegers(
        segment.startMs,
        segment.durationMs,
      );
      if (relativeEndMs > audioDurationMs + this.options.maxSegmentOverrunMs) {
        throw new VoicetextAdapterError(
          "invalid_provider_response",
          "Voicetext final segment exceeds the speaker audio duration",
          false,
        );
      }
      previousEndMs = relativeEndMs;
      const startMs = addVoicetextFinalSafeIntegers(
        reference.timelineOffsetMs,
        segment.startMs,
      );
      const endMs = addVoicetextFinalSafeIntegers(
        reference.timelineOffsetMs,
        relativeEndMs,
      );
      return [{
        endMs,
        speakerId: reference.speakerId,
        stableTurnId: stableVoicetextFinalId(
          "turn",
          idempotencyKey,
          String(speakerIndex + 1),
          String(segmentIndex + 1),
        ),
        startMs,
        text,
      }];
    });
  }
}
