import type { z } from "zod";
import { fixtureManifestV1Schema } from "./e2e-fixture-manifest-schema.js";
import { unboundActorRunEvidenceV1Schema } from "./e2e-evidence-schema.js";
import { characterErrorRate, normalizeTranscriptSemantics, wordErrorRate } from "./e2e-evidence-text-metrics.js";
import { requireEvidence as check, same } from "./oss-campaign-artifacts.js";
import type { OssRun } from "./oss-campaign-profile.js";

type Manifest = z.infer<typeof fixtureManifestV1Schema>;
export function verifyOssQuality(run: OssRun, manifest: Manifest, actorInput: unknown): void {
  const actor = unboundActorRunEvidenceV1Schema.strict().parse(actorInput);
  check(actor.runId === run.runId && actor.scenario === run.scenario &&
    actor.fixtureSetId === manifest.fixtureSetId, "Actor identity mismatch");
  check(actor.fixtures.length === 2, "Exactly two fixture proofs required");
  check(actor.events.every((event, index) => event.atEpochMs >= run.startedAtMs &&
    event.atEpochMs <= run.endedAtMs && (index === 0 ||
      event.atEpochMs >= actor.events[index - 1]!.atEpochMs)), "Actor timeline outside recording");
  check(actor.events.every((event) => ["speaker-a", "speaker-b"].includes(event.actorName)),
    "Unexpected actor");
  const windows = manifest.fixtures.map((fixture) => {
    const proof = actor.fixtures.filter((entry) => entry.fixtureId === fixture.fixtureId);
    check(proof.length === 1 && proof[0]!.audioSha256 === fixture.audioSha256 &&
      proof[0]!.sourceSha256 === fixture.sourceSha256 && proof[0]!.durationMs === fixture.durationMs,
    "Actor fixture checksum mismatch");
    const events = actor.events.filter((event) => event.actorName === fixture.actorName);
    const expected = run.scenario === "reconnect" && fixture.actorName === "speaker-b"
      ? ["ready", "disconnected", "ready", "playback-start", "playback-end"]
      : ["ready", "playback-start", "playback-end"];
    check(same(events.map((event) => event.type), expected), "Duplicate/missing actor playback or reconnect");
    const start = events.at(-2)!;
    const end = events.at(-1)!;
    check(start.fixtureId === fixture.fixtureId && end.fixtureId === fixture.fixtureId &&
      end.atEpochMs > start.atEpochMs &&
      Math.abs(end.atEpochMs - start.atEpochMs - fixture.durationMs) <= 3500,
    "Invalid fixture playback window");
    return { start: start.atEpochMs - run.startedAtMs, end: end.atEpochMs - run.startedAtMs,
      fixture };
  });
  const [a, b] = windows;
  check(a && b, "Two fixture windows required");
  if (run.scenario === "sequential") {
    check(b.start >= a.end + 3500 && b.start <= a.end + 7000, "Sequential gap mismatch");
  } else {
    check(b.start >= a.start + 750 && b.start < a.end && a.start < b.end, "Playback overlap missing");
  }
  if (run.scenario === "overlap") check(b.start - a.start <= 4250, "Overlap delay mismatch");
  if (run.scenario === "reconnect") {
    const events = actor.events.filter((event) => event.actorName === "speaker-b");
    check(events[1]!.atEpochMs >= run.startedAtMs + a.start + 750 &&
      events[2]!.atEpochMs < run.startedAtMs + a.end, "Reconnect must occur during A");
  }
  // Score the finalized ledger independently; partial revisions are never text evidence.
  for (const [kind, turns] of [["batch", run.transcript.turns], ["live", run.liveTurns]] as const) {
    check(new Set(turns.map((turn) => turn.turnId)).size === turns.length, "Duplicate transcript turn");
    check(turns.every((turn) => windows.some(({ fixture }) => fixture.speakerId === turn.speakerId) &&
      turn.endMs > turn.startMs && turn.endMs <= run.endedAtMs - run.startedAtMs), `Invalid ${kind} turn`);
    for (const { fixture, start, end } of windows) {
      const speakerTurns = turns.filter((turn) => turn.speakerId === fixture.speakerId)
        .sort((left, right) => left.startMs - right.startMs);
      const actual = speakerTurns.map((turn) => turn.text).join(" ");
      check(wordErrorRate(fixture.sourceText, actual) <= 0.35, "WER exceeded");
      check(characterErrorRate(fixture.sourceText, actual) <= 0.20, "CER exceeded");
      check(fixture.requiredTerms.every((term) =>
        normalizeTranscriptSemantics(actual).includes(normalizeTranscriptSemantics(term))), "Required term missing");
      check(speakerTurns.length > 0 &&
        Math.abs(speakerTurns[0]!.startMs - start - fixture.speechStartOffsetMs) <= 3500 &&
        Math.abs(speakerTurns.at(-1)!.endMs - end) <= 3500, "Transcript timeline mismatch");
    }
    const overlap = turns.some((left) => turns.some((right) => left.speakerId !== right.speakerId &&
      left.startMs < right.endMs && right.startMs < left.endMs));
    check(overlap === (run.scenario !== "sequential"), "Transcript overlap mismatch");
  }
}
