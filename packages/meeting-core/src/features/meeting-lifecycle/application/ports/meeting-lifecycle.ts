import type { MeetingSnapshot } from "../../domain/meeting-snapshot.js";

/** Persistence boundary owned by the authoritative meeting lifecycle. */
export interface MeetingRepository {
  findById(meetingId: string): Promise<MeetingSnapshot | null>;

  save(snapshot: MeetingSnapshot, expectedRevision: number): Promise<void>;
}
