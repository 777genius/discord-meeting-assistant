const observerApplicationId = "1533867700575670282";

export function voiceObservation(
  purpose: "addressed-answer" | "farewell" | "greeting",
  turnId: string,
  attemptId: string,
  startMs: number,
) {
  return {
    capture: {
      acceptedDurationMilliseconds: 500,
      acceptedPacketCount: 25,
      cancellation: { status: "not-observed" as const },
      endedAt: captureTimestamp(startMs + 500),
      expectedDuration: { maximumMilliseconds: 600, minimumMilliseconds: 500 },
      firstPacketAt: captureTimestamp(startMs),
      ignoredDuplicatePacketCount: 0,
      ignoredLatePacketCount: 0,
      limits: {
        captureTimeoutMilliseconds: 2_000,
        maxCaptureDurationMilliseconds: 60_000,
        maxPcmBytes: 11_520_000,
      },
      pcm: {
        byteLength: 96_000,
        channels: 2 as const,
        encoding: "s16le" as const,
        nonSilence: {
          sampleCount: 48_000,
          sampleCountAboveThreshold: 4_800,
          sampleRatioAboveThreshold: 0.1,
          thresholdSample: 256,
        },
        rms: 512,
        sampleRateHertz: 48_000 as const,
        sha256: "a".repeat(64),
      },
      startedAt: captureTimestamp(startMs - 100),
      termination: "expected-duration-reached" as const,
    },
    correlation: purpose === "addressed-answer"
      ? {
        attemptId,
        meetingId: "meeting-1",
        playbackKind: "answer" as const,
        provenance: "playback-readiness-handshake" as const,
        purpose,
        recordingId: "meeting-1",
        verification: "not-run" as const,
        turnId,
      }
      : {
        attemptId,
        provenance: "operator-supplied" as const,
        purpose,
        recordingId: "meeting-1",
        verification: "not-run" as const,
        turnId,
      },
    kind: "conversation-voice-observer-evidence" as const,
    observer: {
      applicationId: observerApplicationId,
      authenticatedBotId: observerApplicationId,
      guildId: "1533228590643155034",
      privateTestGuildConfirmed: true as const,
      voiceChannelId: "1533228823045214398",
    },
    runId: "run-overlap-1",
    schemaVersion: 3 as const,
    source: {
      codec: "opus" as const,
      craigBotId: "1533877611258708230",
      decodedPcm: {
        channels: 2 as const,
        encoding: "s16le" as const,
        sampleRateHertz: 48_000 as const,
      },
      receiver: "@discordjs/voice" as const,
    },
    transcriptVerification: { status: "not-run" as const },
  };
}

export function deployedService(
  composeProject: string,
  composeService: string,
  containerDigit: string,
  imageDigit: string,
  revisionDigit: string,
) {
  return {
    composeConfigHash: "3".repeat(64),
    composeProject,
    composeService,
    containerId: containerDigit.repeat(64),
    containerStartedAt: "1969-12-31T23:00:00.000Z",
    imageId: `sha256:${imageDigit.repeat(64)}`,
    repositoryDigest: null,
    sourceRevision: revisionDigit.repeat(40),
  };
}

function captureTimestamp(epochMilliseconds: number) {
  return { epochMilliseconds, monotonicMilliseconds: epochMilliseconds };
}
