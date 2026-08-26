import type { RetainedE2eEvidence } from "./e2e-evidence-schema.js";
import type { HistoricalReplyCampaignEvidenceV1 } from
  "./historical-reply-campaign-contract.js";

type V10Run = Extract<RetainedE2eEvidence, { readonly schemaVersion: 10 }>;
type Campaign = HistoricalReplyCampaignEvidenceV1["campaign"];

export function trustedHistoricalRosterMatches(campaign: Campaign, targetRun: V10Run): boolean {
  const actorKinds = new Map(campaign.rehydration.trustedLifecycle.actors.map(
    ({ actorId, kind }) => [actorId, kind],
  ));
  const intendedActors = [
    ...[...new Set(targetRun.transcript.turns.map(({ speakerId }) => speakerId))]
      .filter((actorId) => actorId !== campaign.botActorId)
      .map((actorId) => ({ actorId, kind: "human" as const })),
    { actorId: campaign.botActorId, kind: "automation" as const },
  ].toSorted((left, right) => left.actorId.localeCompare(right.actorId) ||
    left.kind.localeCompare(right.kind));
  const producer = campaign.producerEvidence;
  return JSON.stringify(campaign.intendedActors) === JSON.stringify(intendedActors) &&
    JSON.stringify(producer.actors) === JSON.stringify(intendedActors) &&
    JSON.stringify(producer.craigDeployment) === JSON.stringify(targetRun.deployment.craig) &&
    producer.identityProvenance.producerRevision === targetRun.deployment.craig.sourceRevision &&
    producer.identityProvenance.producerRevision ===
      campaign.rehydration.trustedLifecycle.producerRevision &&
    producer.lifecycleGeneration === campaign.rehydration.trustedLifecycle.lifecycleGeneration &&
    producer.meetingIdentity.meetingId === targetRun.meetingId &&
    producer.meetingIdentity.recordingId === targetRun.recording.recordingId &&
    actorKinds.get(campaign.botActorId) === "automation" &&
    campaign.canonicalAuthority.turns.every(({ speakerId }) =>
      actorKinds.get(speakerId) === "human" && speakerId !== campaign.botActorId);
}

export function historicalAuthorityMatchesRun(campaign: Campaign, targetRun: V10Run): boolean {
  const authority = campaign.canonicalAuthority;
  return targetRun.actorRun.scenario === "reconnect" && targetRun.qualificationKind === "voice" &&
    targetRun.conversation.botSpeakerId === campaign.botActorId &&
    targetRun.actorRun.runId === authority.runId && targetRun.meetingId === authority.meetingId &&
    targetRun.transcript.transcriptId === authority.transcriptId &&
    authority.meetingId === campaign.target.meetingId &&
    authority.transcriptId === campaign.target.transcriptId &&
    authority.meetingId === campaign.unsupportedTarget.meetingId &&
    authority.transcriptId === campaign.unsupportedTarget.transcriptId;
}
