import { describe, expect, it } from "vitest";

import {
  currentExpectedRevisions,
  manifest,
  retainedV6Evidence,
  retainedV8Evidence,
} from "./e2e-evidence-fixtures.js";
import {
  retainedE2eEvidenceV8Schema,
  retainedReconnectE2eEvidenceV8Schema,
  verifyRetainedE2eEvidence,
} from "../src/e2e-evidence.js";

describe("retained recording playback evidence", () => {
  it("keeps historical v8 readable while requiring playback proof from the current collector", () => {
    const historical = retainedV6Evidence();
    const current = retainedV8Evidence();
    const { recordingPlayback: _recordingPlayback, ...withoutProof } = current;

    expect(verifyRetainedE2eEvidence(
      manifest(),
      historical,
      currentExpectedRevisions,
    ).failures.map(({ code }) => code)).not.toContain("RECORDING_PLAYBACK_PROOF_MISSING");
    expect(retainedE2eEvidenceV8Schema.safeParse(withoutProof).success).toBe(true);
    expect(retainedReconnectE2eEvidenceV8Schema.safeParse(withoutProof).success).toBe(false);
    expect(verifyRetainedE2eEvidence(
      manifest(), current, currentExpectedRevisions,
    ).passed).toBe(true);
  });

  it.each([
    {
      code: "RECORDING_PLAYBACK_RECORDING_MISMATCH",
      mutate: (evidence: ReturnType<typeof retainedV8Evidence>) => {
        evidence.recordingPlayback.manifest.recordingId = "wrong-recording";
      },
    },
    {
      code: "RECORDING_PLAYBACK_TRACK_MISMATCH",
      mutate: (evidence: ReturnType<typeof retainedV8Evidence>) => {
        evidence.recordingPlayback.tracks[0]!.checksumSha256 = "0".repeat(64);
      },
    },
    {
      code: "RECORDING_PLAYBACK_TRACK_MISMATCH",
      mutate: (evidence: ReturnType<typeof retainedV8Evidence>) => {
        Object.assign(evidence.recordingPlayback.tracks[0]!, { statusCode: 200 });
      },
    },
    {
      code: "RECORDING_PLAYBACK_READINESS_NOT_PROVEN",
      mutate: (evidence: ReturnType<typeof retainedV8Evidence>) => {
        evidence.recordingPlayback.manifest.readinessExpectation = "transition";
        evidence.recordingPlayback.manifest.statuses = ["ready"];
      },
    },
    {
      code: "RECORDING_PLAYBACK_RESUME_NOT_PROVEN",
      mutate: (evidence: ReturnType<typeof retainedV8Evidence>) => {
        evidence.recordingPlayback.resume.statusCode = 204;
      },
    },
    {
      code: "RECORDING_PLAYBACK_CAPABILITY_RETAINED",
      mutate: (evidence: ReturnType<typeof retainedV8Evidence>) => {
        evidence.publication.embedDescription +=
          ` https://recordings.example.test/recordings/playback#v1.${"a".repeat(43)}.${"b".repeat(43)}`;
      },
    },
  ])("rejects $code", ({ code, mutate }) => {
    const evidence = retainedV8Evidence();
    mutate(evidence);

    expect(verifyRetainedE2eEvidence(
      manifest(),
      evidence,
      currentExpectedRevisions,
    ).failures.map((failure) => failure.code)).toContain(code);
  });
});
