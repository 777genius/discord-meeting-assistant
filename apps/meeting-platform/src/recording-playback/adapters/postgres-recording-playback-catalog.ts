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
    if (meeting.recording.speakerAudio.length > 0) {
      return {
        status: "ready",
        tracks: meeting.recording.speakerAudio.map((track) => ({
          audioLocator: track.audioLocator,
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
