import { expect, it } from "vitest";

import {
  FinishLiveMeeting,
  LiveMeeting,
  StartLiveMeeting,
  type LiveMeetingSnapshot,
} from "@discord-meeting/meeting-core/live-meeting";
import { MemoryLiveMeetingRepository } from "./live-meeting-fixtures.js";

it("persists the authenticated projection publisher and rejects bot rotation", () => {
  const meeting = LiveMeeting.start({
    meetingId: "meeting-projection-owner",
    publicationTargetId: "results-channel",
    startedAtMs: 0,
  });
  meeting.completeProjection("message-1", meeting.revision, "bot-application-1");

  expect(meeting.toSnapshot().projectionPublisherIdentity).toBe("bot-application-1");
  expect(() => meeting.completeProjection(
    "message-1",
    meeting.revision,
    "bot-application-2",
  )).toThrow(/cannot change the authenticated live projection publisher/u);
});

it("reconciles a contested live-meeting start through the bounded CAS path", async () => {
  const meetings = new ConflictOnceStartRepository();

  await expect(new StartLiveMeeting({ meetings }).execute({
    meetingId: "meeting-start-race",
    publicationTargetId: "results-channel",
    startedAtMs: 0,
  })).resolves.toMatchObject({ lifecycleStatus: "active", status: "started" });

  expect(meetings.conflicts).toBe(1);
  expect(meetings.snapshot).toMatchObject({ status: "active" });
});

it("reuses lifecycle state and timeline from one atomic read", async () => {
  const meetings = new AtomicReadRepository();
  const startMeeting = new StartLiveMeeting({ meetings });
  const input = {
    meetingId: "meeting-atomic-read",
    publicationTargetId: "results-channel",
    startedAtMs: 0,
  } as const;

  await startMeeting.execute(input);
  await expect(startMeeting.execute(input)).resolves.toMatchObject({ status: "reused" });

  expect(meetings.atomicReads).toBe(2);
  expect(meetings.directReads).toBe(0);
});

it("reconciles a terminal CAS conflict before releasing the durable finish", async () => {
  const meetings = new ConflictThenFinishRepository(1);
  await start(meetings, "meeting-finish-race");

  await expect(new FinishLiveMeeting(meetings).execute("meeting-finish-race", 1_000))
    .resolves.toBe("ended");

  expect(meetings.conflicts).toBe(1);
  expect(meetings.snapshot).toMatchObject({ endedAtMs: 1_000, status: "ended" });
});

it("reuses the persisted terminal timestamp when finish is replayed later", async () => {
  const meetings = new CountingSaveRepository();
  await start(meetings, "meeting-finish-replay");
  const finish = new FinishLiveMeeting(meetings);

  await expect(finish.execute("meeting-finish-replay", 1_000)).resolves.toBe("ended");
  const saveCallsAfterFirstFinish = meetings.saveCalls;
  await expect(finish.execute("meeting-finish-replay", 2_000)).resolves.toBe("reused");

  expect(meetings.saveCalls).toBe(saveCallsAfterFirstFinish);
  expect(meetings.snapshot).toMatchObject({ endedAtMs: 1_000, status: "ended" });
});

it("fails after the bounded terminal CAS reconciliation budget", async () => {
  const meetings = new ConflictThenFinishRepository(Number.POSITIVE_INFINITY);
  await start(meetings, "meeting-finish-conflict");

  await expect(new FinishLiveMeeting(meetings).execute("meeting-finish-conflict", 1_000))
    .rejects.toMatchObject({ code: "MEETING_PERSISTENCE_CONFLICT" });

  expect(meetings.conflicts).toBe(3);
  expect(meetings.snapshot).toMatchObject({ status: "active" });
});

async function start(
  meetings: MemoryLiveMeetingRepository,
  meetingId: string,
): Promise<void> {
  await new StartLiveMeeting({ meetings }).execute({
    meetingId,
    publicationTargetId: "results-channel",
    startedAtMs: 0,
  });
}

class ConflictOnceStartRepository extends MemoryLiveMeetingRepository {
  public conflicts = 0;

  public override async save(
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number | null,
  ): Promise<void> {
    if (expectedRevision === null && this.conflicts === 0) {
      this.conflicts += 1;
      throw persistenceConflict();
    }
    await super.save(snapshot, expectedRevision);
  }
}

class CountingSaveRepository extends MemoryLiveMeetingRepository {
  public saveCalls = 0;

  public override async save(
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number | null,
  ): Promise<void> {
    this.saveCalls += 1;
    await super.save(snapshot, expectedRevision);
  }
}

class ConflictThenFinishRepository extends MemoryLiveMeetingRepository {
  public conflicts = 0;

  public constructor(private remainingConflicts: number) {
    super();
  }

  public override async save(
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number | null,
  ): Promise<void> {
    if (expectedRevision !== null && this.remainingConflicts > 0) {
      this.remainingConflicts -= 1;
      this.conflicts += 1;
      if (this.snapshot === null) {
        throw new Error("live meeting disappeared during test conflict");
      }
      this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
      throw persistenceConflict();
    }
    await super.save(snapshot, expectedRevision);
  }
}

class AtomicReadRepository extends MemoryLiveMeetingRepository {
  public atomicReads = 0;
  public directReads = 0;

  public override findById(meetingId: string): Promise<LiveMeetingSnapshot | null> {
    this.directReads += 1;
    return super.findById(meetingId);
  }

  public override readSnapshotAndTimeline(
    meetingId: string,
  ): ReturnType<MemoryLiveMeetingRepository["readSnapshotAndTimeline"]> {
    this.atomicReads += 1;
    return super.readSnapshotAndTimeline(meetingId);
  }
}

function persistenceConflict(): Error & { readonly code: "MEETING_PERSISTENCE_CONFLICT" } {
  return Object.assign(new Error("simulated revision conflict"), {
    code: "MEETING_PERSISTENCE_CONFLICT" as const,
  });
}
