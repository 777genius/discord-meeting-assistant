import type { MeetingSourceConfigurationSnapshot } from "../domain/meeting-source-configuration.js";

export type MeetingSourceConfigurationSaveResult =
  | { readonly status: "saved" }
  | { readonly actualRevision: number; readonly status: "conflict" };

export interface MeetingSourceConfigurationRepository {
  findBySourceId(
    sourceId: string,
  ): Promise<MeetingSourceConfigurationSnapshot | null>;

  save(
    snapshot: MeetingSourceConfigurationSnapshot,
    expectedRevision: number | null,
  ): Promise<MeetingSourceConfigurationSaveResult>;
}

export interface ActiveMeetingRoom {
  readonly roomId: string;
  readonly sourceId: string;
}

/** Provider-neutral read model consumed by recording ingress adapters. */
export interface ActiveMeetingRoomReader {
  listActiveMeetingRooms(): Promise<readonly ActiveMeetingRoom[]>;
}

export type MeetingSourceSetupFailureCode =
  | "actor-not-authorized"
  | "capture-capability-unavailable"
  | "capture-room-invalid"
  | "capture-room-permission-missing"
  | "publication-target-invalid"
  | "publication-target-permission-missing"
  | "setup-publication-failed";

export interface MeetingSourceSetupFailure {
  readonly code: MeetingSourceSetupFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface MeetingSourceConfigurationVerificationRequest {
  readonly configuredByActorId: string;
  readonly publicationTargetId: string;
  readonly roomId: string;
  readonly sourceId: string;
}

export interface MeetingSourceConfigurationVerificationPort {
  verify(
    request: MeetingSourceConfigurationVerificationRequest,
  ): Promise<
    | { readonly ok: true }
    | { readonly failure: MeetingSourceSetupFailure; readonly ok: false }
  >;
}

export interface MeetingSourceSetupPublicationRequest {
  readonly configurationRevision: number;
  readonly configuredByActorId: string;
  readonly idempotencyKey: string;
  readonly publicationTargetId: string;
  readonly roomId: string;
  readonly sourceId: string;
}

export interface MeetingSourceSetupPublisher {
  publish(
    request: MeetingSourceSetupPublicationRequest,
  ): Promise<
    | { readonly ok: true }
    | { readonly failure: MeetingSourceSetupFailure; readonly ok: false }
  >;
}
