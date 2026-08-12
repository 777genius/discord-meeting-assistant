import type { ConversationAnswerPlaybackIntent } from
  "@discord-meeting/conversation-runtime-contracts";

import type { ConversationVoiceCampaignProofV1 } from "./conversation-voice-campaign-proof.js";
import { serializeHostedCampaignProcessEvent } from "./hosted-campaign-process-event.js";

interface HostedCampaignEventContext {
  readonly additionalCaptures: readonly unknown[];
  readonly runId: string;
}
type EventWriter = (value: string) => void;
const stdoutWriter: EventWriter = (value) => {process.stdout.write(value);};

export function publishObserverSubscribed(
  config: HostedCampaignEventContext,
  authenticatedObserverBotId: string,
  write: EventWriter = stdoutWriter,
): void {
  if (config.additionalCaptures.length === 0) {return;}
  writeHostedEvent(config.runId, {
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
  writeHostedEvent(config.runId, {
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
  writeHostedEvent(config.runId, {
    action: { kind: "answer-observer-ready" },
    evidence: {
      observedAtEpochMilliseconds: Date.parse(receipt.readyPublishedAt), turnId: receipt.turnId,
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
  writeHostedEvent(config.runId, {
    action: { kind: "capture-retained", ordinal },
    evidence: { ordinal, outputPath, retained: true },
  }, write);
}

function writeHostedEvent(
  runId: string,
  event: Parameters<typeof serializeHostedCampaignProcessEvent>[0]["event"],
  write: EventWriter,
): void {
  write(serializeHostedCampaignProcessEvent({
    event, kind: "hosted-campaign-barrier", runId, schemaVersion: 1,
  }));
}
