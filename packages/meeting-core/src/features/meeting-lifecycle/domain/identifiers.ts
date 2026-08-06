import { requireNonEmpty } from "./errors.js";

declare const meetingIdentifierBrand: unique symbol;

export type MeetingId = string & {
  readonly [meetingIdentifierBrand]: "MeetingId";
};

export const createMeetingId = (value: string): MeetingId =>
  requireNonEmpty(value, "meetingId") as MeetingId;
