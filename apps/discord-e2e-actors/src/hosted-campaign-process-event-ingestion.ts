import type { HostedCampaignArtifactStore } from "./hosted-campaign-artifact-store.js";
import type {
  HostedCampaignBarrierAction,
  HostedCampaignProducedAction,
} from "./hosted-campaign-coordinator.js";
import {
  hostedCampaignProcessEventPrefix,
  hostedCampaignProcessEventV1Schema,
} from "./hosted-campaign-process-event.js";

export async function ingestHostedCampaignProcessEventLine(input: {
  readonly campaignId: string;
  readonly line: string;
  readonly publishedEvents: Set<string>;
  readonly declaredProductions: readonly HostedCampaignProducedAction[];
  readonly runId: string;
  readonly store: HostedCampaignArtifactStore;
}): Promise<boolean> {
  if (!input.line.startsWith(hostedCampaignProcessEventPrefix)) {return false;}
  const parsed = hostedCampaignProcessEventV1Schema.parse(JSON.parse(
    input.line.slice(hostedCampaignProcessEventPrefix.length),
  ) as unknown);
  if (parsed.campaignId !== input.campaignId || parsed.runId !== input.runId) {
    throw new Error("Hosted campaign event campaign or run correlation mismatch");
  }
  const declared = input.declaredProductions.filter((produced) =>
    produced.runId === parsed.runId && sameAction(produced.action, parsed.event.action)
  );
  if (declared.length !== 1) {
    throw new Error(`Hosted campaign process event ${eventIdentity(parsed.event.action)} is not exactly declared`);
  }
  const identity = eventIdentity(parsed.event.action);
  if (input.publishedEvents.has(identity)) {
    throw new Error(`Hosted campaign duplicate event ${identity}`);
  }
  input.publishedEvents.add(identity);
  await publishProcessEvent(input.store, parsed.event);
  return true;
}

function publishProcessEvent(
  store: HostedCampaignArtifactStore,
  event: ReturnType<typeof hostedCampaignProcessEventV1Schema.parse>["event"],
): Promise<void> {
  switch (event.action.kind) {
    case "capture-retained": return store.publishAction(event.action,
      hostedCampaignProcessEventV1Schema.shape.event.options[1].parse(event).evidence);
    case "observer-subscribed": return store.publishAction(event.action,
      hostedCampaignProcessEventV1Schema.shape.event.options[0].parse(event).evidence);
    case "reconnect-left": return store.publishAction(event.action,
      hostedCampaignProcessEventV1Schema.shape.event.options[2].parse(event).evidence);
    case "reconnect-ready": return store.publishAction(event.action,
      hostedCampaignProcessEventV1Schema.shape.event.options[3].parse(event).evidence);
    case "answer-intent": return store.publishAction(event.action,
      hostedCampaignProcessEventV1Schema.shape.event.options[4].parse(event).evidence);
    case "answer-observer-ready": return store.publishAction(event.action,
      hostedCampaignProcessEventV1Schema.shape.event.options[5].parse(event).evidence);
    case "answer-first-packet": return store.publishAction(event.action,
      hostedCampaignProcessEventV1Schema.shape.event.options[6].parse(event).evidence);
    default: return Promise.reject(new Error("Unsupported hosted campaign process event"));
  }
}

function eventIdentity(action: HostedCampaignBarrierAction): string {
  return action.kind === "capture-retained" ? `${action.kind}:${action.ordinal}` : action.kind;
}

function sameAction(left: HostedCampaignBarrierAction, right: HostedCampaignBarrierAction): boolean {
  if (left.kind !== right.kind) {return false;}
  const leftOrdinal = "ordinal" in left ? left.ordinal : undefined;
  const rightOrdinal = "ordinal" in right ? right.ordinal : undefined;
  const leftRunId = "runId" in left ? left.runId : undefined;
  const rightRunId = "runId" in right ? right.runId : undefined;
  return leftOrdinal === rightOrdinal && leftRunId === rightRunId;
}
