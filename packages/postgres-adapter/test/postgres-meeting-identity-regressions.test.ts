import {
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import { describe, expect, it } from "vitest";

import { sameRecordedMeetingIdentity } from "../src/meeting-replay-identity.js";
import { resolveFinalReplyAuthority } from "../src/postgres-final-reply-evidence.js";
import { evidenceBackedMeeting } from "./postgres-integration-fixtures.js";

const botId = "11111111111111111";

describe("PostgreSQL meeting identity regressions", () => {
  it("rejects a finalized-ingress replay whose producer revision changed", () => {
    const accepted = evidenceBackedMeeting("identity-replay-regression").toSnapshot();
    const changed: MeetingSnapshot = {
      ...accepted,
      identityProvenance: accepted.identityProvenance === null
        ? null
        : {
            ...accepted.identityProvenance,
            producerRevision: "fedcba9876543210fedcba9876543210fedcba98",
          },
    };

    expect(sameRecordedMeetingIdentity(accepted, changed)).toBe(false);
  });

  it("restores publication authority with its original target identity", () => {
    const targetId = "22222222222222222";
    const meeting = evidenceBackedMeeting(
      "publication-identity-regression",
      targetId,
    );
    const projectionEpoch = meeting.publicationIdempotencyKey();
    const receipt =
      `discord:v2:channel:${targetId}:message:33333333333333333`;
    meeting.beginPublication();
    meeting.completePublication({
      externalPublicationId: receipt,
      idempotencyKey: projectionEpoch,
      publisherIdentity: botId,
    });

    const restored = Meeting.restore(meeting.toSnapshot()).toSnapshot();
    const authority = resolveFinalReplyAuthority(
      restored,
      botId,
    );

    expect(restored.publicationTargetId).toBe(targetId);
    expect(restored.publication).toEqual({
      externalPublicationId: receipt,
      idempotencyKey: projectionEpoch,
      publisherIdentity: botId,
    });
    expect(authority?.binding).toMatchObject({
      finalProjectionEpoch: projectionEpoch,
      finalProjectionReceipt: receipt,
      projectionTargetContainerId: targetId,
    });
  });
});
