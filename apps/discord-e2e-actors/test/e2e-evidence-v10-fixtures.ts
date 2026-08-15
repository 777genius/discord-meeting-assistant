import {
  retainedE2eEvidenceV9Schema,
  retainedE2eEvidenceV10Schema,
  type RetainedE2eEvidence,
  type RetainedE2eEvidenceV9,
} from "../src/e2e-evidence.js";
import {
  conversationVoiceCampaignObserverReadyReceipt,
  conversationVoiceCampaignPlanDigest,
} from "../src/conversation-voice-campaign-proof.js";
import { HOSTED_VOICE_QUALIFICATION_POLICY_V1 } from
  "../src/hosted-voice-qualification-policy.js";
import { qualifyProviderlessVoiceDurability } from
  "../src/providerless-voice-durability-qualification.js";
import {
  overlapEvidence,
  reidentify,
  retainedV6Evidence,
  retainedV8Evidence,
  sequentialEvidence,
} from "./e2e-evidence-fixtures.js";
import { serviceLevelEvidenceForIdentity } from "./e2e-service-level-fixtures.js";

const currentRelease = Object.freeze({
  releaseBindingSha256: "1".repeat(64),
  releaseId: "voice-release-1",
  trustRootSha256: "2".repeat(64),
});

export function currentV10Campaign(): RetainedE2eEvidence[] {
  const sequential = reidentify(retainedV6Evidence(sequentialEvidence()), "sequential-v6");
  const overlap = reidentify(retainedV6Evidence(overlapEvidence()), "overlap-v6");
  const voiceV9 = v9ReconnectEvidence();
  const durabilityQualification = qualifyProviderlessVoiceDurability({
    release: currentRelease,
    sourceRevision: voiceV9.deployment.meetingPlatform.sourceRevision,
  });
  const postCall = (source: RetainedE2eEvidence) => retainedE2eEvidenceV10Schema.parse({
    ...source,
    durabilityQualification,
    qualificationKind: "post-call",
    qualificationPolicy: HOSTED_VOICE_QUALIFICATION_POLICY_V1,
    release: currentRelease,
    schemaVersion: 10,
  });
  const oldSources = voiceV9.serviceLevelSources;
  const voice = retainedE2eEvidenceV10Schema.parse({
    ...voiceV9,
    durabilityQualification,
    qualificationKind: "voice",
    qualificationPolicy: HOSTED_VOICE_QUALIFICATION_POLICY_V1,
    release: currentRelease,
    schemaVersion: 10,
    serviceLevelSources: {
      ...oldSources,
      discordPlaybackLinkProof: {
        ...oldSources.discordPlaybackLinkProof,
        readiness: {
          capabilitySha256: oldSources.discordPlaybackLinkProof.capabilitySha256,
          messageId: oldSources.discordPlaybackLinkProof.messageId,
          readinessExpectation: "processing-to-ready",
          recordingId: oldSources.discordPlaybackLinkProof.recordingId,
          status: "ready",
          statuses: ["processing", "ready"],
          trackCount: 2,
        },
      },
      schemaVersion: 2,
    },
  });
  return [postCall(sequential), postCall(overlap), voice];
}

function v9ReconnectEvidence(): RetainedE2eEvidenceV9 {
  const source = reidentify(retainedV8Evidence(), "reconnect-v9");
  const captures = source.conversation.voice.map((voice, index) => ({
    expectedDuration: voice.capture.expectedDuration,
    ordinal: index + 1,
    outputPath: `/evidence/capture-${index + 1}.json`,
    purpose: voice.correlation.purpose,
    resolvedAttemptId: voice.correlation.attemptId,
    resolvedTurnId: voice.correlation.turnId,
    role: [
      "observer-unknown",
      "speaker-ru-known",
      "speaker-en-known",
      "speaker-d-unknown",
      "speaker-d-addressed-answer",
      "explicit-group-farewell",
    ][index]!,
  }));
  const plan = {
    captures,
    kind: "conversation-voice-campaign-preflight" as const,
    status: "validated" as const,
  };
  const planDigestSha256 = conversationVoiceCampaignPlanDigest(plan);
  const { serviceLevels, serviceLevelSources } = serviceLevelEvidenceForIdentity({
    meetingId: source.meetingId,
    messageId: source.publication.messageId,
    runId: source.actorRun.runId,
    transcriptId: source.transcript.transcriptId,
  });

  return retainedE2eEvidenceV9Schema.parse({
    ...source,
    conversation: {
      ...source.conversation,
      campaignProof: {
        observerReadyReceipt: conversationVoiceCampaignObserverReadyReceipt({
          authenticatedObserverBotId: "1533867700575670282",
          meetingId: "meeting-1",
          plan,
          readyPublishedAt: "1970-01-01T00:00:00.000Z",
          runId: source.actorRun.runId,
          target: {
            craigBotId: "1534231284467896512",
            guildId: "1533228590643155034",
            observerApplicationId: "1533867700575670282",
            voiceChannelId: "1533228823045214398",
          },
        }),
        plan,
        planDigestSha256,
        schemaVersion: 1,
      },
    },
    schemaVersion: 9,
    serviceLevels,
    serviceLevelSources,
  });
}
