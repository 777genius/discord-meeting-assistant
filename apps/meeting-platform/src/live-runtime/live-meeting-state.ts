import { canonicalLiveCaptionSignature } from "./caption-signature.js";
import { ConversationBridge } from "./conversation-bridge.js";
import type {
  LiveMeetingRuntimeDependencies,
  LiveMeetingStartedEvent,
  LiveRuntimeClock,
  LiveRuntimeTimer,
  LiveTranscriptionEvent,
} from "./contracts.js";
import type {
  LiveSessionAdmission,
  GlobalPacketFlowControl,
  ResolvedLivePacketFlowControl,
} from "./live-packet-flow-control.js";
import { LiveProjectionScheduler } from "./live-projection-scheduler.js";
import { defaultLivePacketInspector } from "./opus-packet-inspector.js";
import { LiveSummaryScheduler } from "./live-summary-scheduler.js";
import { SpeakerTranscriptionSessions } from "./speaker-transcription-sessions.js";

export interface ActiveLiveMeeting {
  readonly conversation: ConversationBridge | undefined;
  domainChain: Promise<void>;
  finalizationStarted: boolean;
  finishPromise: Promise<void> | null;
  finishing: boolean;
  readonly meetingId: string;
  readonly projection: LiveProjectionScheduler;
  refreshQueued: boolean;
  readonly startedAtMs: number;
  readonly summary: LiveSummaryScheduler;
  terminalCommitted: boolean;
  readonly transcription: SpeakerTranscriptionSessions;
  transcriptionFenceClosed: boolean;
}

export interface CreateActiveLiveMeetingInput {
  readonly clock: LiveRuntimeClock;
  readonly dependencies: LiveMeetingRuntimeDependencies;
  readonly event: LiveMeetingStartedEvent;
  readonly onTranscript: (
    state: ActiveLiveMeeting,
    event: LiveTranscriptionEvent,
  ) => void;
  readonly packetFlow: ResolvedLivePacketFlowControl;
  readonly packetAdmission: GlobalPacketFlowControl;
  readonly sessionAdmission: LiveSessionAdmission;
  readonly speakerIdleFinalizeMs: number;
  readonly startedAtMs: number;
  readonly timer: LiveRuntimeTimer;
}

/** Builds only meeting-local collaborators; lifecycle ordering stays in the runtime. */
export function createActiveLiveMeeting(input: CreateActiveLiveMeetingInput): ActiveLiveMeeting {
  let state!: ActiveLiveMeeting;
  const meetingId = input.event.recordingId;
  const projection = new LiveProjectionScheduler({
    captionSignature: input.dependencies.captionSignature ?? canonicalLiveCaptionSignature,
    clock: input.clock,
    logger: input.dependencies.logger,
    meetingId,
    refreshMeeting: input.dependencies.refreshMeeting,
    startedAtMs: input.startedAtMs,
  });
  const summary = new LiveSummaryScheduler({
    clock: input.clock,
    logger: input.dependencies.logger,
    meetingId,
    refreshMeeting: input.dependencies.refreshMeeting,
  });
  const conversation = input.dependencies.conversation === undefined
    ? undefined
    : new ConversationBridge({
        configuration: input.dependencies.conversation,
        logger: input.dependencies.logger,
        meetingId,
        meetingStartedAtMs: input.startedAtMs,
      });
  const transcription = new SpeakerTranscriptionSessions({
    clock: input.clock,
    isMeetingFinishing: () => state.finishing,
    logger: input.dependencies.logger,
    maximumQueuedPackets: input.packetFlow.maximumQueuedPacketsPerSpeaker,
    packetAdmission: input.packetAdmission,
    meetingId,
    onTranscript: (event) => {
      input.onTranscript(state, event);
    },
    packetBackpressureTimeoutMs: input.packetFlow.packetBackpressureTimeoutMs,
    packetInspector: input.dependencies.packetInspector ?? defaultLivePacketInspector,
    sessionAdmission: input.sessionAdmission,
    speakerIdleFinalizeMs: input.speakerIdleFinalizeMs,
    startedAtMs: input.startedAtMs,
    timer: input.timer,
    transcriber: input.dependencies.transcriber,
  });
  state = {
    conversation,
    domainChain: Promise.resolve(),
    finalizationStarted: false,
    finishPromise: null,
    finishing: false,
    meetingId,
    projection,
    refreshQueued: false,
    startedAtMs: input.startedAtMs,
    summary,
    terminalCommitted: false,
    transcription,
    transcriptionFenceClosed: false,
  };
  return state;
}
