import { z } from "zod";

const identifierSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const nonNegativeMillisecondsSchema = z.number().int().nonnegative();
const scenarioKindSchema = z.enum(["overlap", "sequential", "reconnect"]);

const fixtureSchema = z.object({
  actorName: identifierSchema,
  audioPath: identifierSchema,
  audioSha256: sha256Schema,
  durationMs: z.number().int().positive(),
  fixtureId: identifierSchema,
  requiredTerms: z.array(identifierSchema).min(1),
  sourcePath: identifierSchema,
  sourceSha256: sha256Schema,
  sourceText: identifierSchema,
  speakerId: identifierSchema,
});

const scenarioSchema = z.object({
  expectOverlap: z.boolean(),
  kind: scenarioKindSchema,
  playbackCountByFixture: z.record(identifierSchema, z.number().int().positive()),
  requireReconnect: z.boolean(),
  speakerBDelayMs: nonNegativeMillisecondsSchema,
});

export const fixtureManifestV1Schema = z.object({
  fixtureSetId: identifierSchema,
  fixtures: z.array(fixtureSchema).min(2),
  locale: identifierSchema,
  summaryExpectations: z.object({
    actionItems: z.array(z.object({
      deadline: identifierSchema.nullable(),
      ownerSpeakerId: identifierSchema,
      requiredTerms: z.array(identifierSchema).min(1),
    })).min(1),
    decisionTerms: z.array(identifierSchema).min(1),
    topicTerms: z.array(identifierSchema).min(1),
  }),
  scenarios: z.array(scenarioSchema).min(1),
  schemaVersion: z.literal(1),
  thresholds: z.object({
    maxCharacterErrorRate: z.number().min(0).max(1),
    maxWordErrorRate: z.number().min(0).max(1),
    timestampToleranceMs: nonNegativeMillisecondsSchema,
  }),
});

const actorEventSchema = z.object({
  actorName: identifierSchema,
  atRecordingMs: nonNegativeMillisecondsSchema,
  fixtureId: identifierSchema.optional(),
  type: z.enum(["disconnected", "playback-end", "playback-start", "ready"]),
});

const actorWallClockEventSchema = actorEventSchema.omit({ atRecordingMs: true }).extend({
  atEpochMs: z.number().int().positive(),
});

const actorFixtureProofSchema = z.object({
  audioSha256: sha256Schema,
  durationMs: z.number().int().positive(),
  fixtureId: identifierSchema,
  sourceSha256: sha256Schema,
});

export const unboundActorRunEvidenceV1Schema = z.object({
  events: z.array(actorWallClockEventSchema).min(1),
  fixtureSetId: identifierSchema,
  fixtures: z.array(actorFixtureProofSchema).min(2),
  recordingId: z.null(),
  runId: identifierSchema,
  scenario: scenarioKindSchema,
  schemaVersion: z.literal(1),
  timelineOrigin: z.literal("unix-epoch"),
});

export const actorRunEvidenceV1Schema = z.object({
  events: z.array(actorEventSchema).min(1),
  fixtureSetId: identifierSchema,
  fixtures: z.array(actorFixtureProofSchema).min(2),
  recordingId: identifierSchema,
  runId: identifierSchema,
  scenario: scenarioKindSchema,
  schemaVersion: z.literal(1),
  timelineOrigin: z.literal("actor-run-start-correlated-to-recording-id"),
});

const identifierCountSchema = z.number().int().nonnegative();

export const retainedE2eEvidenceV1Schema = z.object({
  actorRun: actorRunEvidenceV1Schema,
  fixtureManifestVersion: z.literal(1),
  fixtureSetId: identifierSchema,
  database: z.object({
    matchingMeetingCount: identifierCountSchema,
    matchingRecordingCount: identifierCountSchema,
    matchingSummaryCount: identifierCountSchema,
    matchingTranscriptCount: identifierCountSchema,
  }),
  fixtures: z.array(z.object({
    audioSha256: sha256Schema,
    codec: z.literal("opus"),
    durationMs: z.number().int().positive(),
    fixtureId: identifierSchema,
    sourceSha256: sha256Schema,
  })).min(2),
  meetingId: identifierSchema,
  publication: z.object({
    matchingMessageCount: identifierCountSchema,
    matchingThreadCount: identifierCountSchema,
    messageId: identifierSchema,
    threadId: identifierSchema,
  }),
  recording: z.object({
    durationMs: z.number().int().positive(),
    recordingId: identifierSchema,
    s3: z.object({
      manifestChecksumSha256: sha256Schema,
      manifestLocator: identifierSchema,
      sourceChecksumSha256: sha256Schema,
      tracks: z.array(z.object({
        checksumSha256: sha256Schema,
        durationMs: z.number().int().positive(),
        locator: identifierSchema,
        sizeBytes: z.number().int().positive(),
        speakerId: identifierSchema,
        timelineOffsetMs: nonNegativeMillisecondsSchema,
      })).min(1),
    }),
    speakerIds: z.array(identifierSchema).min(1),
  }),
  replay: z.object({
    matchingMeetingCount: identifierCountSchema,
    matchingMessageCount: identifierCountSchema,
    matchingRecordingCount: identifierCountSchema,
    matchingSummaryCount: identifierCountSchema,
    matchingThreadCount: identifierCountSchema,
    matchingTranscriptCount: identifierCountSchema,
    meetingId: identifierSchema,
    messageId: identifierSchema,
    recordingId: identifierSchema,
    summaryId: identifierSchema,
    threadId: identifierSchema,
    transcriptId: identifierSchema,
    replayJob: z.object({
      afterProcessedOn: z.number().int().positive(),
      beforeProcessedOn: z.number().int().positive(),
      jobId: identifierSchema,
      state: z.literal("completed"),
    }),
  }),
  schemaVersion: z.literal(1),
  stages: z.array(z.object({
    attempts: z.number().int().positive(),
    stage: z.enum(["publication", "summary", "transcription"]),
    status: z.literal("succeeded"),
  })).min(3),
  summary: z.object({
    actionItems: z.array(z.object({
      deadline: identifierSchema.nullable(),
      evidenceTurnIds: z.array(identifierSchema).min(1),
      ownerSpeakerId: identifierSchema.nullable(),
      text: identifierSchema,
    }).loose()),
    decisions: z.array(z.object({
      evidenceTurnIds: z.array(identifierSchema).min(1),
      text: identifierSchema,
    }).loose()),
    summaryId: identifierSchema,
    topics: z.array(z.object({
      evidenceTurnIds: z.array(identifierSchema).min(1),
      points: z.array(identifierSchema).min(1),
      title: identifierSchema,
    }).loose()),
  }).loose(),
  transcript: z.object({
    transcriptId: identifierSchema,
    turns: z.array(z.object({
      endMs: nonNegativeMillisecondsSchema,
      speakerId: identifierSchema,
      startMs: nonNegativeMillisecondsSchema,
      text: identifierSchema,
      turnId: identifierSchema,
    })).min(1),
  }),
});

export type FixtureManifestV1 = z.infer<typeof fixtureManifestV1Schema>;
export type ActorRunEvidenceV1 = z.infer<typeof actorRunEvidenceV1Schema>;
export type UnboundActorRunEvidenceV1 = z.infer<typeof unboundActorRunEvidenceV1Schema>;
export type RetainedE2eEvidenceV1 = z.infer<typeof retainedE2eEvidenceV1Schema>;

interface VerificationFailure {
  readonly code: string;
  readonly message: string;
}

interface SpeakerAccuracyMetrics {
  readonly characterErrorRate: number;
  readonly speakerId: string;
  readonly wordErrorRate: number;
}

export interface E2eVerificationResult {
  readonly failures: readonly VerificationFailure[];
  readonly metrics: readonly SpeakerAccuracyMetrics[];
  readonly passed: boolean;
}

export interface CampaignVerificationResult {
  readonly failures: readonly VerificationFailure[];
  readonly passed: boolean;
  readonly runResults: Readonly<Record<string, E2eVerificationResult>>;
}

interface PlaybackWindow {
  readonly actorName: string;
  readonly endMs: number;
  readonly fixtureId: string;
  readonly startMs: number;
}

export function verifyRetainedE2eEvidence(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV1,
): E2eVerificationResult {
  const failures: VerificationFailure[] = [];
  const metrics: SpeakerAccuracyMetrics[] = [];
  const fail = (code: string, message: string): void => {
    failures.push({ code, message });
  };

  if (evidence.fixtureSetId !== manifest.fixtureSetId) {
    fail("FIXTURE_SET_MISMATCH", "retained evidence references a different fixture set");
  }
  if (
    evidence.actorRun.fixtureSetId !== manifest.fixtureSetId ||
    evidence.actorRun.recordingId !== evidence.recording.recordingId ||
    evidence.actorRun.recordingId !== evidence.meetingId
  ) {
    fail("ACTOR_RECORDING_CORRELATION_MISMATCH", "actor run is not correlated to this recording");
  }

  const scenario = manifest.scenarios.find(({ kind }) => kind === evidence.actorRun.scenario);
  if (scenario === undefined) {
    fail("UNKNOWN_SCENARIO", `scenario ${evidence.actorRun.scenario} is absent from the manifest`);
    return result(failures, metrics);
  }

  verifyFixtures(manifest, evidence, fail);
  verifyS3Evidence(evidence, fail);
  verifyStages(evidence, fail);
  const playbackWindows = playbackWindowsFrom(evidence, fail);
  verifyActorRun(manifest, evidence, scenario, playbackWindows, fail);
  verifyTranscript(manifest, evidence, scenario, playbackWindows, metrics, fail);
  verifyEvidenceReferences(manifest, evidence, fail);
  verifySummarySemantics(manifest, evidence, fail);
  verifyReplayIdentity(evidence, fail);

  return result(failures, metrics);
}

export function verifyE2eCampaign(
  manifest: FixtureManifestV1,
  runs: readonly RetainedE2eEvidenceV1[],
): CampaignVerificationResult {
  const failures: VerificationFailure[] = [];
  const runResults: Record<string, E2eVerificationResult> = {};
  const fail = (code: string, message: string): void => {
    failures.push({ code, message });
  };
  for (const run of runs) {
    if (runResults[run.actorRun.runId] !== undefined) {
      fail("DUPLICATE_RUN_ID", `run ID ${run.actorRun.runId} appears more than once`);
      continue;
    }
    const verification = verifyRetainedE2eEvidence(manifest, run);
    runResults[run.actorRun.runId] = verification;
    if (!verification.passed) {
      fail("RUN_FAILED", `run ${run.actorRun.runId} failed evidence verification`);
    }
  }

  for (const scenario of ["sequential", "overlap", "reconnect"] as const) {
    if (!runs.some(({ actorRun }) => actorRun.scenario === scenario)) {
      fail("SCENARIO_NOT_PROVEN", `campaign has no passing ${scenario} run`);
    }
  }
  verifyCampaignIsolation(runs, fail);
  return {
    failures: Object.freeze(failures),
    passed: failures.length === 0,
    runResults: Object.freeze(runResults),
  };
}

function verifyCampaignIsolation(
  runs: readonly RetainedE2eEvidenceV1[],
  fail: (code: string, message: string) => void,
): void {
  const identities: ReadonlyArray<readonly [string, (run: RetainedE2eEvidenceV1) => string]> = [
    ["meeting", (run) => run.meetingId],
    ["recording", (run) => run.recording.recordingId],
    ["transcript", (run) => run.transcript.transcriptId],
    ["summary", (run) => run.summary.summaryId],
    ["thread", (run) => run.publication.threadId],
    ["message", (run) => run.publication.messageId],
  ];
  for (const [kind, select] of identities) {
    const values = runs.map(select);
    if (new Set(values).size !== values.length) {
      fail("CAMPAIGN_STATE_LEAK", `${kind} identity is shared by independent runs`);
    }
  }
}

function verifyFixtures(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV1,
  fail: (code: string, message: string) => void,
): void {
  const retainedById = new Map(evidence.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const actorById = new Map(evidence.actorRun.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  if (retainedById.size !== evidence.fixtures.length) {
    fail("DUPLICATE_FIXTURE", "retained evidence contains duplicate fixture IDs");
  }

  for (const fixture of manifest.fixtures) {
    const retained = retainedById.get(fixture.fixtureId);
    if (retained === undefined) {
      fail("MISSING_FIXTURE", `fixture ${fixture.fixtureId} has no retained integrity evidence`);
      continue;
    }
    if (retained.sourceSha256 !== fixture.sourceSha256) {
      fail("SOURCE_HASH_MISMATCH", `fixture ${fixture.fixtureId} source hash changed`);
    }
    if (retained.audioSha256 !== fixture.audioSha256) {
      fail("AUDIO_HASH_MISMATCH", `fixture ${fixture.fixtureId} audio hash changed`);
    }
    if (retained.durationMs !== fixture.durationMs) {
      fail("FIXTURE_DURATION_MISMATCH", `fixture ${fixture.fixtureId} duration changed`);
    }
    const actorFixture = actorById.get(fixture.fixtureId);
    if (
      actorFixture === undefined ||
      actorFixture.audioSha256 !== retained.audioSha256 ||
      actorFixture.sourceSha256 !== retained.sourceSha256 ||
      actorFixture.durationMs !== retained.durationMs
    ) {
      fail("ACTOR_FIXTURE_MISMATCH", `actor proof for ${fixture.fixtureId} is absent or changed`);
    }
  }

  const expectedIds = new Set(manifest.fixtures.map(({ fixtureId }) => fixtureId));
  for (const retained of evidence.fixtures) {
    if (!expectedIds.has(retained.fixtureId)) {
      fail("UNKNOWN_FIXTURE", `retained fixture ${retained.fixtureId} is not in the manifest`);
    }
  }
  if (new Set(evidence.fixtures.map(({ audioSha256 }) => audioSha256)).size !== evidence.fixtures.length) {
    fail("DUPLICATE_AUDIO_HASH", "different speaker fixtures must not share one audio hash");
  }
}

function verifyS3Evidence(
  evidence: RetainedE2eEvidenceV1,
  fail: (code: string, message: string) => void,
): void {
  const s3 = evidence.recording.s3;
  const speakers = new Set(s3.tracks.map(({ speakerId }) => speakerId));
  if (speakers.size !== s3.tracks.length) {
    fail("DUPLICATE_S3_TRACK", "S3 manifest contains duplicate speaker tracks");
  }
  if (s3.manifestLocator.length === 0 || s3.sourceChecksumSha256.length !== 64) {
    fail("INVALID_S3_MANIFEST", "authoritative S3 manifest proof is incomplete");
  }
  const durationMs = Math.max(
    ...s3.tracks.map((track) => track.timelineOffsetMs + track.durationMs),
  );
  if (Math.abs(durationMs - evidence.recording.durationMs) > 1) {
    fail("S3_DURATION_MISMATCH", "recording duration does not match verified S3 tracks");
  }
  const expectedSpeakers = new Set(evidence.recording.speakerIds);
  if (
    speakers.size !== expectedSpeakers.size ||
    [...speakers].some((speakerId) => !expectedSpeakers.has(speakerId))
  ) {
    fail("S3_SPEAKER_MISMATCH", "S3 tracks do not match recording speakers");
  }
}

function verifyStages(
  evidence: RetainedE2eEvidenceV1,
  fail: (code: string, message: string) => void,
): void {
  for (const required of ["transcription", "summary", "publication"] as const) {
    const matches = evidence.stages.filter(({ stage }) => stage === required);
    if (matches.length !== 1) {
      fail("INVALID_STAGE_PROOF", `expected exactly one succeeded ${required} stage snapshot`);
    }
  }
}

function playbackWindowsFrom(
  evidence: RetainedE2eEvidenceV1,
  fail: (code: string, message: string) => void,
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
      if (event.fixtureId === undefined) {
        fail("PLAYBACK_FIXTURE_MISSING", `${event.actorName} playback start has no fixture ID`);
        continue;
      }
      const key = `${event.actorName}:${event.fixtureId}`;
      const starts = open.get(key) ?? [];
      starts.push(event.atRecordingMs);
      open.set(key, starts);
    }
    if (event.type === "playback-end") {
      if (event.fixtureId === undefined) {
        fail("PLAYBACK_FIXTURE_MISSING", `${event.actorName} playback end has no fixture ID`);
        continue;
      }
      const key = `${event.actorName}:${event.fixtureId}`;
      const starts = open.get(key);
      const startMs = starts?.shift();
      if (startMs === undefined || startMs >= event.atRecordingMs) {
        fail("INVALID_PLAYBACK_WINDOW", `${event.actorName} playback end has no earlier start`);
        continue;
      }
      windows.push({
        actorName: event.actorName,
        endMs: event.atRecordingMs,
        fixtureId: event.fixtureId,
        startMs,
      });
    }
  }

  if ([...open.values()].some((starts) => starts.length > 0)) {
    fail("UNCLOSED_PLAYBACK", "every playback start must have a retained playback end");
  }
  return windows;
}

function verifyActorRun(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV1,
  scenario: FixtureManifestV1["scenarios"][number],
  windows: readonly PlaybackWindow[],
  fail: (code: string, message: string) => void,
): void {
  const retainedFixtures = new Map(evidence.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  for (const fixture of manifest.fixtures) {
    const expectedCount = scenario.playbackCountByFixture[fixture.fixtureId];
    if (expectedCount === undefined) {
      fail("PLAYBACK_COUNT_MISSING", `scenario has no playback count for ${fixture.fixtureId}`);
      continue;
    }
    const fixtureWindows = windows.filter(({ fixtureId }) => fixtureId === fixture.fixtureId);
    if (fixtureWindows.some(({ actorName }) => actorName !== fixture.actorName)) {
      fail("FIXTURE_ACTOR_MISMATCH", `${fixture.fixtureId} was played by the wrong actor`);
    }
    if (fixtureWindows.length !== expectedCount) {
      fail(
        "PLAYBACK_COUNT_MISMATCH",
        `fixture ${fixture.fixtureId} played ${fixtureWindows.length} times instead of ${expectedCount}`,
      );
    }

    const retainedFixture = retainedFixtures.get(fixture.fixtureId);
    if (retainedFixture !== undefined) {
      for (const window of fixtureWindows) {
        const actualDuration = window.endMs - window.startMs;
        if (Math.abs(actualDuration - retainedFixture.durationMs) > manifest.thresholds.timestampToleranceMs) {
          fail("PLAYBACK_DURATION_MISMATCH", `${fixture.fixtureId} playback duration differs from ffprobe evidence`);
        }
      }
    }

    const actorEvents = evidence.actorRun.events.filter(({ actorName }) => actorName === fixture.actorName);
    for (const window of fixtureWindows) {
      const ready = actorEvents.some(
        (event) => event.type === "ready" && event.atRecordingMs <= window.startMs,
      );
      if (!ready) {
        fail("ACTOR_NOT_READY", `${fixture.actorName} started playback before a retained ready event`);
      }
    }
  }

  if (scenario.requireReconnect) {
    verifyReconnect(manifest, evidence, windows, fail);
  }

  verifyScenarioTiming(manifest, scenario, windows, fail);
  verifyActorS3Timing(manifest, evidence, windows, fail);

  const playbackHasOverlap = windows.some((left, leftIndex) =>
    windows.some((right, rightIndex) =>
      leftIndex < rightIndex &&
      left.actorName !== right.actorName &&
      left.startMs < right.endMs &&
      right.startMs < left.endMs,
    ),
  );
  if (playbackHasOverlap !== scenario.expectOverlap) {
    fail("PLAYBACK_OVERLAP_MISMATCH", `actor playback expected overlap=${String(scenario.expectOverlap)}`);
  }

  const earliestPlaybackStart = Math.min(...windows.map(({ startMs }) => startMs));
  const latestPlaybackEnd = Math.max(0, ...windows.map(({ endMs }) => endMs));
  if (
    Number.isFinite(earliestPlaybackStart) &&
    evidence.recording.durationMs + manifest.thresholds.timestampToleranceMs <
      latestPlaybackEnd - earliestPlaybackStart
  ) {
    fail("RECORDING_TOO_SHORT", "recording ended before the final actor playback");
  }
}

function verifyActorS3Timing(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV1,
  windows: readonly PlaybackWindow[],
  fail: (code: string, message: string) => void,
): void {
  for (const fixture of manifest.fixtures) {
    const fixtureWindows = windows.filter(({ fixtureId }) => fixtureId === fixture.fixtureId);
    const track = evidence.recording.s3.tracks.find(
      ({ speakerId }) => speakerId === fixture.speakerId,
    );
    if (track === undefined) {
      fail("ACTOR_S3_TRACK_MISSING", `${fixture.fixtureId} has no corresponding S3 track`);
      continue;
    }

    const trackEndMs = track.timelineOffsetMs + track.durationMs;
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

function verifyScenarioTiming(
  manifest: FixtureManifestV1,
  scenario: FixtureManifestV1["scenarios"][number],
  windows: readonly PlaybackWindow[],
  fail: (code: string, message: string) => void,
): void {
  const speakerAFixture = manifest.fixtures.find(({ actorName }) => actorName === "speaker-a");
  const speakerBFixture = manifest.fixtures.find(({ actorName }) => actorName === "speaker-b");
  const speakerAWindow = windows.find(({ fixtureId }) => fixtureId === speakerAFixture?.fixtureId);
  const speakerBWindow = windows.find(({ fixtureId }) => fixtureId === speakerBFixture?.fixtureId);
  if (speakerAWindow === undefined || speakerBWindow === undefined) {
    return;
  }

  const observedDelay = scenario.kind === "sequential"
    ? speakerBWindow.startMs - speakerAWindow.endMs
    : speakerBWindow.startMs - speakerAWindow.startMs;
  if (Math.abs(observedDelay - scenario.speakerBDelayMs) > manifest.thresholds.timestampToleranceMs) {
    fail("SCENARIO_DELAY_MISMATCH", `speaker-b delay ${observedDelay}ms is outside tolerance`);
  }
}

function verifyReconnect(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV1,
  windows: readonly PlaybackWindow[],
  fail: (code: string, message: string) => void,
): void {
  const speakerB = manifest.fixtures.find(({ actorName }) => actorName === "speaker-b");
  if (speakerB === undefined) {
    fail("RECONNECT_ACTOR_MISSING", "manifest must define speaker-b for reconnect proof");
    return;
  }
  const speakerBWindows = windows
    .filter(({ fixtureId }) => fixtureId === speakerB.fixtureId)
    .toSorted((left, right) => left.startMs - right.startMs);
  const first = speakerBWindows[0];
  const second = speakerBWindows[1];
  if (first === undefined || second === undefined) {
    fail("RECONNECT_PLAYBACK_MISSING", "speaker-b must play before and after reconnect");
    return;
  }

  const between = evidence.actorRun.events.filter(
    (event) =>
      event.actorName === speakerB.actorName &&
      event.atRecordingMs >= first.endMs &&
      event.atRecordingMs <= second.startMs,
  );
  const disconnectedIndex = between.findIndex(({ type }) => type === "disconnected");
  const readyIndex = between.findIndex(({ type }) => type === "ready");
  if (disconnectedIndex < 0 || readyIndex <= disconnectedIndex) {
    fail("RECONNECT_SEQUENCE_INVALID", "speaker-b needs disconnected then ready events between playbacks");
  }
}

function verifyTranscript(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV1,
  scenario: FixtureManifestV1["scenarios"][number],
  windows: readonly PlaybackWindow[],
  metrics: SpeakerAccuracyMetrics[],
  fail: (code: string, message: string) => void,
): void {
  const expectedSpeakers = new Set(manifest.fixtures.map(({ speakerId }) => speakerId));
  const recordedSpeakers = new Set(evidence.recording.speakerIds);
  const transcriptSpeakers = new Set(evidence.transcript.turns.map(({ speakerId }) => speakerId));
  for (const speakerId of expectedSpeakers) {
    if (!recordedSpeakers.has(speakerId) || !transcriptSpeakers.has(speakerId)) {
      fail("SPEAKER_MISSING", `speaker ${speakerId} is absent from recording or transcript evidence`);
    }
  }
  for (const speakerId of new Set([...recordedSpeakers, ...transcriptSpeakers])) {
    if (!expectedSpeakers.has(speakerId)) {
      fail("UNEXPECTED_SPEAKER", `unexpected speaker ${speakerId} appears in retained evidence`);
    }
  }

  for (const turn of evidence.transcript.turns) {
    if (turn.endMs <= turn.startMs) {
      fail("INVALID_TURN_TIME", `turn ${turn.turnId} must end after it starts`);
    }
  }
  if (new Set(evidence.transcript.turns.map(({ turnId }) => turnId)).size !== evidence.transcript.turns.length) {
    fail("DUPLICATE_TURN", "transcript turn IDs must be unique");
  }

  for (const fixture of manifest.fixtures) {
    const turns = evidence.transcript.turns
      .filter(({ speakerId }) => speakerId === fixture.speakerId)
      .toSorted((left, right) => left.startMs - right.startMs);
    const expectedCount = scenario.playbackCountByFixture[fixture.fixtureId] ?? 0;
    const expectedText = Array.from({ length: expectedCount }, () => fixture.sourceText).join(" ");
    const actualText = turns.map(({ text }) => text).join(" ");
    const wordErrorRate = errorRate(words(expectedText), words(actualText));
    const characterErrorRate = errorRate(characters(expectedText), characters(actualText));
    metrics.push({ characterErrorRate, speakerId: fixture.speakerId, wordErrorRate });
    if (wordErrorRate > manifest.thresholds.maxWordErrorRate) {
      fail("WER_EXCEEDED", `${fixture.fixtureId} WER ${wordErrorRate.toFixed(3)} exceeds threshold`);
    }
    if (characterErrorRate > manifest.thresholds.maxCharacterErrorRate) {
      fail("CER_EXCEEDED", `${fixture.fixtureId} CER ${characterErrorRate.toFixed(3)} exceeds threshold`);
    }

    const normalizedActual = normalizeTranscriptSemantics(actualText);
    for (const term of fixture.requiredTerms) {
      if (!normalizedActual.includes(normalizeTranscriptSemantics(term))) {
        fail("TERM_MISSING", `${fixture.fixtureId} transcript is missing required term ${term}`);
      }
    }

    const fixtureWindows = windows
      .filter(({ fixtureId }) => fixture.fixtureId === fixtureId)
      .toSorted((left, right) => left.startMs - right.startMs);
    const firstWindow = fixtureWindows[0];
    const lastWindow = fixtureWindows.at(-1);
    const firstTurn = turns[0];
    const lastTurn = turns.at(-1);
    if (
      firstTurn !== undefined &&
      firstWindow !== undefined &&
      Math.abs(firstTurn.startMs - firstWindow.startMs) > manifest.thresholds.timestampToleranceMs
    ) {
      fail("START_TIMESTAMP_MISMATCH", `${fixture.fixtureId} transcript start is outside tolerance`);
    }
    if (
      lastTurn !== undefined &&
      lastWindow !== undefined &&
      Math.abs(lastTurn.endMs - lastWindow.endMs) > manifest.thresholds.timestampToleranceMs
    ) {
      fail("END_TIMESTAMP_MISMATCH", `${fixture.fixtureId} transcript end is outside tolerance`);
    }
  }

  const hasOverlap = evidence.transcript.turns.some((left, leftIndex) =>
    evidence.transcript.turns.some((right, rightIndex) =>
      leftIndex < rightIndex &&
      left.speakerId !== right.speakerId &&
      left.startMs < right.endMs &&
      right.startMs < left.endMs,
    ),
  );
  if (hasOverlap !== scenario.expectOverlap) {
    fail("OVERLAP_MISMATCH", `scenario expected overlap=${String(scenario.expectOverlap)}`);
  }
}

function verifyEvidenceReferences(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV1,
  fail: (code: string, message: string) => void,
): void {
  const turnIds = new Set(evidence.transcript.turns.map(({ turnId }) => turnId));
  const speakerIds = new Set(manifest.fixtures.map(({ speakerId }) => speakerId));
  for (const [kind, items] of [
    ["decision", evidence.summary.decisions],
    ["action item", evidence.summary.actionItems],
    ["topic", evidence.summary.topics],
  ] as const) {
    for (const item of items) {
      for (const turnId of item.evidenceTurnIds) {
        if (!turnIds.has(turnId)) {
          fail("UNKNOWN_EVIDENCE_TURN", `${kind} references missing turn ${turnId}`);
        }
      }
    }
  }
  for (const actionItem of evidence.summary.actionItems) {
    if (actionItem.ownerSpeakerId !== null && !speakerIds.has(actionItem.ownerSpeakerId)) {
      fail("UNKNOWN_ACTION_OWNER", `action owner ${actionItem.ownerSpeakerId} is not a fixture speaker`);
    }
  }
}

function verifySummarySemantics(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV1,
  fail: (code: string, message: string) => void,
): void {
  const decisionText = normalize(
    evidence.summary.decisions.map(({ text }) => text).join(" "),
  );
  for (const term of manifest.summaryExpectations.decisionTerms) {
    if (!decisionText.includes(normalize(term))) {
      fail("DECISION_SEMANTICS_MISSING", `summary decisions omit ${term}`);
    }
  }

  for (const expected of manifest.summaryExpectations.actionItems) {
    const match = evidence.summary.actionItems.find((action) =>
      action.ownerSpeakerId === expected.ownerSpeakerId &&
      action.deadline === expected.deadline &&
      expected.requiredTerms.every((term) => normalize(action.text).includes(normalize(term))),
    );
    if (match === undefined) {
      fail(
        "ACTION_SEMANTICS_MISSING",
        `summary has no matching action for owner ${expected.ownerSpeakerId}`,
      );
    }
  }

  const topicText = normalize(
    evidence.summary.topics
      .flatMap((topic) => [topic.title, ...topic.points])
      .join(" "),
  );
  for (const term of manifest.summaryExpectations.topicTerms) {
    if (!topicText.includes(normalize(term))) {
      fail("TOPIC_SEMANTICS_MISSING", `summary topics omit ${term}`);
    }
  }
}

function verifyReplayIdentity(
  evidence: RetainedE2eEvidenceV1,
  fail: (code: string, message: string) => void,
): void {
  if (evidence.replay.replayJob.afterProcessedOn <= evidence.replay.replayJob.beforeProcessedOn) {
    fail("REPLAY_NOT_EXECUTED", "BullMQ job has no later completed processing timestamp");
  }
  const identityPairs: ReadonlyArray<readonly [string, string, string]> = [
    ["meeting", evidence.meetingId, evidence.replay.meetingId],
    ["recording", evidence.recording.recordingId, evidence.replay.recordingId],
    ["transcript", evidence.transcript.transcriptId, evidence.replay.transcriptId],
    ["summary", evidence.summary.summaryId, evidence.replay.summaryId],
    ["thread", evidence.publication.threadId, evidence.replay.threadId],
    ["message", evidence.publication.messageId, evidence.replay.messageId],
  ];
  for (const [kind, initial, replayed] of identityPairs) {
    if (initial !== replayed) {
      fail("REPLAY_IDENTITY_CHANGED", `${kind} identity changed after replay`);
    }
  }

  const counts: ReadonlyArray<readonly [string, number]> = [
    ["initial meeting", evidence.database.matchingMeetingCount],
    ["initial recording", evidence.database.matchingRecordingCount],
    ["initial summary", evidence.database.matchingSummaryCount],
    ["initial transcript", evidence.database.matchingTranscriptCount],
    ["initial thread", evidence.publication.matchingThreadCount],
    ["initial message", evidence.publication.matchingMessageCount],
    ["meeting", evidence.replay.matchingMeetingCount],
    ["recording", evidence.replay.matchingRecordingCount],
    ["summary", evidence.replay.matchingSummaryCount],
    ["transcript", evidence.replay.matchingTranscriptCount],
    ["thread", evidence.replay.matchingThreadCount],
    ["message", evidence.replay.matchingMessageCount],
  ];
  for (const [kind, count] of counts) {
    if (count !== 1) {
      fail("DUPLICATE_BUSINESS_EFFECT", `${kind} marker count is ${count}, expected exactly one`);
    }
  }
}

function result(
  failures: readonly VerificationFailure[],
  metrics: readonly SpeakerAccuracyMetrics[],
): E2eVerificationResult {
  return {
    failures: Object.freeze([...failures]),
    metrics: Object.freeze([...metrics]),
    passed: failures.length === 0,
  };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
}

function normalizeTranscriptSemantics(value: string): string {
  return normalize(value).replaceAll(
    "седьмого августа две тысячи двадцать шестого года",
    "7 августа 2026 года",
  );
}

function words(value: string): readonly string[] {
  const normalized = normalizeTranscriptSemantics(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function characters(value: string): readonly string[] {
  return Array.from(normalizeTranscriptSemantics(value).replaceAll(" ", ""));
}

function errorRate(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) {
    return actual.length === 0 ? 0 : 1;
  }
  return levenshteinDistance(expected, actual) / expected.length;
}

function levenshteinDistance(expected: readonly string[], actual: readonly string[]): number {
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let expectedIndex = 1; expectedIndex <= expected.length; expectedIndex += 1) {
    const current = [expectedIndex];
    for (let actualIndex = 1; actualIndex <= actual.length; actualIndex += 1) {
      const substitution = previous[actualIndex - 1] ?? 0;
      const deletion = previous[actualIndex] ?? 0;
      const insertion = current[actualIndex - 1] ?? 0;
      current[actualIndex] = Math.min(
        deletion + 1,
        insertion + 1,
        substitution + (expected[expectedIndex - 1] === actual[actualIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[actual.length] ?? 0;
}
