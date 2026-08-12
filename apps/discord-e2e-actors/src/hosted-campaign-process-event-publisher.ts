import type { ConversationAnswerPlaybackIntent } from
  "@discord-meeting/conversation-runtime-contracts";

import type { ConversationVoiceCampaignProofV1 } from "./conversation-voice-campaign-proof.js";
import { serializeHostedCampaignProcessEvent } from "./hosted-campaign-process-event.js";

interface HostedCampaignEventContext {
  readonly additionalCaptures: readonly unknown[];
  readonly hostedCampaignId?: string;
  readonly runId: string;
}
interface HostedReconnectEventContext {
  readonly releaseGate: { readonly campaignId: string } | undefined;
  readonly runId: string;
  readonly scenario: "overlap" | "reconnect" | "sequential";
}
type EventWriter = (value: string) => void;
const stdoutWriter: EventWriter = (value) => {process.stdout.write(value);};

export function publishObserverSubscribed(
  config: HostedCampaignEventContext,
  authenticatedObserverBotId: string,
  write: EventWriter = stdoutWriter,
): void {
  if (config.additionalCaptures.length === 0) {return;}
  writeHostedEvent(requiredCampaignId(config.hostedCampaignId), config.runId, {
    action: { kind: "observer-subscribed" }, evidence: { authenticatedObserverBotId },
  }, write);
}

export function publishAnswerIntent(
  config: HostedCampaignEventContext,
  intent: ConversationAnswerPlaybackIntent | undefined,
  intentObservedAt: string | undefined,
  write: EventWriter = stdoutWriter,
): void {
  if (config.additionalCaptures.length === 0 || intent === undefined || intentObservedAt === undefined) {return;}
  writeHostedEvent(requiredCampaignId(config.hostedCampaignId), config.runId, {
    action: { kind: "answer-intent" },
    evidence: { observedAtEpochMilliseconds: Date.parse(intentObservedAt), turnId: intent.turnId },
  }, write);
}

export function publishAnswerObserverReady(
  config: HostedCampaignEventContext,
  proof: ConversationVoiceCampaignProofV1,
  write: EventWriter = stdoutWriter,
): void {
  if (config.additionalCaptures.length === 0) {return;}
  const receipt = proof.observerReadyReceipt;
  writeHostedEvent(requiredCampaignId(config.hostedCampaignId), config.runId, {
    action: { kind: "answer-observer-ready" },
    evidence: {
      observedAtEpochMilliseconds: Date.parse(receipt.readyPublishedAt), turnId: receipt.turnId,
    },
  }, write);
}

export function publishAnswerFirstPacket(
  config: HostedCampaignEventContext,
  intent: ConversationAnswerPlaybackIntent | undefined,
  intentObservedAt: string | undefined,
  firstPacketAtEpochMilliseconds: number,
  write: EventWriter = stdoutWriter,
): void {
  if (config.additionalCaptures.length === 0 || intent === undefined || intentObservedAt === undefined) {return;}
  const intentObservedAtEpochMilliseconds = Date.parse(intentObservedAt);
  const answerLatencyMilliseconds = firstPacketAtEpochMilliseconds - intentObservedAtEpochMilliseconds;
  if (!Number.isSafeInteger(answerLatencyMilliseconds) || answerLatencyMilliseconds < 0) {
    throw new Error("Addressed answer first packet predates its exact playback intent");
  }
  writeHostedEvent(requiredCampaignId(config.hostedCampaignId), config.runId, {
    action: { kind: "answer-first-packet" },
    evidence: {
      answerLatencyMilliseconds,
      observedAtEpochMilliseconds: firstPacketAtEpochMilliseconds,
      turnId: intent.turnId,
    },
  }, write);
}

export function publishCaptureRetained(
  config: HostedCampaignEventContext,
  ordinal: number,
  outputPath: string,
  write: EventWriter = stdoutWriter,
): void {
  if (config.additionalCaptures.length === 0) {return;}
  writeHostedEvent(requiredCampaignId(config.hostedCampaignId), config.runId, {
    action: { kind: "capture-retained", ordinal },
    evidence: { ordinal, outputPath, retained: true },
  }, write);
}

export function publishReconnectTransition(
  config: HostedReconnectEventContext,
  input: {
    readonly actorName: "speaker-a" | "speaker-b";
    readonly authenticatedParticipantId: string;
    readonly observedAtEpochMilliseconds: number;
    readonly type: "disconnected" | "playback-end" | "playback-start" | "ready";
  },
  write: EventWriter = stdoutWriter,
): void {
  if (config.releaseGate === undefined || config.scenario !== "reconnect" ||
    input.actorName !== "speaker-b" ||
    (input.type !== "disconnected" && input.type !== "ready")) {
    return;
  }
  const evidence = {
    observedAtEpochMilliseconds: input.observedAtEpochMilliseconds,
    participantId: input.authenticatedParticipantId,
  };
  const event = input.type === "disconnected"
    ? { action: { kind: "reconnect-left" as const }, evidence }
    : { action: { kind: "reconnect-ready" as const }, evidence };
  writeHostedEvent(config.releaseGate.campaignId, config.runId, event, write);
}

function writeHostedEvent(
  campaignId: string,
  runId: string,
  event: Parameters<typeof serializeHostedCampaignProcessEvent>[0]["event"],
  write: EventWriter,
): void {
  write(serializeHostedCampaignProcessEvent({
    campaignId, event, kind: "hosted-campaign-barrier", runId, schemaVersion: 1,
  }));
}

function requiredCampaignId(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Hosted campaign observer event is missing its campaign ID");
  }
  return value;
}
