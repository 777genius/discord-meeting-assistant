import { describe, expect, it } from "vitest";

import { verifyRetainedE2eEvidence } from "../src/e2e-evidence.js";
import {
  currentExpectedRevisions,
  manifest,
  retainedV8Evidence,
} from "./e2e-evidence-fixtures.js";

describe("retained conversation V8 provenance and correlation", () => {
  it("rejects an allowlisted bot that is not the exact pinned Botik speaker", () => {
    const fixtureManifest = manifest();
    fixtureManifest.allowedBotSpeakerIds.push("1533224474609057793");
    const evidence = retainedV8Evidence();
    evidence.conversation.botSpeakerId = "1533224474609057793";

    const codes = verifyRetainedE2eEvidence(
      fixtureManifest,
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("BOT_SPEAKER_NOT_PINNED");
  });

  it("requires Pipecat provenance and its exact release-candidate revision", () => {
    const evidence = retainedV8Evidence();
    delete evidence.deployment.pipecat;
    const withoutPipecat = structuredClone(currentExpectedRevisions);
    delete withoutPipecat.pipecat;

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      withoutPipecat,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("PIPECAT_PROVENANCE_MISSING");
  });

  it("bounds every Botik capture and transcript turn to its S3 track", () => {
    const evidence = retainedV8Evidence();
    const track = evidence.recording.s3.tracks.find(
      ({ speakerId }) => speakerId === evidence.conversation.botSpeakerId,
    );
    if (track === undefined) {
      throw new Error("Botik track fixture is missing");
    }
    track.durationMs = 1;

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("BOT_TRACK_INTERVAL_MISMATCH");
  });

  it("bounds Speaker D playback and transcript turns to its S3 track", () => {
    const fixtureManifest = manifest();
    const speakerDId = fixtureManifest.supplementalVoiceExpectation?.applicationId;
    if (speakerDId === undefined) {
      throw new Error("Speaker D expectation fixture is missing");
    }
    const evidence = retainedV8Evidence();
    const track = evidence.recording.s3.tracks.find(({ speakerId }) => speakerId === speakerDId);
    if (track === undefined) {
      throw new Error("Speaker D track fixture is missing");
    }
    track.durationMs = 1;

    const codes = verifyRetainedE2eEvidence(
      fixtureManifest,
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("SUPPLEMENTAL_TRACK_INTERVAL_MISMATCH");
  });

  it("requires the explicit group farewell to cite the Speaker D farewell turn", () => {
    const evidence = retainedV8Evidence();
    const farewell = evidence.conversation.lifecycle.events.find(
      (event) => event.type === "farewell",
    );
    if (farewell === undefined) {
      throw new Error("farewell lifecycle fixture is missing");
    }
    farewell.reason = "last-participant";
    farewell.evidenceTurnIds = ["unrelated-turn"];

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("SUPPLEMENTAL_FAREWELL_CORRELATION_MISMATCH");
  });

  it("binds the addressed answer capture to the admitted Speaker D live turn", () => {
    const evidence = retainedV8Evidence();
    const answer = evidence.conversation.voice.find(
      ({ correlation }) => correlation.purpose === "addressed-answer",
    );
    if (answer === undefined) {
      throw new Error("addressed answer capture fixture is missing");
    }
    answer.correlation.turnId = "stale-question-turn";

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toContain("SUPPLEMENTAL_ANSWER_TURN_MISMATCH");
  });

  it("requires one admitted structured live-turn event for the addressed answer", () => {
    const evidence = retainedV8Evidence();
    evidence.conversation.lifecycle.events = evidence.conversation.lifecycle.events.filter(
      (event) => event.type !== "addressed-answer",
    );

    const codes = verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining([
      "ORPHAN_LIFECYCLE_AUDIO",
      "SUPPLEMENTAL_ANSWER_TURN_MISMATCH",
    ]));
  });
});
