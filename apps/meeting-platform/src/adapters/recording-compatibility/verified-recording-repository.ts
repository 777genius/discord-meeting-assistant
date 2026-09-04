import type { MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";
import { PostgresMeetingRepository } from "@discord-meeting/postgres-adapter";
import { verifyLegacyRecordingIdentity, type LegacyRecordingEvidence } from "./verified-recording-identity.js";

/** Shared read boundary for post-call processing and possession-based playback. */
export class VerifiedRecordingRepository extends PostgresMeetingRepository {
  public constructor(
    pool: ConstructorParameters<typeof PostgresMeetingRepository>[0],
    private readonly evidence: LegacyRecordingEvidence,
  ) {
    super(pool);
  }

  public override async findById(meetingId: string): Promise<MeetingSnapshot | null> {
    const stored = await super.findById(meetingId);
    return stored === null ? null : verifyLegacyRecordingIdentity(stored, this.evidence);
  }
}
