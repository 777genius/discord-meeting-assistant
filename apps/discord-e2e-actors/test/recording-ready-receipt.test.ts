import { describe, expect, it } from "vitest";

import {
  deriveRecordingReadyReceipt,
} from "../src/recording-ready-receipt.js";

const guildId = "1533228590643155034";
const voiceChannelId = "1533228823045214398";

describe("recording-ready receipt", () => {
  it("derives exactly one run binding from a completed authoritative window", () => {
    const result = deriveRecordingReadyReceipt({
      actorRun: actorRun(),
      completionReceipts: [completion("recording-1")],
      expectedRevisions: expectedRevisions(),
      observedAt: "2026-08-12T10:01:00.000Z",
      provenance: provenance(),
    });
    expect(result).toMatchObject({
      meetingId: "recording-1",
      pinnedTestTarget: { guildId, voiceChannelId },
      recordingId: "recording-1",
      runId: "campaign-overlap-1",
      schemaVersion: 1,
    });
  });

  it("fails closed for ambiguous windows", () => {
    expect(() => deriveRecordingReadyReceipt({
      actorRun: actorRun(),
      completionReceipts: [completion("recording-1"), completion("recording-2")],
      expectedRevisions: expectedRevisions(),
      observedAt: "2026-08-12T10:01:00.000Z",
      provenance: provenance(),
    })).toThrow("found 2");
  });

  it("rejects an operator-adjacent receipt outside the pinned voice target", () => {
    expect(() => deriveRecordingReadyReceipt({
      actorRun: actorRun(),
      completionReceipts: [{ ...completion("recording-1"), channelId: "1533228891827736657" }],
      expectedRevisions: expectedRevisions(),
      observedAt: "2026-08-12T10:01:00.000Z",
      provenance: provenance(),
    })).toThrow("found 0");
  });

  it("binds readiness to the same four V9 provenance components and revisions", () => {
    const { pipecat: _pipecat, ...withoutPipecat } = provenance();
    expect(() => deriveRecordingReadyReceipt({
      actorRun: actorRun(), completionReceipts: [completion("recording-1")],
      expectedRevisions: expectedRevisions(), observedAt: "2026-08-12T10:01:00.000Z",
      provenance: withoutPipecat,
    })).toThrow(/Pipecat component/u);

    const changedPipecat = provenance();
    changedPipecat.pipecat.sourceRevision = "f".repeat(40);
    expect(() => deriveRecordingReadyReceipt({
      actorRun: actorRun(), completionReceipts: [completion("recording-1")],
      expectedRevisions: expectedRevisions(), observedAt: "2026-08-12T10:01:00.000Z",
      provenance: changedPipecat,
    })).toThrow(/pipecat provenance does not match/u);
  });

});

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
  return {
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
      speakerAudio: [{
        audioLocator: `s3://test/${recordingId}/speaker.ogg`,
        speakerId: "1533227577286852649",
        timelineOffsetMs: 0,
      }],
    },
    recordingId,
    schemaVersion: 2,
  };
}

function provenance() {
  return {
    craig: service("a"),
    meetingPlatform: service("b"),
    pipecat: service("d"),
    subscriptionRuntime: service("c"),
  };
}

function expectedRevisions() {
  return { craig: "a".repeat(40), meetingPlatform: "b".repeat(40), pipecat: "d".repeat(40), subscriptionRuntime: "c".repeat(40) };
}

function service(seed: string) {
  return {
    composeConfigHash: seed.repeat(64),
    composeProject: `project-${seed}`,
    composeService: `service-${seed}`,
    containerId: seed.repeat(64),
    containerStartedAt: "2026-08-12T09:00:00.000Z",
    imageId: `sha256:${seed.repeat(64)}`,
    repositoryDigest: `registry.test/image@sha256:${seed.repeat(64)}`,
    sourceRevision: seed.repeat(40),
  };
}
