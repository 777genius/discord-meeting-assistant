import {
  decodeHistoricalIndexPlanV1,
  validateHistoricalReleaseBinding,
  type HistoricalAppliedPlanV1,
  type HistoricalReleaseBindingV1,
  type HistoricalSyncLeaseV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

export interface HistoricalSyncRow {
  readonly applied_index_profile_id: string | null;
  readonly accepted_meeting_revision: number;
  readonly attempt_count: number;
  readonly desired_generation: number;
  readonly evidence_policy_version: string;
  readonly lease_fence: number;
  readonly meeting_id: string;
  readonly operation: "delete_meeting" | "delete_release" | "index";
  readonly plan: unknown;
  readonly profile_rebuild_requested: boolean;
  readonly release_id: string;
  readonly remote_document_ids: unknown;
  readonly room_id: string;
  readonly schema_version: number;
  readonly scope_id: string;
  readonly transcript_id: string;
  readonly transcript_version: number;
}

export const historicalSyncRowProjection = `
  release_id, meeting_id, schema_version::float8 AS schema_version,
  accepted_meeting_revision::float8 AS accepted_meeting_revision,
  desired_generation::float8 AS desired_generation,
  transcript_id, transcript_version::float8 AS transcript_version,
  evidence_policy_version, scope_id, room_id, operation,
  attempt_count::float8 AS attempt_count,
  lease_fence::float8 AS lease_fence, plan, remote_document_ids,
  applied_index_profile_id, profile_rebuild_requested
`;

export function historicalBindingsEqual(
  left: HistoricalReleaseBindingV1,
  right: HistoricalReleaseBindingV1,
): boolean {
  return left.acceptedMeetingRevision === right.acceptedMeetingRevision &&
    left.desiredGeneration === right.desiredGeneration &&
    left.meetingId === right.meetingId &&
    left.releaseId === right.releaseId &&
    left.roomId === right.roomId &&
    left.scopeId === right.scopeId &&
    left.transcriptId === right.transcriptId &&
    left.transcriptVersion === right.transcriptVersion;
}

export function historicalBindingFromRow(
  row: HistoricalSyncRow,
): HistoricalReleaseBindingV1 {
  const binding = validateHistoricalReleaseBinding({
    acceptedMeetingRevision: row.accepted_meeting_revision,
    desiredGeneration: row.desired_generation,
    evidencePolicyVersion: row.evidence_policy_version,
    meetingId: row.meeting_id,
    releaseId: row.release_id,
    roomId: row.room_id,
    schemaVersion: row.schema_version,
    scopeId: row.scope_id,
    transcriptId: row.transcript_id,
    transcriptVersion: row.transcript_version,
  });
  if (binding.releaseId !== row.release_id) {
    throw new Error("stored historical release identity is corrupt");
  }
  return binding;
}

function remoteIds(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stored historical remote document identities are corrupt");
  }
  const entries = Object.entries(value);
  if (entries.some(([key, item]) =>
    key.length === 0 || typeof item !== "string" || item.length === 0
  )) {
    throw new Error("stored historical remote document identity is invalid");
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

export function historicalLeaseFromRow(
  row: HistoricalSyncRow,
): HistoricalSyncLeaseV1 {
  const binding = historicalBindingFromRow(row);
  const plan = row.plan === null ? null : decodeHistoricalIndexPlanV1(row.plan);
  if (plan !== null && !historicalBindingsEqual(plan.binding, binding)) {
    throw new Error("stored historical index plan conflicts with its release binding");
  }
  return Object.freeze({
    appliedIndexProfileId: row.applied_index_profile_id,
    attempt: row.attempt_count,
    binding,
    fence: row.lease_fence,
    operation: row.operation,
    plan,
    profileRebuildRequired: row.profile_rebuild_requested,
    remoteDocumentIds: remoteIds(row.remote_document_ids),
  });
}

export function historicalAppliedFromRow(
  row: HistoricalSyncRow,
): HistoricalAppliedPlanV1 {
  if (row.plan === null) {
    throw new Error("applied historical release has no index plan");
  }
  const binding = historicalBindingFromRow(row);
  const plan = decodeHistoricalIndexPlanV1(row.plan);
  if (!historicalBindingsEqual(plan.binding, binding)) {
    throw new Error("stored applied historical plan conflicts with its release binding");
  }
  return Object.freeze({
    binding,
    plan,
    remoteDocumentIds: remoteIds(row.remote_document_ids),
  });
}
