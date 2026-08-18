import {
  DomainInvariantError,
  requireNonEmpty,
  requireNonNegativeInteger,
} from "./errors.js";
import {
  createMeetingId,
  type MeetingId,
} from "../../meeting-lifecycle/index.js";
import {
  createExternalPublicationId,
  createPublicationTargetId,
  type ExternalPublicationId,
  type PublicationTargetId,
} from "../../publishing/index.js";
import { normalizeLiveSummary, type LiveSummaryDraftSnapshot } from "./live-summary.js";
import {
  TranscriptTurn,
  type TranscriptTurnSnapshot,
} from "../../transcription/index.js";

export type LiveMeetingStatus = "active" | "ended";

/**
 * Compact CAS-owned business state. Finalized turns and provider telemetry are
 * intentionally absent: both are append-only records owned by dedicated ports.
 */
export interface LiveMeetingSnapshot {
  readonly draftSummary: LiveSummaryDraftSnapshot | null;
  readonly endedAtMs: number | null;
  readonly meetingId: string;
  readonly projectedRevision: number;
  readonly projectionExternalId: string | null;
  /** Opaque authenticated identity that last wrote the projection. */
  readonly projectionPublisherIdentity?: string | null;
  readonly publicationTargetId: string;
  readonly revision: number;
  readonly startedAtMs: number;
  readonly status: LiveMeetingStatus;
  readonly summaryGeneratedAtMs: number | null;
}

export interface StartLiveMeetingInput {
  readonly meetingId: string;
  readonly publicationTargetId: string;
  readonly startedAtMs: number;
}

function requireLiveMeetingStatus(value: unknown): LiveMeetingStatus {
  if (value !== "active" && value !== "ended") {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "live meeting status is invalid");
  }
  return value;
}

function restoreSummary(
  snapshot: LiveMeetingSnapshot,
): LiveSummaryDraftSnapshot | null {
  if (snapshot.draftSummary === null) {
    return null;
  }
  // Evidence membership is checked when a generated summary is accepted with
  // its exact append-only timeline. At restoration time this compact aggregate
  // deliberately has no transcript array to scan.
  return normalizeLiveSummary(snapshot.draftSummary, undefined, snapshot.draftSummary.revision);
}

function isPublisherRotation(input: {
  readonly currentPublisherIdentity: string | null;
  readonly hasExistingProjection: boolean;
  readonly nextPublisherIdentity: string;
  readonly receiptRotated: boolean;
}): boolean {
  const knownPublisherRotated = input.currentPublisherIdentity !== null &&
    input.currentPublisherIdentity.length > 0 &&
    input.currentPublisherIdentity !== input.nextPublisherIdentity;
  const legacyPublisherRotated = input.hasExistingProjection &&
    input.currentPublisherIdentity === null &&
    input.nextPublisherIdentity.length > 0 &&
    input.receiptRotated;
  return knownPublisherRotated || legacyPublisherRotated;
}

function normalizeProjectionPublisherIdentity(
  publisherIdentity: string | undefined,
  currentPublisherIdentity: string | null,
): string {
  if (publisherIdentity !== undefined) {
    return requireNonEmpty(publisherIdentity, "projection.publisherIdentity");
  }
  if (currentPublisherIdentity !== null) {
    throw new DomainInvariantError(
      "CONFLICTING_COMPLETION",
      "publisher identity cannot be omitted after ownership is established",
    );
  }
  return "";
}

export class LiveMeeting {
  public readonly meetingId: MeetingId;
  public readonly publicationTargetId: PublicationTargetId;
  public readonly startedAtMs: number;

  private currentRevision: number;
  private currentStatus: LiveMeetingStatus;
  private endedTimestampMs: number | null;
  private summaryDraft: LiveSummaryDraftSnapshot | null;
  private summaryTimestampMs: number | null;
  private externalProjectionId: ExternalPublicationId | null;
  private projectionPublisherIdentity: string | null;
  private lastProjectedRevision: number;

  private constructor(snapshot: LiveMeetingSnapshot) {
    this.meetingId = createMeetingId(snapshot.meetingId);
    this.publicationTargetId = createPublicationTargetId(snapshot.publicationTargetId);
    this.startedAtMs = requireNonNegativeInteger(snapshot.startedAtMs, "liveMeeting.startedAtMs");
    this.currentRevision = requireNonNegativeInteger(snapshot.revision, "liveMeeting.revision");
    this.currentStatus = requireLiveMeetingStatus(snapshot.status);
    this.endedTimestampMs = snapshot.endedAtMs === null
      ? null
      : requireNonNegativeInteger(snapshot.endedAtMs, "liveMeeting.endedAtMs");
    this.summaryDraft = restoreSummary(snapshot);
    this.summaryTimestampMs = snapshot.summaryGeneratedAtMs === null
      ? null
      : requireNonNegativeInteger(
          snapshot.summaryGeneratedAtMs,
          "liveMeeting.summaryGeneratedAtMs",
        );
    this.externalProjectionId = snapshot.projectionExternalId === null
      ? null
      : createExternalPublicationId(snapshot.projectionExternalId);
    this.projectionPublisherIdentity = snapshot.projectionPublisherIdentity === null ||
        snapshot.projectionPublisherIdentity === undefined ||
        snapshot.projectionPublisherIdentity.length === 0
      ? null
      : requireNonEmpty(
          snapshot.projectionPublisherIdentity,
          "liveMeeting.projectionPublisherIdentity",
        );
    this.lastProjectedRevision = requireNonNegativeInteger(
      snapshot.projectedRevision,
      "liveMeeting.projectedRevision",
    );
    this.validateLifecycle();
  }

  public static start(input: StartLiveMeetingInput): LiveMeeting {
    return new LiveMeeting({
      draftSummary: null,
      endedAtMs: null,
      meetingId: input.meetingId,
      projectedRevision: 0,
      projectionExternalId: null,
      projectionPublisherIdentity: null,
      publicationTargetId: input.publicationTargetId,
      revision: 0,
      startedAtMs: input.startedAtMs,
      status: "active",
      summaryGeneratedAtMs: null,
    });
  }

  public static restore(snapshot: LiveMeetingSnapshot): LiveMeeting {
    return new LiveMeeting(snapshot);
  }

  public get revision(): number {
    return this.currentRevision;
  }

  public get status(): LiveMeetingStatus {
    return this.currentStatus;
  }

  public get endedAtMs(): number | null {
    return this.endedTimestampMs;
  }

  public get draftSummary(): LiveSummaryDraftSnapshot | null {
    return this.summaryDraft;
  }

  public get summaryGeneratedAtMs(): number | null {
    return this.summaryTimestampMs;
  }

  public get projectionExternalId(): string | null {
    return this.externalProjectionId;
  }

  public get projectedRevision(): number {
    return this.lastProjectedRevision;
  }

  public acceptSummary(input: {
    readonly evidenceTurns: readonly TranscriptTurnSnapshot[];
    readonly generatedAtMs: number;
    readonly summary: LiveSummaryDraftSnapshot;
  }): void {
    const evidenceTurns = input.evidenceTurns.map((turn) => TranscriptTurn.create(turn));
    if (evidenceTurns.length === 0) {
      throw new DomainInvariantError(
        "INVALID_EVIDENCE_REFERENCE",
        "live summary must cover at least one finalized evidence turn",
      );
    }
    if (new Set(evidenceTurns.map(({ turnId }) => turnId)).size !== evidenceTurns.length) {
      throw new DomainInvariantError(
        "DUPLICATE_IDENTIFIER",
        "live summary generated evidence turn IDs must be unique",
      );
    }
    const expectedSummaryRevision = (this.summaryDraft?.revision ?? 0) + 1;
    const summary = normalizeLiveSummary(input.summary, evidenceTurns, expectedSummaryRevision);
    const generatedAtMs = requireNonNegativeInteger(input.generatedAtMs, "liveSummary.generatedAtMs");
    if (generatedAtMs < this.startedAtMs) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "summary cannot predate the meeting");
    }
    this.summaryDraft = summary;
    this.summaryTimestampMs = generatedAtMs;
    this.incrementRevision();
  }

  public completeProjection(
    externalPublicationId: string,
    projectedRevision: number,
    publisherIdentity?: string,
  ): boolean {
    const normalized = createExternalPublicationId(externalPublicationId);
    const normalizedPublisherIdentity = normalizeProjectionPublisherIdentity(
      publisherIdentity,
      this.projectionPublisherIdentity,
    );
    const revision = requireNonNegativeInteger(projectedRevision, "projection.projectedRevision");
    if (revision > this.currentRevision) {
      throw new DomainInvariantError("CONFLICTING_COMPLETION", "cannot project a future revision");
    }
    const receiptRotated = this.externalProjectionId !== null &&
      this.externalProjectionId !== normalized;
    const publisherRotated = isPublisherRotation({
      currentPublisherIdentity: this.projectionPublisherIdentity,
      hasExistingProjection: this.externalProjectionId !== null,
      nextPublisherIdentity: normalizedPublisherIdentity,
      receiptRotated,
    });
    if (
      publisherRotated &&
      (!receiptRotated || revision !== this.currentRevision)
    ) {
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "publisher rotation requires a current projection with a new receipt",
      );
    }
    if (receiptRotated && revision < this.lastProjectedRevision) {
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "cannot rotate a live projection receipt from a stale revision",
      );
    }
    if (
      !receiptRotated &&
      this.externalProjectionId !== null &&
      revision <= this.lastProjectedRevision
    ) {
      if (
        this.projectionPublisherIdentity === null &&
        normalizedPublisherIdentity.length > 0 &&
        revision === this.lastProjectedRevision
      ) {
        this.projectionPublisherIdentity = normalizedPublisherIdentity;
        this.incrementRevision();
        return true;
      }
      return false;
    }

    this.externalProjectionId = normalized;
    this.projectionPublisherIdentity = normalizedPublisherIdentity;
    this.incrementRevision();
    this.lastProjectedRevision = this.currentRevision;
    return true;
  }

  public end(endedAtMs: number): boolean {
    const normalized = requireNonNegativeInteger(endedAtMs, "liveMeeting.endedAtMs");
    if (normalized < this.startedAtMs) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "meeting end cannot predate start");
    }
    if (this.currentStatus === "ended") {
      if (this.endedTimestampMs === normalized) {
        return false;
      }
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "live meeting ended with a different timestamp",
      );
    }
    this.currentStatus = "ended";
    this.endedTimestampMs = normalized;
    this.incrementRevision();
    return true;
  }

  public toSnapshot(): LiveMeetingSnapshot {
    return {
      draftSummary: this.summaryDraft,
      endedAtMs: this.endedTimestampMs,
      meetingId: this.meetingId,
      projectedRevision: this.lastProjectedRevision,
      projectionExternalId: this.externalProjectionId,
      projectionPublisherIdentity: this.projectionPublisherIdentity,
      publicationTargetId: this.publicationTargetId,
      revision: this.currentRevision,
      startedAtMs: this.startedAtMs,
      status: this.currentStatus,
      summaryGeneratedAtMs: this.summaryTimestampMs,
    };
  }

  private incrementRevision(): void {
    this.currentRevision += 1;
  }

  private validateLifecycle(): void {
    if (
      (this.currentStatus === "active" && this.endedTimestampMs !== null) ||
      (this.currentStatus === "ended" && this.endedTimestampMs === null)
    ) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "live meeting status is inconsistent");
    }
    if (this.lastProjectedRevision > this.currentRevision) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "projected revision exceeds live state");
    }
    if (this.externalProjectionId === null && this.lastProjectedRevision !== 0) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "live projection state is inconsistent");
    }
    const hasNoSummaryState = this.summaryDraft === null && this.summaryTimestampMs === null;
    const hasCompleteSummaryState = this.summaryDraft !== null && this.summaryTimestampMs !== null;
    if (!hasNoSummaryState && !hasCompleteSummaryState) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "live summary state is inconsistent");
    }
  }
}
