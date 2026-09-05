import type { MeetingRepository } from "@discord-meeting/meeting-core/meeting-lifecycle";

import type {
  RecordingPlaybackCatalog,
  RecordingPlaybackSnapshot,
} from "../application/recording-playback.js";

export class PostgresRecordingPlaybackCatalog implements RecordingPlaybackCatalog {
  public constructor(
    private readonly meetings: Pick<MeetingRepository, "findById">,
  ) {}

  public async findByMeetingId(meetingId: string): Promise<RecordingPlaybackSnapshot> {
    const meeting = await this.meetings.findById(meetingId);
    if (meeting === null) {
      return { status: "unavailable", tracks: [] };
    }
    if (
      meeting.recording.speakerAudio.length > 0 &&
      meeting.recording.speakerAudio.every((track) =>
        track.artifactRevision !== undefined &&
        track.checksumSha256 !== undefined &&
        track.sizeBytes !== undefined)
    ) {
      return {
        status: "ready",
        tracks: meeting.recording.speakerAudio.map((track) => ({
          artifactRevision: track.artifactRevision as string,
          audioLocator: track.audioLocator,
          checksumSha256: track.checksumSha256 as string,
          sizeBytes: track.sizeBytes as number,
          timelineOffsetMs: track.timelineOffsetMs,
        })),
      };
    }
    return {
      status: ["pending", "running"].includes(meeting.transcriptionStage.status)
        ? "processing"
        : "unavailable",
      tracks: [],
    };
  }
}
