import type {
  HostedCampaignBarrierAction,
  HostedCampaignEntrypoint,
  HostedCampaignExecutableCompletion,
  HostedCampaignExecutableSpec,
  HostedCampaignProducedAction,
} from "./hosted-campaign-coordinator.js";

type HostedCampaignActionKind = HostedCampaignBarrierAction["kind"];

interface HostedCampaignEntrypointCapability {
  readonly completionActionKinds: readonly HostedCampaignActionKind[];
  readonly emittedActionKinds: readonly HostedCampaignActionKind[];
}

export const HOSTED_CAMPAIGN_ENTRYPOINT_CAPABILITY_MATRIX = Object.freeze({
  actor: {
    completionActionKinds: ["actor-completed"],
    emittedActionKinds: ["reconnect-left", "reconnect-ready", "actor-scenario-playback-completed"],
  },
  "campaign-verifier": {
    completionActionKinds: ["campaign-verified"],
    emittedActionKinds: [],
  },
  collector: {
    completionActionKinds: ["run-verified"],
    emittedActionKinds: [],
  },
  "conversation-observer": {
    completionActionKinds: ["conversation-observer-completed"],
    emittedActionKinds: [
      "observer-subscribed", "capture-retained", "answer-intent",
      "answer-observer-ready", "answer-first-packet",
    ],
  },
  "evidence-verifier": {
    completionActionKinds: ["run-verified"],
    emittedActionKinds: [],
  },
  "greeting-ledger-observer": {
    completionActionKinds: ["greeting-ledger-ready"],
    emittedActionKinds: [],
  },
  "historical-reply-observer": {
    completionActionKinds: ["historical-reply-ready"], emittedActionKinds: [],
  },
  "historical-reply-preparer": {
    completionActionKinds: ["historical-reply-input-ready"], emittedActionKinds: [],
  },
  "live-memory-observer": {
    completionActionKinds: ["live-memory-ready"], emittedActionKinds: [],
  },
  "private-coverage-observer": {
    completionActionKinds: ["private-coverage-ready"], emittedActionKinds: [],
  },
  "remediation-bundle": {
    completionActionKinds: ["remediation-bundle-ready"], emittedActionKinds: [],
  },
  "live-observer": {
    completionActionKinds: [],
    emittedActionKinds: [],
  },
  "playback-link-observer": {
    completionActionKinds: ["playback-link-seen"],
    emittedActionKinds: [],
  },
  "provenance-probe": {
    completionActionKinds: ["provenance-before", "provenance-after"],
    emittedActionKinds: [],
  },
  "recording-ready": {
    completionActionKinds: ["recording-ready"],
    emittedActionKinds: [],
  },
  "replay-attestation-publisher": {
    completionActionKinds: ["replay-attestation-ready"],
    emittedActionKinds: [],
  },
  "service-level-sources": {
    completionActionKinds: ["service-level-sources-ready"],
    emittedActionKinds: [],
  },
  "service-levels": {
    completionActionKinds: ["service-levels-ready"],
    emittedActionKinds: [],
  },
  "supplemental-player": {
    completionActionKinds: ["supplemental-completed"],
    emittedActionKinds: [],
  },
} as const satisfies Readonly<Record<HostedCampaignEntrypoint, HostedCampaignEntrypointCapability>>);

type AssertExact<Left, Right> = [Exclude<Left, Right>, Exclude<Right, Left>] extends [never, never]
  ? true
  : never;
type MatrixActionKind = (typeof HOSTED_CAMPAIGN_ENTRYPOINT_CAPABILITY_MATRIX)[
  HostedCampaignEntrypoint
]["completionActionKinds" | "emittedActionKinds"][number];
type MatrixCompletionKind<Entrypoint extends HostedCampaignEntrypoint> =
  (typeof HOSTED_CAMPAIGN_ENTRYPOINT_CAPABILITY_MATRIX)[Entrypoint]["completionActionKinds"][number];
type DeclaredCompletionKind<Entrypoint extends HostedCampaignEntrypoint> = Extract<
  HostedCampaignExecutableCompletion,
  { readonly kind: Entrypoint }
>["action"]["kind"];

const allActionKindsAreClassified: AssertExact<MatrixActionKind, HostedCampaignActionKind> = true;
const completionKindsAreExact: {
  readonly [Entrypoint in HostedCampaignEntrypoint]: AssertExact<
    MatrixCompletionKind<Entrypoint>,
    DeclaredCompletionKind<Entrypoint>
  >;
} = {
  actor: true,
  "campaign-verifier": true,
  collector: true,
  "conversation-observer": true,
  "evidence-verifier": true,
  "greeting-ledger-observer": true,
  "historical-reply-observer": true,
  "historical-reply-preparer": true,
  "live-memory-observer": true,
  "private-coverage-observer": true,
  "remediation-bundle": true,
  "live-observer": true,
  "playback-link-observer": true,
  "provenance-probe": true,
  "recording-ready": true,
  "replay-attestation-publisher": true,
  "service-level-sources": true,
  "service-levels": true,
  "supplemental-player": true,
};
void allActionKindsAreClassified;
void completionKindsAreExact;

export function validateHostedCampaignEntrypointCapabilities(
  child: HostedCampaignExecutableSpec,
): void {
  const capability = capabilityFor(child.entrypoint);
  const completion = child.completion;
  if (completion !== undefined && (completion.kind !== child.entrypoint
    || !capability.completionActionKinds.includes(completion.action.kind))) {
    throw new Error(
      `Hosted campaign child ${child.childId} declares a completion outside ${child.entrypoint} capabilities`,
    );
  }
  for (const produced of child.produces) {
    if (!capability.emittedActionKinds.includes(produced.action.kind)
      && !isExactCompletionProduction(child, produced)) {
      throw new Error(
        `Hosted campaign entrypoint ${child.entrypoint} cannot produce ${produced.action.kind} for child ${child.childId}`,
      );
    }
  }
}

function capabilityFor(entrypoint: string): HostedCampaignEntrypointCapability {
  if (!Object.hasOwn(HOSTED_CAMPAIGN_ENTRYPOINT_CAPABILITY_MATRIX, entrypoint)) {
    throw new Error(`Unsupported hosted campaign entrypoint capability: ${entrypoint}`);
  }
  return HOSTED_CAMPAIGN_ENTRYPOINT_CAPABILITY_MATRIX[
    entrypoint as HostedCampaignEntrypoint
  ];
}

function isExactCompletionProduction(
  child: HostedCampaignExecutableSpec,
  produced: HostedCampaignProducedAction,
): boolean {
  const completion = child.completion;
  if (completion === undefined || !sameAction(produced.action, completion.action)) {
    return false;
  }
  if ("ordinal" in completion.action && "runId" in completion.action) {
    return produced.ordinal === completion.action.ordinal
      && produced.runId === completion.action.runId;
  }
  return child.startBefore.kind === "barrier"
    && produced.ordinal === child.startBefore.ordinal
    && produced.runId === child.startBefore.runId;
}

function sameAction(left: HostedCampaignBarrierAction, right: HostedCampaignBarrierAction): boolean {
  const leftRecord = left as unknown as Readonly<Record<string, unknown>>;
  const rightRecord = right as unknown as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).toSorted();
  const rightKeys = Object.keys(rightRecord).toSorted();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && leftRecord[key] === rightRecord[key]);
}
