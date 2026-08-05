import type {
  LiveRuntimeClock,
  LiveRuntimeLogger,
  LiveTranscriptionEvent,
} from "./contracts.js";

export function logFinalizedLiveTranscript(input: {
  readonly clock: LiveRuntimeClock;
  readonly event: LiveTranscriptionEvent;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly startedAtMs: number;
}): void {
  input.logger.info("Live transcript turn finalized", {
    endMs: input.event.endMs,
    meetingId: input.meetingId,
    providerLagMs: Math.max(
      0,
      input.clock.nowMilliseconds() - (input.startedAtMs + input.event.endMs),
    ),
    speakerId: input.event.speakerId,
    startMs: input.event.startMs,
  });
}
