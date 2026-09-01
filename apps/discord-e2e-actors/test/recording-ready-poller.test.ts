import { describe, expect, it } from "vitest";

import {
  RecordingReadyPollingTimeoutError,
  waitForStableRecordingReadyReceipt,
} from "../src/recording-ready-poller.js";

const guildId = "1533228590643155034";
const voiceChannelId = "1533228823045214398";

describe("recording-ready bounded polling", () => {
  it("publishes only after two consecutive identical authoritative samples", async () => {
    const harness = createHarness([[], [completion("recording-1")], [completion("recording-1")]]);

    const result = await waitForStableRecordingReadyReceipt(harness.input);

    expect(result.recordingId).toBe("recording-1");
    expect(result.observedAt).toBe("2026-08-12T10:01:00.400Z");
    expect(harness.probeCalls()).toBe(3);
    expect(harness.waits).toEqual([200, 200]);
  });

  it("resets stability when an authoritative receipt temporarily disappears", async () => {
    const harness = createHarness([
      [completion("recording-1")], [], [completion("recording-1")], [completion("recording-1")],
    ]);

    await expect(waitForStableRecordingReadyReceipt(harness.input)).resolves.toMatchObject({
      recordingId: "recording-1",
    });
    expect(harness.probeCalls()).toBe(4);
  });

  it("fails closed immediately for ambiguous authoritative samples", async () => {
    const harness = createHarness([[completion("recording-1"), completion("recording-2")]]);

    await expect(waitForStableRecordingReadyReceipt(harness.input)).rejects.toThrow("found 2");
    expect(harness.waits).toEqual([]);
  });

  it("stops at the exact deadline without oversleeping", async () => {
    const harness = createHarness([[]], { pollIntervalMs: 400, timeoutMs: 1_000 });

    await expect(waitForStableRecordingReadyReceipt(harness.input)).rejects.toBeInstanceOf(
      RecordingReadyPollingTimeoutError,
    );
    expect(harness.waits).toEqual([400, 400, 200]);
    expect(harness.now()).toBe(Date.parse("2026-08-12T10:01:01.000Z"));
  });

  it("propagates abort before another probe", async () => {
    const controller = new AbortController();
    const harness = createHarness([[]], undefined, controller);
    harness.abortOnWait(controller, new Error("campaign cancelled"));

    await expect(waitForStableRecordingReadyReceipt(harness.input)).rejects.toThrow(
      "campaign cancelled",
    );
    expect(harness.probeCalls()).toBe(1);
  });
});

function createHarness(
  samples: readonly (readonly unknown[])[],
  policy = { pollIntervalMs: 200, timeoutMs: 1_000 },
  controller = new AbortController(),
) {
  let nowEpochMs = Date.parse("2026-08-12T10:01:00.000Z");
  let probeCalls = 0;
  let abortOnWait: { controller: AbortController; reason: Error } | undefined;
  const waits: number[] = [];
  return {
    abortOnWait(target: AbortController, reason: Error): void {
      abortOnWait = { controller: target, reason };
    },
    input: {
      actorRun: actorRun(),
      clock: { nowEpochMs: () => nowEpochMs },
      delay: {
        wait: async (delayMs: number): Promise<void> => {
          waits.push(delayMs);
          nowEpochMs += delayMs;
          abortOnWait?.controller.abort(abortOnWait.reason);
        },
      },
      expectedRevisions: expectedRevisions(),
      policy,
      probe: {
        collectRecordingCompletionReceipts: async (): Promise<readonly unknown[]> => {
          const sample = samples[Math.min(probeCalls, samples.length - 1)] ?? [];
          probeCalls += 1;
          return sample;
        },
      },
      provenance: provenance(),
      signal: controller.signal,
    },
    now: () => nowEpochMs,
    probeCalls: () => probeCalls,
    waits,
  };
}

function actorRun() {
  return {
    events: [
      { actorName: "speaker-a", atEpochMs: Date.parse("2026-08-12T10:00:10.000Z"), type: "ready" },
      { actorName: "speaker-a", atEpochMs: Date.parse("2026-08-12T10:00:20.000Z"), fixtureId: "speaker-a", type: "playback-start" },
    ],
    fixtureSetId: "fixtures-v1",
    fixtures: [
      { audioSha256: "1".repeat(64), durationMs: 1_000, fixtureId: "speaker-a", sourceSha256: "2".repeat(64) },
      { audioSha256: "3".repeat(64), durationMs: 1_000, fixtureId: "speaker-b", sourceSha256: "4".repeat(64) },
    ],
    recordingId: null,
    runId: "campaign-overlap-1",
    scenario: "overlap",
    schemaVersion: 1,
    timelineOrigin: "unix-epoch",
  };
}

function completion(recordingId: string) {
  const speakerAudio = {
    audioLocator: `s3://test/${recordingId}/speaker.ogg`,
    speakerId: "1533227577286852649",
    timelineOffsetMs: 0,
  };
  return {
    actors: [{ actorId: speakerAudio.speakerId, kind: "human" as const }],
    authoritativeTracks: [{
      ...speakerAudio,
      checksumSha256: "9".repeat(64),
      sizeBytes: 1_024,
      trackNumber: 1,
      uploadId: `${recordingId}:track:1`,
    }],
    channelId: voiceChannelId,
    events: [
      { digest: "e".repeat(64), eventId: `started-${recordingId}`, occurredAt: "2026-08-12T10:00:00.000Z", type: "meeting.started" },
      { digest: "f".repeat(64), eventId: `ready-${recordingId}`, occurredAt: "2026-08-12T10:00:40.000Z", type: "recording.authoritative_ready" },
    ],
    finalEventDigest: "f".repeat(64),
    finalEventId: `ready-${recordingId}`,
    guildId,
    recording: {
      manifestLocator: `s3://test/${recordingId}/manifest.json`,
      recordingId,
      speakerAudio: [speakerAudio],
    },
    recordingId,
    identityProvenance: {
      actorObservationState: "consistent" as const,
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "a".repeat(40),
      rosterState: "sealed" as const,
    },
    lifecycleSchemaVersion: 3 as const,
    schemaVersion: 4 as const,
  };
}

function provenance() {
  return {
    craig: service("a"), meetingPlatform: service("b"), pipecat: service("d"),
    subscriptionRuntime: service("c"),
  };
}

function expectedRevisions() {
  return { craig: "a".repeat(40), meetingPlatform: "b".repeat(40), pipecat: "d".repeat(40), subscriptionRuntime: "c".repeat(40) };
}

function service(seed: string) {
  return {
    composeConfigHash: seed.repeat(64), composeProject: `project-${seed}`,
    composeService: `service-${seed}`, containerId: seed.repeat(64),
    containerStartedAt: "2026-08-12T09:00:00.000Z", imageId: `sha256:${seed.repeat(64)}`,
    repositoryDigest: `registry.test/image@sha256:${seed.repeat(64)}`, sourceRevision: seed.repeat(40),
  };
}
