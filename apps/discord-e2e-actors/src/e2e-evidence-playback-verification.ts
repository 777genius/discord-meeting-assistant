import type { RetainedE2eEvidence } from "./e2e-evidence-schema.js";
import type {
  ActorRunVerificationContext,
  PlaybackWindow,
  VerificationFailureReporter,
} from "./e2e-evidence-verification-types.js";

export function playbackWindowsFrom(
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): readonly PlaybackWindow[] {
  const events = evidence.actorRun.events;
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (previous !== undefined && current !== undefined && current.atRecordingMs < previous.atRecordingMs) {
      fail("ACTOR_EVENTS_UNORDERED", "actor events must be retained in recording-time order");
      break;
    }
  }

  const open = new Map<string, number[]>();
  const windows: PlaybackWindow[] = [];
  for (const event of events) {
    if (event.type === "playback-start") {
      retainPlaybackStart(event, open, fail);
    }
    if (event.type === "playback-end") {
      retainPlaybackEnd(event, open, windows, fail);
    }
  }

  if ([...open.values()].some((starts) => starts.length > 0)) {
    fail("UNCLOSED_PLAYBACK", "every playback start must have a retained playback end");
  }
  return windows;
}

export function verifyActorRun(context: ActorRunVerificationContext): void {
  verifyFixturePlayback(context);
  if (context.scenario.requireReconnect) {
    verifyReconnect(context);
  }
  verifyScenarioTiming(context);
  verifyActorS3Timing(context);
  verifyPlaybackOverlap(context);
  verifyRecordingDuration(context);
}

function retainPlaybackStart(
  event: RetainedE2eEvidence["actorRun"]["events"][number],
  open: Map<string, number[]>,
  fail: VerificationFailureReporter,
): void {
  if (event.fixtureId === undefined) {
    fail("PLAYBACK_FIXTURE_MISSING", `${event.actorName} playback start has no fixture ID`);
    return;
  }
  const key = playbackKey(event.actorName, event.fixtureId);
  const starts = open.get(key) ?? [];
  starts.push(event.atRecordingMs);
  open.set(key, starts);
}

function retainPlaybackEnd(
  event: RetainedE2eEvidence["actorRun"]["events"][number],
  open: Map<string, number[]>,
  windows: PlaybackWindow[],
  fail: VerificationFailureReporter,
): void {
  if (event.fixtureId === undefined) {
    fail("PLAYBACK_FIXTURE_MISSING", `${event.actorName} playback end has no fixture ID`);
    return;
  }
  const starts = open.get(playbackKey(event.actorName, event.fixtureId));
  const startMs = starts?.shift();
  if (startMs === undefined || startMs >= event.atRecordingMs) {
    fail("INVALID_PLAYBACK_WINDOW", `${event.actorName} playback end has no earlier start`);
    return;
  }
  windows.push({
    actorName: event.actorName,
    endMs: event.atRecordingMs,
    fixtureId: event.fixtureId,
    startMs,
  });
}

function playbackKey(actorName: string, fixtureId: string): string {
  return `${actorName}:${fixtureId}`;
}

function verifyFixturePlayback(context: ActorRunVerificationContext): void {
  const { evidence, fail, manifest, playbackWindows, scenario } = context;
  const retainedFixtures = new Map(evidence.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  for (const fixture of manifest.fixtures) {
    const expectedCount = scenario.playbackCountByFixture[fixture.fixtureId];
    if (expectedCount === undefined) {
      fail("PLAYBACK_COUNT_MISSING", `scenario has no playback count for ${fixture.fixtureId}`);
      continue;
    }
    const fixtureWindows = playbackWindows.filter(({ fixtureId }) => fixtureId === fixture.fixtureId);
    if (fixtureWindows.some(({ actorName }) => actorName !== fixture.actorName)) {
      fail("FIXTURE_ACTOR_MISMATCH", `${fixture.fixtureId} was played by the wrong actor`);
    }
    if (fixtureWindows.length !== expectedCount) {
      fail(
        "PLAYBACK_COUNT_MISMATCH",
        `fixture ${fixture.fixtureId} played ${fixtureWindows.length} times instead of ${expectedCount}`,
      );
    }
    verifyPlaybackDurations(fixture.fixtureId, fixtureWindows, retainedFixtures, manifest, fail);
    verifyActorReady(evidence, fixture.actorName, fixtureWindows, fail);
  }
}

function verifyPlaybackDurations(
  fixtureId: string,
  windows: readonly PlaybackWindow[],
  retainedFixtures: ReadonlyMap<string, RetainedE2eEvidence["fixtures"][number]>,
  context: ActorRunVerificationContext["manifest"],
  fail: VerificationFailureReporter,
): void {
  const retainedFixture = retainedFixtures.get(fixtureId);
  if (retainedFixture === undefined) {
    return;
  }
  for (const window of windows) {
    const actualDuration = window.endMs - window.startMs;
    if (Math.abs(actualDuration - retainedFixture.durationMs) > context.thresholds.timestampToleranceMs) {
      fail("PLAYBACK_DURATION_MISMATCH", `${fixtureId} playback duration differs from ffprobe evidence`);
    }
  }
}

function verifyActorReady(
  evidence: RetainedE2eEvidence,
  actorName: string,
  windows: readonly PlaybackWindow[],
  fail: VerificationFailureReporter,
): void {
  const actorEvents = evidence.actorRun.events.filter((event) => event.actorName === actorName);
  for (const window of windows) {
    const ready = actorEvents.some(
      (event) => event.type === "ready" && event.atRecordingMs <= window.startMs,
    );
    if (!ready) {
      fail("ACTOR_NOT_READY", `${actorName} started playback before a retained ready event`);
    }
  }
}

function verifyActorS3Timing(context: ActorRunVerificationContext): void {
  const { evidence, fail, manifest, playbackWindows } = context;
  const recordingMediaOriginMs = Math.min(
    ...evidence.recording.s3.tracks.map(({ timelineOffsetMs }) => timelineOffsetMs),
  );
  for (const fixture of manifest.fixtures) {
    const fixtureWindows = playbackWindows.filter(({ fixtureId }) => fixtureId === fixture.fixtureId);
    const track = evidence.recording.s3.tracks.find(
      ({ speakerId }) => speakerId === fixture.speakerId,
    );
    if (track === undefined) {
      fail("ACTOR_S3_TRACK_MISSING", `${fixture.fixtureId} has no corresponding S3 track`);
      continue;
    }
    const trackEndMs = recordingMediaOriginMs + track.durationMs;
    for (const window of fixtureWindows) {
      const startsBeforeTrack =
        window.startMs + manifest.thresholds.timestampToleranceMs < track.timelineOffsetMs;
      const endsAfterTrack =
        window.endMs > trackEndMs + manifest.thresholds.timestampToleranceMs;
      if (startsBeforeTrack || endsAfterTrack) {
        fail(
          "ACTOR_S3_TIMELINE_MISMATCH",
          `${fixture.fixtureId} playback window is not covered by its S3 track timeline`,
        );
      }
    }
  }
}

function verifyScenarioTiming(context: ActorRunVerificationContext): void {
  const { evidence, fail, manifest, playbackWindows, scenario } = context;
  const speakerAFixture = manifest.fixtures.find(({ actorName }) => actorName === "speaker-a");
  const speakerBFixture = manifest.fixtures.find(({ actorName }) => actorName === "speaker-b");
  const speakerAWindow = playbackWindows.find(({ fixtureId }) => fixtureId === speakerAFixture?.fixtureId);
  const speakerBWindow = playbackWindows.find(({ fixtureId }) => fixtureId === speakerBFixture?.fixtureId);
  if (speakerAWindow === undefined || speakerBWindow === undefined) {
    return;
  }
  const reconnectDisconnect = evidence.actorRun.events.find(
    (event) => event.actorName === "speaker-b" && event.type === "disconnected",
  );
  const observedDelay = scenario.kind === "sequential"
    ? speakerBWindow.startMs - speakerAWindow.endMs
    : scenario.kind === "reconnect"
      ? (reconnectDisconnect?.atRecordingMs ?? speakerBWindow.startMs) - speakerAWindow.startMs
      : speakerBWindow.startMs - speakerAWindow.startMs;
  if (Math.abs(observedDelay - scenario.speakerBDelayMs) > manifest.thresholds.timestampToleranceMs) {
    fail("SCENARIO_DELAY_MISMATCH", `speaker-b delay ${observedDelay}ms is outside tolerance`);
  }
}

function verifyReconnect(context: ActorRunVerificationContext): void {
  const { evidence, fail, manifest, playbackWindows } = context;
  const speakerB = manifest.fixtures.find(({ actorName }) => actorName === "speaker-b");
  if (speakerB === undefined) {
    fail("RECONNECT_ACTOR_MISSING", "manifest must define speaker-b for reconnect proof");
    return;
  }
  const speakerBWindows = playbackWindows
    .filter(({ fixtureId }) => fixtureId === speakerB.fixtureId)
    .toSorted((left, right) => left.startMs - right.startMs);
  const playback = speakerBWindows[0];
  if (playback === undefined || speakerBWindows.length !== 1) {
    fail("RECONNECT_PLAYBACK_INVALID", "speaker-b must play exactly once after reconnect");
    return;
  }
  const speakerBEvents = evidence.actorRun.events.filter(
    ({ actorName }) => actorName === speakerB.actorName,
  );
  const expectedTypes = ["ready", "disconnected", "ready", "playback-start", "playback-end"] as const;
  if (
    speakerBEvents.length !== expectedTypes.length ||
    speakerBEvents.some((event, index) => event.type !== expectedTypes[index])
  ) {
    fail(
      "RECONNECT_SEQUENCE_INVALID",
      "speaker-b needs initial ready, disconnected, ready, then exactly one playback",
    );
    return;
  }
  verifyReconnectOrdering(manifest, playbackWindows, speakerBEvents, playback, fail);
}

function verifyReconnectOrdering(
  manifest: ActorRunVerificationContext["manifest"],
  windows: readonly PlaybackWindow[],
  speakerBEvents: readonly RetainedE2eEvidence["actorRun"]["events"][number][],
  playback: PlaybackWindow,
  fail: VerificationFailureReporter,
): void {
  const [initialReady, disconnected, reconnectedReady] = speakerBEvents;
  const speakerA = manifest.fixtures.find(({ actorName }) => actorName === "speaker-a");
  const speakerAWindow = windows.find(({ fixtureId }) => fixtureId === speakerA?.fixtureId);
  if (
    initialReady === undefined ||
    disconnected === undefined ||
    reconnectedReady === undefined ||
    (speakerAWindow !== undefined && initialReady.atRecordingMs > speakerAWindow.startMs) ||
    disconnected.atRecordingMs > reconnectedReady.atRecordingMs ||
    reconnectedReady.atRecordingMs > playback.startMs
  ) {
    fail(
      "RECONNECT_SEQUENCE_INVALID",
      "speaker-b initial ready must precede speaker-a and playback must start after reconnect ready",
    );
  }
  if (
    speakerAWindow === undefined ||
    disconnected === undefined ||
    reconnectedReady === undefined ||
    disconnected.atRecordingMs < speakerAWindow.startMs ||
    reconnectedReady.atRecordingMs > speakerAWindow.endMs
  ) {
    fail("RECONNECT_NOT_DURING_SPEAKER_A", "speaker-b must disconnect and become ready while speaker-a plays");
  }
}

function verifyPlaybackOverlap(context: ActorRunVerificationContext): void {
  const { fail, playbackWindows, scenario } = context;
  const playbackHasOverlap = playbackWindows.some((left, leftIndex) =>
    playbackWindows.some((right, rightIndex) =>
      leftIndex < rightIndex &&
      left.actorName !== right.actorName &&
      left.startMs < right.endMs &&
      right.startMs < left.endMs,
    ),
  );
  if (playbackHasOverlap !== scenario.expectOverlap) {
    fail("PLAYBACK_OVERLAP_MISMATCH", `actor playback expected overlap=${String(scenario.expectOverlap)}`);
  }
}

function verifyRecordingDuration(context: ActorRunVerificationContext): void {
  const { evidence, fail, manifest, playbackWindows } = context;
  const earliestPlaybackStart = Math.min(...playbackWindows.map(({ startMs }) => startMs));
  const latestPlaybackEnd = Math.max(0, ...playbackWindows.map(({ endMs }) => endMs));
  if (
    Number.isFinite(earliestPlaybackStart) &&
    evidence.recording.durationMs + manifest.thresholds.timestampToleranceMs <
      latestPlaybackEnd - earliestPlaybackStart
  ) {
    fail("RECORDING_TOO_SHORT", "recording ended before the final actor playback");
  }
}
