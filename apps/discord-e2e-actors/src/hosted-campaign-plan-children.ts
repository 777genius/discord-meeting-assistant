import type { HostedCampaignExecutableSpec } from "./hosted-campaign-coordinator.js";
import {
  makeHostedCampaignChildContext,
  type HostedCampaignRuns,
  reference,
} from "./hosted-campaign-plan-child-context.js";
import type {
  HostedCampaignDefinitionV1,
  HostedCampaignRuntimeBindingsV1,
} from "./hosted-campaign-plan-builder.js";
import {
  makePlaybackLinkObserver,
  makeProvenanceProbe,
  makeRecordingReadyCollector,
  makeReplayAttestationPublisher,
} from "./hosted-campaign-plan-recording-children.js";
import {
  makeServiceLevelPaths,
  makeServiceLevelSources,
  makeServiceLevels,
} from "./hosted-campaign-plan-sla-children.js";
import {
  makeActor,
  makeConversationObserver,
  makeSupplementalPlayer,
} from "./hosted-campaign-plan-voice-children.js";
import {
  makeCampaignVerifier,
  makeCollector,
} from "./hosted-campaign-plan-verification-children.js";

export function makeHostedCampaignChildren(
  definition: HostedCampaignDefinitionV1,
  bindings: HostedCampaignRuntimeBindingsV1,
  runs: HostedCampaignRuns,
  campaignRoot: string,
): readonly HostedCampaignExecutableSpec[] {
  const context = makeHostedCampaignChildContext(definition, bindings, runs, campaignRoot);
  const {
    captures, conversationCompleted, overlap, overlapBinding, playbackLinkSeen, provenanceAfter,
    provenanceBefore, reconnect, reconnectBinding, recordingReady, replayAttestationReady,
    runVerified, sequential, sequentialBinding, serviceLevelsReady, supplementalCompleted,
  } = context;
  const serviceLevelPaths = makeServiceLevelPaths(context);

  return Object.freeze([
    makeActor(context, sequential, provenanceBefore),
    makeActor(context, overlap, runVerified[0]!),
    makeActor(context, reconnect, captures[0]!, supplementalCompleted),
    makeProvenanceProbe(context, "before", sequential, provenanceBefore),
    makeRecordingReadyCollector(context, sequential),
    makeReplayAttestationPublisher(context, sequential),
    makeCollector(context, {
      action: runVerified[0]!, binding: sequentialBinding, run: sequential,
      required: [
        provenanceBefore, recordingReady[0]!, replayAttestationReady[0]!,
        reference(sequential, { kind: "actor-completed", ordinal: 1, runId: sequential.runId }),
      ], serviceLevelsPath: serviceLevelPaths.levels,
    }),
    makeRecordingReadyCollector(context, overlap),
    makeReplayAttestationPublisher(context, overlap),
    makeCollector(context, {
      action: runVerified[1]!, binding: overlapBinding, run: overlap,
      required: [
        runVerified[0]!, recordingReady[1]!, replayAttestationReady[1]!,
        reference(overlap, { kind: "actor-completed", ordinal: 2, runId: overlap.runId }),
      ], serviceLevelsPath: serviceLevelPaths.levels,
    }),
    makeConversationObserver(context),
    makeSupplementalPlayer(context),
    makeRecordingReadyCollector(context, reconnect),
    makeReplayAttestationPublisher(context, reconnect),
    makePlaybackLinkObserver(context),
    makeServiceLevelSources(context, serviceLevelPaths),
    makeServiceLevels(context, serviceLevelPaths),
    makeCollector(context, {
      action: runVerified[2]!, binding: reconnectBinding, run: reconnect,
      required: [
        recordingReady[2]!, replayAttestationReady[2]!, playbackLinkSeen, serviceLevelsReady,
        conversationCompleted, supplementalCompleted,
      ], serviceLevelsPath: serviceLevelPaths.levels,
    }),
    makeProvenanceProbe(context, "after", reconnect, provenanceAfter),
    makeCampaignVerifier(context),
  ]);
}
