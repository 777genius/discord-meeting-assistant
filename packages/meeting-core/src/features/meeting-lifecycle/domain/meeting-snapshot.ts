import type { EvidenceBackedSummarySnapshot } from "../../meeting-intelligence/index.js";
import type { PublicationReceiptSnapshot } from "../../publishing/index.js";
import type { RecordingArtifactSnapshot } from "../../recording/index.js";
import type { FinalTranscriptSnapshot } from "../../transcription/index.js";
import type { MeetingActorSnapshot, MeetingSourceSnapshot } from "./meeting-identity.js";
import type { StageStateSnapshot } from "./meeting-stage.js";

export interface MeetingSnapshot {
  readonly actors: readonly MeetingActorSnapshot[] | null;
  readonly meetingId: string;
  readonly publication: PublicationReceiptSnapshot | null;
  readonly publicationStage: StageStateSnapshot;
  readonly publicationTargetId: string;
  readonly recording: RecordingArtifactSnapshot;
  readonly revision: number;
  readonly summary: EvidenceBackedSummarySnapshot | null;
  readonly summaryStage: StageStateSnapshot;
  readonly source: MeetingSourceSnapshot | null;
  readonly transcript: FinalTranscriptSnapshot | null;
  readonly transcriptionStage: StageStateSnapshot;
}

export interface RecordedMeetingInput {
  readonly actors: readonly MeetingActorSnapshot[];
  readonly meetingId: string;
  readonly publicationTargetId: string;
  readonly recording: RecordingArtifactSnapshot;
  readonly source: MeetingSourceSnapshot;
}

export interface LegacyRecordedMeetingInput {
  readonly meetingId: string;
  readonly publicationTargetId: string;
  readonly recording: RecordingArtifactSnapshot;
  readonly source?: MeetingSourceSnapshot | null;
}

export type RestorableMeetingSnapshot = Omit<MeetingSnapshot, "actors" | "source"> & {
  readonly actors?: readonly MeetingActorSnapshot[] | null;
  readonly source?: MeetingSourceSnapshot | null;
};

export function initialMeetingSnapshot(
  input: LegacyRecordedMeetingInput,
  actors: readonly MeetingActorSnapshot[] | null,
): RestorableMeetingSnapshot {
  return {
    actors,
    meetingId: input.meetingId,
    publication: null,
    publicationStage: { attempts: 0, status: "pending" },
    publicationTargetId: input.publicationTargetId,
    recording: input.recording,
    revision: 0,
    source: input.source ?? null,
    summary: null,
    summaryStage: { attempts: 0, status: "pending" },
    transcript: null,
    transcriptionStage: { attempts: 0, status: "pending" },
  };
}
