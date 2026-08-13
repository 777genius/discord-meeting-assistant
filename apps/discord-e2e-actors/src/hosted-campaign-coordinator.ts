import {
  type HostedFiniteProcessCompletion,
} from "./hosted-finite-process-contract.js";
export { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";
import type { HostedCampaignTarget } from "./hosted-campaign-target.js";
export type CampaignScenario = "sequential" | "overlap" | "reconnect";
export interface HostedCampaignRun {
  readonly campaignId: string; readonly ordinal: number;
  readonly retainedCaptureCount: number;
  readonly runId: string;
  readonly scenario: CampaignScenario;
}
export interface HostedCampaignThresholds {
  readonly answerFirstPacketMilliseconds: number;
}
export type HostedCampaignEntrypoint =
  | "actor"
  | "campaign-verifier"
  | "collector"
  | "conversation-observer"
  | "live-observer"
  | "playback-link-observer"
  | "provenance-probe"
  | "recording-ready"
  | "replay-attestation-publisher"
  | "service-level-sources"
  | "service-levels"
  | "supplemental-player"
  | "evidence-verifier";
export interface HostedCampaignActionReference {
  readonly action: HostedCampaignBarrierAction;
  readonly ordinal: number;
  readonly runId: string;
}
export type HostedCampaignStartPoint =
  | { readonly kind: "campaign" }
  | HostedCampaignActionReference & { readonly kind: "barrier" };
export interface HostedCampaignProducedAction extends HostedCampaignActionReference {
  readonly outputPath: string;
}
export type HostedCampaignBoundEnvironmentName =
  | "DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID"
  | "DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID"
  | "DISCORD_E2E_PLAYBACK_LINK_MEETING_ID"
  | "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID"
  | "DISCORD_E2E_RECORDING_ID"
  | "DISCORD_E2E_REPLAY_RECORDING_ID"
  | "DISCORD_E2E_SLA_MEETING_ID"
  | "DISCORD_E2E_SLA_RECORDING_ID";
interface HostedCampaignEnvironmentBinding {
  readonly name: HostedCampaignBoundEnvironmentName;
  readonly valueFrom: {
    readonly actionRef: HostedCampaignActionReference;
    readonly field: "meetingId" | "recordingId";
  };
}
export type HostedCampaignCompletionAction =
  | { readonly kind: "actor-completed"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "conversation-observer-completed"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "playback-link-seen"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "recording-ready"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "replay-attestation-ready"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "supplemental-completed"; readonly ordinal: number; readonly runId: string };
type HostedCampaignExecutableArguments =
  | { readonly kind: "environment" }
  | { readonly evidencePath: string; readonly kind: "evidence-verifier"; readonly manifestPath: string; readonly thresholdsPath?: string }
  | { readonly evidencePaths: readonly [string, string, string]; readonly kind: "campaign-verifier"; readonly manifestPath: string; readonly thresholdsPath?: string };
export type HostedCampaignExecutableCompletion =
  | HostedFiniteProcessCompletion
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "service-level-sources-ready" }>;
      readonly campaignId: string;
      readonly clockAttestationsPath: string;
      readonly databasePath: string;
      readonly kind: "service-level-sources";
      readonly meetingId?: string;
      readonly meetingPlatformLogsPath: string;
      readonly recordingId?: string;
      readonly reportPath: string;
      readonly runId: string;
      readonly s3Path: string;
    }
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "service-levels-ready" }>;
      readonly campaignId: string;
      readonly kind: "service-levels";
      readonly meetingId?: string;
      readonly outputPath: string;
      readonly recordingId?: string;
      readonly reportPath: string;
      readonly runId: string;
    }
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "provenance-before" | "provenance-after" }>;
      readonly campaignId: string;
      readonly kind: "provenance-probe";
      readonly phase: "after" | "before";
      readonly runIds: readonly [string, string, string];
      readonly snapshotPath: string;
    }
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }>;
      readonly evidencePath: string;
      readonly kind: "collector";
      readonly runId: string;
    }
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }>;
      readonly kind: "evidence-verifier";
    }
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "campaign-verified" }>;
      readonly campaignId: string;
      readonly kind: "campaign-verifier";
      readonly runIds: readonly [string, string, string];
    };
export interface HostedCampaignExecutableSpec {
  readonly arguments: HostedCampaignExecutableArguments;
  readonly childId: string;
  readonly completion?: HostedCampaignExecutableCompletion;
  readonly completionAfter?: HostedCampaignActionReference;
  readonly entrypoint: HostedCampaignEntrypoint;
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentBindings?: readonly HostedCampaignEnvironmentBinding[];
  readonly produces: readonly HostedCampaignProducedAction[];
  readonly requires: readonly HostedCampaignActionReference[];
  readonly startBefore: HostedCampaignStartPoint;
  readonly supplementalGates?: {
    readonly connection: { readonly armedPath: string; readonly path: string; readonly trigger: HostedCampaignActionReference };
    readonly playback: { readonly armedPath: string; readonly path: string; readonly trigger: HostedCampaignActionReference };
  };
  readonly actorGates?: {
    readonly speakerB: { readonly armedPath: string; readonly path: string; readonly trigger: HostedCampaignActionReference };
    readonly playback: { readonly armedPath: string; readonly path: string; readonly trigger: HostedCampaignActionReference };
    readonly end: { readonly armedPath: string; readonly path: string; readonly trigger: HostedCampaignActionReference };
  };
  readonly releaseGate?: {
    readonly armedPath?: string;
    readonly action: HostedCampaignBarrierAction;
    readonly ordinal: number;
    readonly path: string;
    readonly runId: string;
  };
}
declare const childHandleBrand: unique symbol;
export interface HostedCampaignChildHandle {
  readonly childId: string;
  readonly [childHandleBrand]: true;
}
declare const campaignLeaseHandleBrand: unique symbol;
export interface HostedCampaignLeaseHandle {
  readonly campaignId: string;
  readonly [campaignLeaseHandleBrand]: true;
}
export type HostedCampaignBarrierAction =
  | { readonly kind: "provenance-before" }
  | { readonly kind: "observer-subscribed" }
  | { readonly kind: "capture-retained"; readonly ordinal: number }
  | { readonly kind: "reconnect-left" }
  | { readonly kind: "reconnect-ready" }
  | { readonly kind: "actor-scenario-playback-completed" }
  | { readonly kind: "answer-intent" }
  | { readonly kind: "answer-observer-ready" }
  | { readonly kind: "answer-first-packet" }
  | { readonly kind: "service-level-sources-ready" }
  | { readonly kind: "service-levels-ready" }
  | { readonly kind: "run-verified"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "provenance-after" }
  | { readonly kind: "campaign-verified" }
  | HostedCampaignCompletionAction;
interface DigestEvidence { readonly digestSha256: string }
interface TurnEvidence { readonly observedAtEpochMilliseconds: number; readonly turnId: string }
export type HostedCampaignActionEvidence<Action extends HostedCampaignBarrierAction> =
  Action["kind"] extends "provenance-before" | "provenance-after" ? DigestEvidence
    : Action["kind"] extends "observer-subscribed" ? { readonly authenticatedObserverBotId: string }
      : Action["kind"] extends "capture-retained" ? {
          readonly ordinal: number; readonly outputPath: string; readonly retained: true;
        }
          : Action["kind"] extends "reconnect-left" | "reconnect-ready" ? {
            readonly participantId: string; readonly observedAtEpochMilliseconds: number;
          } : Action["kind"] extends "actor-scenario-playback-completed" ? { readonly completed: true }
          : Action["kind"] extends "answer-first-packet" ? TurnEvidence & {
              readonly answerLatencyMilliseconds: number;
            }
            : Action["kind"] extends "service-levels-ready" ? {
                readonly measurementCount: 3;
                readonly outputPath: string;
                readonly recordingId: string;
                readonly runId: string;
              }
            : Action["kind"] extends "service-level-sources-ready" ? {
                readonly outputPath: string; readonly runId: string; readonly sourcesReady: true;
              }
            : Action["kind"] extends "answer-intent" | "answer-observer-ready" ? TurnEvidence
              : Action["kind"] extends "run-verified" ? {
                  readonly ordinal: number; readonly runId: string; readonly verified: true;
                }
                : Action extends HostedCampaignCompletionAction ? {
                    readonly completed: true; readonly ordinal: number; readonly runId: string;
                  } & (Action["kind"] extends "recording-ready" ? {
                    readonly meetingId: string; readonly recordingId: string;
                  } : Record<never, never>)
                  : { readonly campaignId: string };
export interface HostedCampaignBoundedSignal {
  readonly deadlineEpochMilliseconds: number; readonly signal: AbortSignal;
}
interface HostedCampaignLaunchAuthorization {
  /** Synchronous fence invoked immediately before the first child spawn. */
  assertReadyForFirstChild(): void;
}
export interface HostedCampaignRuntimeAuthorization {
  /** Invoked only after the exact campaign lease has been acquired. */
  authorizeAfterLease(): Promise<HostedCampaignLaunchAuthorization>;
}
export interface HostedCampaignPorts {
  acquireCampaignLease(
    campaignId: string,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignLeaseHandle>;
  awaitBarrier<Action extends HostedCampaignBarrierAction>(
    action: Action,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignActionEvidence<Action>>;
  awaitChildCompletion(
    handle: HostedCampaignChildHandle,
    executable: HostedCampaignExecutableSpec,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<void>;
  startChild(
    executable: HostedCampaignExecutableSpec,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignChildHandle>;
  publishReleaseGate(
    executable: HostedCampaignExecutableSpec,
    phaseOrBounded: "connection" | "speaker-b" | "playback" | "end" | HostedCampaignBoundedSignal,
    bounded?: HostedCampaignBoundedSignal,
  ): Promise<void>;
  publishSupplementalGate(
    executable: HostedCampaignExecutableSpec,
    phase: "connection" | "playback",
    bounded: HostedCampaignBoundedSignal,
  ): Promise<void>;
  releaseCampaignLease(handle: HostedCampaignLeaseHandle): Promise<void>;
  stopChild(handle: HostedCampaignChildHandle): Promise<void>;
}
export interface HostedCampaignInput {
  readonly children: readonly HostedCampaignExecutableSpec[]; readonly runs: readonly HostedCampaignRun[];
  readonly target: HostedCampaignTarget;
  readonly thresholds: HostedCampaignThresholds;
}
export interface HostedCampaignPassReceipt {
  readonly actionEvidence: readonly unknown[]; readonly campaignId: string;
  readonly runIds: readonly [string, string, string];
  readonly schemaVersion: 1; readonly teardownComplete: true;
}
export { validateHostedCampaign } from "./hosted-campaign-validation.js";
export { runHostedCampaign } from "./hosted-campaign-runtime.js";
