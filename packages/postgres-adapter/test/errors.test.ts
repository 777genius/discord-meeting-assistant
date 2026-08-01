import { describe, expect, it } from "vitest";

import { MeetingPersistenceConflictError } from "../src/index.js";

describe("MeetingPersistenceConflictError", () => {
  it("keeps machine-readable compare-and-swap context", () => {
    const error = new MeetingPersistenceConflictError({
      actualRevision: 7,
      attemptedRevision: 8,
      expectedRevision: 6,
      kind: "revision-mismatch",
      meetingId: "meeting-conflict",
    });

    expect(error).toMatchObject({
      code: "MEETING_PERSISTENCE_CONFLICT",
      conflict: {
        actualRevision: 7,
        attemptedRevision: 8,
        expectedRevision: 6,
        kind: "revision-mismatch",
        meetingId: "meeting-conflict",
      },
      message:
        "meeting meeting-conflict revision conflict: expected 6, actual 7",
      name: "MeetingPersistenceConflictError",
    });
  });
});
