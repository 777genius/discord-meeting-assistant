import {
  characterErrorRate,
  normalizeTranscriptSemantics,
  wordErrorRate,
} from "./e2e-evidence-text-metrics.js";
import type { TranscriptVerificationContext } from "./e2e-evidence-verification-types.js";

export function verifyTranscript(context: TranscriptVerificationContext): void {
  verifyTranscriptSpeakers(context);
  verifyTranscriptTurns(context);
  verifyFixtureTranscripts(context);
  verifyTranscriptOverlap(context);
}

function verifyTranscriptSpeakers(context: TranscriptVerificationContext): void {
  const { evidence, fail, manifest } = context;
  const expectedSpeakers = new Set(manifest.fixtures.map(({ speakerId }) => speakerId));
  const allowedSpeakers = new Set([
    ...expectedSpeakers,
    ...manifest.allowedBotSpeakerIds,
  ]);
  const recordedSpeakers = new Set(evidence.recording.speakerIds);
  const transcriptSpeakers = new Set(evidence.transcript.turns.map(({ speakerId }) => speakerId));
  for (const speakerId of expectedSpeakers) {
    if (!recordedSpeakers.has(speakerId) || !transcriptSpeakers.has(speakerId)) {
      fail("SPEAKER_MISSING", `speaker ${speakerId} is absent from recording or transcript evidence`);
    }
  }
  for (const speakerId of new Set([...recordedSpeakers, ...transcriptSpeakers])) {
    if (!allowedSpeakers.has(speakerId)) {
      fail("UNEXPECTED_SPEAKER", `unexpected speaker ${speakerId} appears in retained evidence`);
    }
  }
}

function verifyTranscriptTurns(context: TranscriptVerificationContext): void {
  const { evidence, fail } = context;
  for (const turn of evidence.transcript.turns) {
    if (turn.endMs <= turn.startMs) {
      fail("INVALID_TURN_TIME", `turn ${turn.turnId} must end after it starts`);
    }
  }
  const turnIds = evidence.transcript.turns.map(({ turnId }) => turnId);
  if (new Set(turnIds).size !== turnIds.length) {
    fail("DUPLICATE_TURN", "transcript turn IDs must be unique");
  }
}

function verifyFixtureTranscripts(context: TranscriptVerificationContext): void {
  const { evidence, fail, manifest, metrics, scenario } = context;
  for (const fixture of manifest.fixtures) {
    const turns = evidence.transcript.turns
      .filter(({ speakerId }) => speakerId === fixture.speakerId)
      .toSorted((left, right) => left.startMs - right.startMs);
    const expectedCount = scenario.playbackCountByFixture[fixture.fixtureId] ?? 0;
    const expectedText = Array.from({ length: expectedCount }, () => fixture.sourceText).join(" ");
    const actualText = turns.map(({ text }) => text).join(" ");
    const wordRate = wordErrorRate(expectedText, actualText);
    const characterRate = characterErrorRate(expectedText, actualText);
    metrics.push({
      characterErrorRate: characterRate,
      speakerId: fixture.speakerId,
      wordErrorRate: wordRate,
    });
    verifyErrorRates(fixture.fixtureId, wordRate, characterRate, manifest, fail);
    verifyRequiredTerms(fixture.fixtureId, fixture.requiredTerms, actualText, fail);
    verifyTranscriptTiming(context, fixture.fixtureId, turns);
  }
}

function verifyErrorRates(
  fixtureId: string,
  wordRate: number,
  characterRate: number,
  context: TranscriptVerificationContext["manifest"],
  fail: TranscriptVerificationContext["fail"],
): void {
  if (wordRate > context.thresholds.maxWordErrorRate) {
    fail("WER_EXCEEDED", `${fixtureId} WER ${wordRate.toFixed(3)} exceeds threshold`);
  }
  if (characterRate > context.thresholds.maxCharacterErrorRate) {
    fail("CER_EXCEEDED", `${fixtureId} CER ${characterRate.toFixed(3)} exceeds threshold`);
  }
}

function verifyRequiredTerms(
  fixtureId: string,
  terms: readonly string[],
  actualText: string,
  fail: TranscriptVerificationContext["fail"],
): void {
  const normalizedActual = normalizeTranscriptSemantics(actualText);
  for (const term of terms) {
    if (!normalizedActual.includes(normalizeTranscriptSemantics(term))) {
      fail("TERM_MISSING", `${fixtureId} transcript is missing required term ${term}`);
    }
  }
}

function verifyTranscriptTiming(
  context: TranscriptVerificationContext,
  fixtureId: string,
  turns: readonly TranscriptVerificationContext["evidence"]["transcript"]["turns"][number][],
): void {
  const fixture = context.manifest.fixtures.find((candidate) => candidate.fixtureId === fixtureId);
  if (fixture === undefined) {
    return;
  }
  const fixtureWindows = context.playbackWindows
    .filter((window) => window.fixtureId === fixtureId)
    .toSorted((left, right) => left.startMs - right.startMs);
  const firstWindow = fixtureWindows[0];
  const lastWindow = fixtureWindows.at(-1);
  const firstTurn = turns[0];
  const lastTurn = turns.at(-1);
  if (
    firstTurn !== undefined &&
    firstWindow !== undefined &&
    Math.abs(firstTurn.startMs - (firstWindow.startMs + fixture.speechStartOffsetMs)) >
      context.manifest.thresholds.timestampToleranceMs
  ) {
    context.fail("START_TIMESTAMP_MISMATCH", `${fixtureId} transcript start is outside tolerance`);
  }
  if (
    lastTurn !== undefined &&
    lastWindow !== undefined &&
    Math.abs(lastTurn.endMs - lastWindow.endMs) > context.manifest.thresholds.timestampToleranceMs
  ) {
    context.fail("END_TIMESTAMP_MISMATCH", `${fixtureId} transcript end is outside tolerance`);
  }
}

function verifyTranscriptOverlap(context: TranscriptVerificationContext): void {
  const { evidence, fail, scenario } = context;
  const fixtureSpeakerIds = new Set(context.manifest.fixtures.map(({ speakerId }) => speakerId));
  const fixtureTurns = evidence.transcript.turns.filter(({ speakerId }) =>
    fixtureSpeakerIds.has(speakerId)
  );
  const hasOverlap = fixtureTurns.some((left, leftIndex) =>
    fixtureTurns.some((right, rightIndex) =>
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
