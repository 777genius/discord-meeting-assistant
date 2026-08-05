import type {
  FixtureManifestV1,
  RetainedE2eEvidence,
} from "./e2e-evidence-schema.js";
import {
  expectedPublicationThreadCount,
  publicationContainerIdentity,
} from "./e2e-evidence-publication.js";
import {
  equivalentMeetingText,
  normalize,
  normalizeTranscriptSemantics,
} from "./e2e-evidence-text-metrics.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

export function verifyEvidenceReferences(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  const turnIds = new Set(evidence.transcript.turns.map(({ turnId }) => turnId));
  const speakerIds = new Set(manifest.fixtures.map(({ speakerId }) => speakerId));
  for (const [kind, items] of evidenceItems(evidence)) {
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
  if (evidence.summary.transcriptId !== evidence.transcript.transcriptId) {
    fail("SUMMARY_TRANSCRIPT_MISMATCH", "summary references a different final transcript");
  }
  const questionIds = evidence.summary.openQuestions.map(({ id }) => id);
  if (new Set(questionIds).size !== questionIds.length) {
    fail("DUPLICATE_OPEN_QUESTION", "summary contains duplicate open-question IDs");
  }
}

export function verifySummarySemantics(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  verifyDecisionTerms(manifest, evidence, fail);
  verifyActionItems(manifest, evidence, fail);
  verifyTopicTerms(manifest, evidence, fail);
}

export function verifyDiscordSummaryUx(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  const description = evidence.publication.embedDescription;
  if (containsInternalIdentifier(description, evidence.summary.summaryId)) {
    fail("DISCORD_INTERNAL_ID_VISIBLE", "Discord summary exposes an internal identifier");
  }
  if (evidence.schemaVersion === 3 && description.includes("Основание:")) {
    fail("DISCORD_LEGACY_EVIDENCE_LABEL_VISIBLE", "Discord summary exposes the legacy evidence label");
  }
  if (evidence.schemaVersion === 2 && !description.includes("Основание:")) {
    fail("DISCORD_EVIDENCE_LABEL_MISSING", "Discord summary has no human-readable evidence label");
  }
  if (!/\b\d{2}:\d{2}-\d{2}:\d{2}\b/u.test(description)) {
    fail("DISCORD_EVIDENCE_INTERVAL_MISSING", "Discord summary has no MM:SS-MM:SS evidence interval");
  }
  verifySpeakerMentions(manifest, description, fail);
  verifyActionOwnerMentions(manifest, description, fail);
}

export function verifyReplayIdentity(
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  if (evidence.replay.replayJob.afterProcessedOn <= evidence.replay.replayJob.beforeProcessedOn) {
    fail("REPLAY_NOT_EXECUTED", "BullMQ job has no later completed processing timestamp");
  }
  verifyReplayIds(evidence, fail);
  verifyBusinessEffectCounts(evidence, fail);
  verifyPublicationThreadCounts(evidence, fail);
}

function evidenceItems(evidence: RetainedE2eEvidence) {
  return [
    ["decision", evidence.summary.decisions],
    ["action item", evidence.summary.actionItems],
    ["open question", evidence.summary.openQuestions],
    ["topic", evidence.summary.topics],
  ] as const;
}

function verifyDecisionTerms(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  const decisionText = normalize(evidence.summary.decisions.map(({ text }) => text).join(" "));
  for (const term of manifest.summaryExpectations.decisionTerms) {
    if (!decisionText.includes(normalize(term))) {
      fail("DECISION_SEMANTICS_MISSING", `summary decisions omit ${term}`);
    }
  }
}

function verifyActionItems(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  for (const expected of manifest.summaryExpectations.actionItems) {
    const match = evidence.summary.actionItems.find((action) =>
      action.ownerSpeakerId === expected.ownerSpeakerId &&
      equivalentMeetingText(action.deadline, expected.deadline) &&
      expected.requiredTerms.every((term) =>
        normalizeTranscriptSemantics(action.text).includes(normalizeTranscriptSemantics(term)),
      ),
    );
    if (match === undefined) {
      fail(
        "ACTION_SEMANTICS_MISSING",
        `summary has no matching action for owner ${expected.ownerSpeakerId}`,
      );
    }
  }
}

function verifyTopicTerms(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
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

function containsInternalIdentifier(description: string, summaryId: string): boolean {
  return description.includes("turn:v1:") ||
    description.includes("meeting-projection:") ||
    description.includes(summaryId);
}

function verifySpeakerMentions(
  manifest: FixtureManifestV1,
  description: string,
  fail: VerificationFailureReporter,
): void {
  for (const fixture of manifest.fixtures) {
    if (!description.includes(`<@${fixture.speakerId}>`)) {
      fail(
        "DISCORD_SPEAKER_MENTION_MISSING",
        `Discord summary has no human-readable mention for speaker ${fixture.speakerId}`,
      );
    }
  }
}

function verifyActionOwnerMentions(
  manifest: FixtureManifestV1,
  description: string,
  fail: VerificationFailureReporter,
): void {
  for (const expected of manifest.summaryExpectations.actionItems) {
    const ownerMention = `<@${expected.ownerSpeakerId}>`;
    if (
      !description.includes(`Owner: ${ownerMention}`) &&
      !description.includes(`Ответственный: ${ownerMention}`)
    ) {
      fail(
        "DISCORD_ACTION_OWNER_MENTION_MISSING",
        `Discord summary has no owner mention for expected action ${expected.ownerSpeakerId}`,
      );
    }
  }
}

function verifyReplayIds(evidence: RetainedE2eEvidence, fail: VerificationFailureReporter): void {
  const identityPairs: ReadonlyArray<readonly [string, string, string]> = [
    ["meeting", evidence.meetingId, evidence.replay.meetingId],
    ["recording", evidence.recording.recordingId, evidence.replay.recordingId],
    ["transcript", evidence.transcript.transcriptId, evidence.replay.transcriptId],
    ["summary", evidence.summary.summaryId, evidence.replay.summaryId],
    [
      "publication container",
      publicationContainerIdentity(evidence.publication),
      publicationContainerIdentity(evidence.replay),
    ],
    ["message", evidence.publication.messageId, evidence.replay.messageId],
  ];
  for (const [kind, initial, replayed] of identityPairs) {
    if (initial !== replayed) {
      fail("REPLAY_IDENTITY_CHANGED", `${kind} identity changed after replay`);
    }
  }
}

function verifyBusinessEffectCounts(
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  const counts: ReadonlyArray<readonly [string, number]> = [
    ["initial meeting", evidence.database.matchingMeetingCount],
    ["initial recording", evidence.database.matchingRecordingCount],
    ["initial summary", evidence.database.matchingSummaryCount],
    ["initial transcript", evidence.database.matchingTranscriptCount],
    ["initial message", evidence.publication.matchingMessageCount],
    ["meeting", evidence.replay.matchingMeetingCount],
    ["recording", evidence.replay.matchingRecordingCount],
    ["summary", evidence.replay.matchingSummaryCount],
    ["transcript", evidence.replay.matchingTranscriptCount],
    ["message", evidence.replay.matchingMessageCount],
  ];
  for (const [kind, count] of counts) {
    if (count !== 1) {
      fail("DUPLICATE_BUSINESS_EFFECT", `${kind} marker count is ${count}, expected exactly one`);
    }
  }
}

function verifyPublicationThreadCounts(
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  for (const [phase, publication] of [
    ["initial", evidence.publication],
    ["replay", evidence.replay],
  ] as const) {
    const expectedThreadCount = expectedPublicationThreadCount(publication);
    if (publication.matchingThreadCount !== expectedThreadCount) {
      fail(
        "DUPLICATE_BUSINESS_EFFECT",
        `${phase} thread marker count is ${publication.matchingThreadCount}, expected ${expectedThreadCount}`,
      );
    }
  }
}
