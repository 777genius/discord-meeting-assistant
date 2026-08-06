import {
  createExternalPublicationId,
  createPublicationTargetId,
  PublishingInvariantError,
  type ExternalPublicationId,
  type PublicationTargetId,
} from "../../publishing/index.js";

import { DomainInvariantError, requireNonEmpty } from "./errors.js";

declare const meetingIdentifierBrand: unique symbol;

export type MeetingId = string & {
  readonly [meetingIdentifierBrand]: "MeetingId";
};

export const createMeetingId = (value: string): MeetingId =>
  requireNonEmpty(value, "meetingId") as MeetingId;

function translatePublishingIdentifier<Value>(create: () => Value): Value {
  try {
    return create();
  } catch (error) {
    if (error instanceof PublishingInvariantError) {
      throw new DomainInvariantError("EMPTY_VALUE", error.message);
    }
    throw error;
  }
}

export const createMeetingExternalPublicationId = (
  value: string,
): ExternalPublicationId =>
  translatePublishingIdentifier(() => createExternalPublicationId(value));

export const createMeetingPublicationTargetId = (
  value: string,
): PublicationTargetId =>
  translatePublishingIdentifier(() => createPublicationTargetId(value));
