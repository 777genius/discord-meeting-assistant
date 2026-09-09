import type { OssSessionEvidence } from "./oss-native-evidence.js";
import type { OpenVoicetextLiveSessionRequest } from "./voicetext-live-transcription-configuration.js";
import type {
  VoicetextFinalSegment,
  VoicetextPartialSegment,
} from "./protocol.js";
import { VoicetextLiveTimeline } from "./voicetext-live-timeline.js";

export class VoicetextLiveTranscriptEmitter {
  private readonly finalFingerprints = new Set<string>();

  public constructor(
    private readonly request: OpenVoicetextLiveSessionRequest,
    private readonly timeline: VoicetextLiveTimeline,
    private readonly evidence?: OssSessionEvidence,
  ) {}

  public emit(
    segment: VoicetextFinalSegment | VoicetextPartialSegment,
    isFinal: boolean,
  ): void {
    const text = segment.text.trim();
    if (text.length === 0 || !this.timeline.hasAnchors) {
      return;
    }
    if (isFinal && !this.rememberFinalSegment(segment, text)) {
      return;
    }
    try {
      const emitted = {
        ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
        endMs: this.timeline.mapProviderTimeToSource(segment.startMs + segment.durationMs, "end"),
        isFinal,
        meetingId: this.request.meetingId,
        speakerId: this.request.speakerId,
        startMs: this.timeline.mapProviderTimeToSource(segment.startMs, "start"),
        text,
      };
      this.request.onTranscript(emitted);
      this.evidence?.record({ type: "transcript_emitted", startMs: emitted.startMs, endMs: emitted.endMs, text, isFinal });
    } catch {
      // Observer failures must not corrupt the provider receive loop.
    }
  }

  private rememberFinalSegment(
    segment: VoicetextFinalSegment | VoicetextPartialSegment,
    text: string,
  ): boolean {
    const fingerprint = segment.startMs + "\0" + segment.durationMs + "\0" + text;
    if (this.finalFingerprints.has(fingerprint)) {
      return false;
    }
    this.finalFingerprints.add(fingerprint);
    return true;
  }
}
