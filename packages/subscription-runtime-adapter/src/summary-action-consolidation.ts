import type { ProviderMeetingSummary } from "./provider-summary-schema.js";

interface TranscriptTurnIdentity {
  readonly startMs: number;
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
  const speakerBlockByTurnId = indexContiguousSpeakerBlocks(transcriptTurns);
  const assignedActions = summary.actionItems.filter(
    ({ ownerSpeakerId }) => ownerSpeakerId !== null,
  );
  const actionsNotCoveredByOwner = summary.actionItems.filter((action) =>
    action.ownerSpeakerId !== null ||
    !assignedActions.some((assigned) =>
      assignedActionCoversUnassigned(action, assigned, speakerByTurnId)
    )
  );
  const actionItems = actionsNotCoveredByOwner.filter((action) =>
    action.ownerSpeakerId !== null ||
    !summary.decisions.some((decision) =>
      decisionCoversUnassignedAction(
        action,
        decision,
        speakerBlockByTurnId,
      )
    )
  );
  return actionItems.length === summary.actionItems.length
    ? summary
    : { ...summary, actionItems };
}

function decisionCoversUnassignedAction(
  action: ProviderMeetingSummary["actionItems"][number],
  decision: ProviderMeetingSummary["decisions"][number],
  speakerBlockByTurnId: ReadonlyMap<string, number>,
): boolean {
  if (action.deadline === null) {
    return false;
  }
  const actionBlock = singleGroundedSpeakerBlock(
    action.evidenceTurnIds,
    speakerBlockByTurnId,
  );
  const decisionBlock = singleGroundedSpeakerBlock(
    decision.evidenceTurnIds,
    speakerBlockByTurnId,
  );
  if (actionBlock === undefined || actionBlock !== decisionBlock) {
    return false;
  }
  const actionTerms = meaningfulTerms(action.text);
  const deadlineTerms = meaningfulTerms(action.deadline);
  const decisionTerms = meaningfulTerms(decision.text);
  return actionTerms.size >= 2 && deadlineTerms.size >= 1 &&
    [...actionTerms, ...deadlineTerms].every((term) => decisionTerms.has(term));
}

function singleGroundedSpeakerBlock(
  evidenceTurnIds: readonly string[],
  speakerBlockByTurnId: ReadonlyMap<string, number>,
): number | undefined {
  let groundedBlock: number | undefined;
  for (const turnId of evidenceTurnIds) {
    const block = speakerBlockByTurnId.get(turnId);
    if (
      block === undefined ||
      (groundedBlock !== undefined && block !== groundedBlock)
    ) {
      return undefined;
    }
    groundedBlock = block;
  }
  return groundedBlock;
}

function indexContiguousSpeakerBlocks(
  transcriptTurns: readonly TranscriptTurnIdentity[],
): ReadonlyMap<string, number> {
  const blocks = new Map<string, number>();
  let block = -1;
  let previousSpeakerId: string | undefined;
  for (const turn of transcriptTurns.toSorted((left, right) =>
    left.startMs - right.startMs || left.turnId.localeCompare(right.turnId)
  )) {
    if (turn.speakerId !== previousSpeakerId) {
      block += 1;
      previousSpeakerId = turn.speakerId;
    }
    blocks.set(turn.turnId, block);
  }
  return blocks;
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
      ?.filter((term) => term.length >= 3 && !isActionLabelTerm(term))
      .map(canonicalActionTerm) ?? [],
  );
}

function isActionLabelTerm(term: string): boolean {
  return /^(?:speakers?|спикер(?:а|у|ом|е|ы|ов|ам|ами|ах)?)$/u.test(term);
}

function canonicalActionTerm(term: string): string {
  if (/^\p{Script=Cyrillic}{6,}$/u.test(term)) {
    return term.replace(/(?:ить|ыть|ать|ять|ит)$/u, "");
  }
  return term;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}
