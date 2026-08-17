import type { ProviderMeetingSummary } from "./provider-summary-schema.js";

interface TranscriptTurnIdentity {
  readonly speakerId: string;
  readonly turnId: string;
}

export function consolidateCoveredUnassignedActions(
  summary: ProviderMeetingSummary,
  transcriptTurns: readonly TranscriptTurnIdentity[],
): ProviderMeetingSummary {
  const speakerByTurnId = new Map(
    transcriptTurns.map(({ speakerId, turnId }) => [turnId, speakerId]),
  );
  const assignedActions = summary.actionItems.filter(
    ({ ownerSpeakerId }) => ownerSpeakerId !== null,
  );
  const actionItems = summary.actionItems.filter((action) =>
    action.ownerSpeakerId !== null ||
    !assignedActions.some((assigned) =>
      assignedActionCoversUnassigned(action, assigned, speakerByTurnId)
    )
  );
  return actionItems.length === summary.actionItems.length
    ? summary
    : { ...summary, actionItems };
}

function assignedActionCoversUnassigned(
  unassigned: ProviderMeetingSummary["actionItems"][number],
  assigned: ProviderMeetingSummary["actionItems"][number],
  speakerByTurnId: ReadonlyMap<string, string>,
): boolean {
  const ownerSpeakerId = assigned.ownerSpeakerId;
  if (
    ownerSpeakerId === null ||
    unassigned.deadline === null ||
    assigned.deadline === null ||
    normalizeText(unassigned.deadline) !== normalizeText(assigned.deadline) ||
    !assigned.evidenceTurnIds.some((turnId) =>
      speakerByTurnId.get(turnId) === ownerSpeakerId
    ) ||
    unassigned.evidenceTurnIds.some((turnId) =>
      speakerByTurnId.get(turnId) === ownerSpeakerId
    )
  ) {
    return false;
  }
  const unassignedTerms = meaningfulTerms(unassigned.text);
  const assignedTerms = meaningfulTerms(assigned.text);
  return unassignedTerms.size >= 2 &&
    [...unassignedTerms].every((term) => assignedTerms.has(term));
}

function meaningfulTerms(value: string): ReadonlySet<string> {
  return new Set(
    normalizeText(value)
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 3 && !actionLabelTerms.has(term))
      .map(canonicalActionTerm) ?? [],
  );
}

const actionLabelTerms = new Set(["speaker", "спикер"]);

function canonicalActionTerm(term: string): string {
  if (/^\p{Script=Cyrillic}{6,}$/u.test(term)) {
    return term.replace(/(?:ить|ыть|ать|ять|ит)$/u, "");
  }
  return term;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}
