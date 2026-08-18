import {
  DomainInvariantError,
  requireNonEmpty,
  requireNonNegativeInteger,
} from "./errors.js";
import {
  createMeetingExternalPublicationId,
  createMeetingId,
  createMeetingPublicationTargetId,
  type MeetingId,
} from "./identifiers.js";
import { RecordingArtifact } from "../../recording/index.js";
import { EvidenceBackedSummary } from "../../meeting-intelligence/index.js";
import {
  type PublicationReceipt,
  type PublicationReceiptSnapshot,
  type PublicationTargetId,
} from "../../publishing/index.js";
import { FinalTranscript } from "../../transcription/index.js";
import {
  sameStageFailure,
  validateStageFailure,
  validateStageState,
  type BeginStageDisposition,
  type ProcessingStage,
  type StageFailure,
  type StageState,
} from "./meeting-stage.js";
import {
  normalizeActors,
  normalizeIdentityProvenance,
  normalizeLifecycleGeneration,
  normalizeSource,
  type MeetingActorSnapshot,
  type MeetingIdentityProvenanceSnapshot,
  type MeetingSourceSnapshot,
} from "./meeting-identity.js";
import type {
  LegacyRecordedMeetingInput,
  MeetingSnapshot,
  RecordedMeetingInput,
  RestorableMeetingSnapshot,
} from "./meeting-snapshot.js";
import { initialMeetingSnapshot } from "./meeting-snapshot.js";

export type { BeginStageDisposition, ProcessingStage, StageFailure, StageState } from "./meeting-stage.js";

function identityPart(value: string): string {
  return `${value.length}:${value}`;
}

export class Meeting {
  public readonly actors: readonly MeetingActorSnapshot[] | null;
  public readonly identityProvenance: MeetingIdentityProvenanceSnapshot | null;
  public readonly lifecycleGeneration: number | null;
  public readonly meetingId: MeetingId;
  public readonly publicationTargetId: PublicationTargetId;
  public readonly recording: RecordingArtifact;
  public readonly source: MeetingSourceSnapshot | null;

  private currentRevision: number;
  private stages: Record<ProcessingStage, StageState>;
  private finalTranscript: FinalTranscript | null;
  private acceptedSummary: EvidenceBackedSummary | null;
  private publicationReceipt: PublicationReceipt | null;

  private constructor(snapshot: RestorableMeetingSnapshot) {
    this.actors = normalizeActors(snapshot.actors);
    this.lifecycleGeneration = normalizeLifecycleGeneration(snapshot.lifecycleGeneration);
    this.identityProvenance = normalizeIdentityProvenance(snapshot.identityProvenance, this.lifecycleGeneration);
    this.meetingId = createMeetingId(snapshot.meetingId);
    this.publicationTargetId = createMeetingPublicationTargetId(
      snapshot.publicationTargetId,
    );
    this.recording = RecordingArtifact.create(snapshot.recording);
    this.source = normalizeSource(snapshot.source);
    this.currentRevision = requireNonNegativeInteger(snapshot.revision, "meeting.revision");
    this.stages = {
      publication: validateStageState(snapshot.publicationStage, "publicationStage"),
      summary: validateStageState(snapshot.summaryStage, "summaryStage"),
      transcription: validateStageState(
        snapshot.transcriptionStage,
        "transcriptionStage",
      ),
    };
    this.finalTranscript =
      snapshot.transcript === null ? null : FinalTranscript.create(snapshot.transcript);
    this.acceptedSummary =
      snapshot.summary === null
        ? null
        : this.finalTranscript === null
          ? this.throwInvalidSnapshot("summary cannot exist without a transcript")
          : EvidenceBackedSummary.restore(snapshot.summary, this.finalTranscript);
    this.publicationReceipt =
      snapshot.publication === null
        ? null
        : Object.freeze({
            externalPublicationId: createMeetingExternalPublicationId(snapshot.publication.externalPublicationId),
            idempotencyKey: requireNonEmpty(snapshot.publication.idempotencyKey, "publication.idempotencyKey"),
            publisherIdentity: snapshot.publication.publisherIdentity
              ? requireNonEmpty(snapshot.publication.publisherIdentity, "publication.publisherIdentity") : "",
          });

    this.validateSnapshotConsistency();
  }

  public static record(input: RecordedMeetingInput): Meeting {
    const runtimeInput = input as { readonly actors?: RecordedMeetingInput["actors"] | null; readonly source?: RecordedMeetingInput["source"] | null };
    if (runtimeInput.source === null || runtimeInput.source === undefined) {
      throw new DomainInvariantError(
        "INVALID_SNAPSHOT",
        "new meetings require durable source identity",
      );
    }
    if (runtimeInput.actors === null || runtimeInput.actors === undefined) {
      throw new DomainInvariantError(
        "INVALID_SNAPSHOT",
        "new meetings require a durable actor roster",
      );
    }
    return new Meeting(initialMeetingSnapshot(input, input.actors));
  }

  /**
   * Transitional Craig v1 admission. Its participant contract cannot prove a
   * complete automation-free actor roster, so the resulting meeting is
   * intentionally ineligible for knowledge features.
   */
  public static recordLegacy(input: LegacyRecordedMeetingInput): Meeting {
    return new Meeting(initialMeetingSnapshot({ ...input, source: null }, null));
  }

  public static restore(snapshot: RestorableMeetingSnapshot): Meeting {
    return new Meeting(snapshot);
  }

  public get revision(): number {
    return this.currentRevision;
  }

  public get transcript(): FinalTranscript | null {
    return this.finalTranscript;
  }

  public get summary(): EvidenceBackedSummary | null {
    return this.acceptedSummary;
  }

  public get publication(): PublicationReceipt | null {
    return this.publicationReceipt;
  }

  public stage(stage: ProcessingStage): StageState {
    const state = this.stages[stage];
    return state.status === "failed"
      ? { ...state, failure: { ...state.failure } }
      : { ...state };
  }

  public beginTranscription(): BeginStageDisposition {
    return this.begin("transcription");
  }

  public completeTranscription(transcript: FinalTranscript): boolean {
    if (transcript.recordingId !== this.recording.recordingId) {
      throw new DomainInvariantError(
        "INVALID_RECORDING_REFERENCE",
        "final transcript must reference the meeting recording",
      );
    }

    if (this.stages.transcription.status === "succeeded") {
      if (this.finalTranscript?.equals(transcript) === true) {
        return false;
      }
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "transcription already succeeded with different content",
      );
    }

    this.requireRunning("transcription");
    this.finalTranscript = transcript;
    this.succeed("transcription");
    return true;
  }

  public failTranscription(failure: StageFailure): boolean {
    return this.fail("transcription", failure);
  }

  public beginSummary(): BeginStageDisposition {
    if (this.finalTranscript === null || this.stages.transcription.status !== "succeeded") {
      throw new DomainInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "summary cannot start before final transcription succeeds",
      );
    }
    return this.begin("summary");
  }

  public completeSummary(summary: EvidenceBackedSummary): boolean {
    if (this.finalTranscript === null || summary.transcriptId !== this.finalTranscript.transcriptId) {
      throw new DomainInvariantError(
        "INVALID_EVIDENCE_REFERENCE",
        "summary must reference the meeting final transcript",
      );
    }

    if (this.stages.summary.status === "succeeded") {
      if (this.acceptedSummary?.equals(summary) === true) {
        return false;
      }
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "summary already succeeded with different content",
      );
    }

    this.requireRunning("summary");
    this.acceptedSummary = summary;
    this.succeed("summary");
    return true;
  }

  public failSummary(failure: StageFailure): boolean {
    return this.fail("summary", failure);
  }

  public beginPublication(): BeginStageDisposition {
    if (this.acceptedSummary === null || this.stages.summary.status !== "succeeded") {
      throw new DomainInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "publication cannot start before summary succeeds",
      );
    }
    return this.begin("publication");
  }

  public publicationIdempotencyKey(): string {
    if (this.acceptedSummary === null) {
      throw new DomainInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "publication identity requires an accepted summary",
      );
    }

    return [
      "meeting-summary-publication:v1",
      identityPart(this.meetingId),
      identityPart(this.acceptedSummary.summaryId),
      identityPart(this.publicationTargetId),
    ].join("|");
  }

  public completePublication(receipt: PublicationReceiptSnapshot): boolean {
    const normalized = Object.freeze({
      externalPublicationId: createMeetingExternalPublicationId(
        receipt.externalPublicationId,
      ),
      idempotencyKey: requireNonEmpty(receipt.idempotencyKey, "publication.idempotencyKey"),
      publisherIdentity: receipt.publisherIdentity
        ? requireNonEmpty(receipt.publisherIdentity, "publication.publisherIdentity") : "",
    });
    if (normalized.idempotencyKey !== this.publicationIdempotencyKey()) {
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "publication receipt must use the meeting publication identity",
      );
    }

    if (this.stages.publication.status === "succeeded") {
      if (
        this.publicationReceipt?.externalPublicationId ===
          normalized.externalPublicationId &&
        this.publicationReceipt.idempotencyKey === normalized.idempotencyKey &&
        this.publicationReceipt.publisherIdentity === normalized.publisherIdentity
      ) {
        return false;
      }
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "publication already succeeded with a different receipt",
      );
    }

    this.requireRunning("publication");
    this.publicationReceipt = normalized;
    this.succeed("publication");
    return true;
  }

  public failPublication(failure: StageFailure): boolean {
    return this.fail("publication", failure);
  }

  public toSnapshot(): MeetingSnapshot {
    return {
      actors: this.actors === null
        ? null
        : this.actors.map((actor) => ({ actorId: actor.actorId, kind: actor.kind })),
      identityProvenance: this.identityProvenance,
      lifecycleGeneration: this.lifecycleGeneration,
      meetingId: this.meetingId,
      publication:
        this.publicationReceipt === null
          ? null
          : {
              externalPublicationId: this.publicationReceipt.externalPublicationId,
              idempotencyKey: this.publicationReceipt.idempotencyKey,
              publisherIdentity: this.publicationReceipt.publisherIdentity,
            },
      publicationStage: this.stage("publication"),
      publicationTargetId: this.publicationTargetId,
      recording: this.recording.toSnapshot(),
      revision: this.currentRevision,
      summary: this.acceptedSummary?.toSnapshot() ?? null,
      summaryStage: this.stage("summary"),
      source: this.source === null
        ? null
        : { roomId: this.source.roomId, scopeId: this.source.scopeId },
      transcript: this.finalTranscript?.toSnapshot() ?? null,
      transcriptionStage: this.stage("transcription"),
    };
  }

  private begin(stage: ProcessingStage): BeginStageDisposition {
    const current = this.stages[stage];
    if (current.status === "succeeded") {
      return "already-succeeded";
    }
    if (current.status === "running") {
      return "already-running";
    }
    if (current.status === "failed" && !current.failure.retryable) {
      throw new DomainInvariantError(
        "STAGE_NOT_RETRYABLE",
        `${stage} failed permanently and cannot be retried automatically`,
      );
    }

    this.stages[stage] = Object.freeze({
      attempts: current.attempts + 1,
      status: "running",
    });
    this.incrementRevision();
    return "started";
  }

  private fail(stage: ProcessingStage, failure: StageFailure): boolean {
    const current = this.stages[stage];
    const normalized = validateStageFailure(failure);
    if (current.status === "failed" && sameStageFailure(current.failure, normalized)) {
      return false;
    }
    this.requireRunning(stage);
    this.stages[stage] = Object.freeze({
      attempts: current.attempts,
      failure: normalized,
      status: "failed",
    });
    this.incrementRevision();
    return true;
  }

  private succeed(stage: ProcessingStage): void {
    const current = this.stages[stage];
    this.stages[stage] = Object.freeze({
      attempts: current.attempts,
      status: "succeeded",
    });
    this.incrementRevision();
  }

  private requireRunning(stage: ProcessingStage): void {
    if (this.stages[stage].status !== "running") {
      throw new DomainInvariantError(
        "INVALID_LIFECYCLE_STATE",
        `${stage} must be running before it can finish`,
      );
    }
  }

  private incrementRevision(): void {
    this.currentRevision += 1;
  }

  private validateSnapshotConsistency(): void {
    this.validateArtifactStage(
      "transcription",
      this.finalTranscript,
      "transcript",
    );
    this.validateArtifactStage("summary", this.acceptedSummary, "summary");
    this.validateArtifactStage(
      "publication",
      this.publicationReceipt,
      "publication receipt",
    );

    if (
      this.stages.summary.status !== "pending" &&
      this.stages.transcription.status !== "succeeded"
    ) {
      this.throwInvalidSnapshot(
        "a started summary stage requires successful transcription",
      );
    }
    if (
      this.stages.publication.status !== "pending" &&
      this.stages.summary.status !== "succeeded"
    ) {
      this.throwInvalidSnapshot(
        "a started publication stage requires a successful summary",
      );
    }

    if (
      this.finalTranscript !== null &&
      this.finalTranscript.recordingId !== this.recording.recordingId
    ) {
      this.throwInvalidSnapshot("transcript references a different recording");
    }
    if (
      this.publicationReceipt !== null &&
      this.publicationReceipt.idempotencyKey !== this.publicationIdempotencyKey()
    ) {
      this.throwInvalidSnapshot("publication receipt has a different identity");
    }
  }

  private validateArtifactStage(
    stage: ProcessingStage,
    artifact: object | null,
    artifactName: string,
  ): void {
    const succeeded = this.stages[stage].status === "succeeded";
    if (succeeded !== (artifact !== null)) {
      this.throwInvalidSnapshot(
        `${artifactName} presence must match ${stage} success`,
      );
    }
  }

  private throwInvalidSnapshot(message: string): never {
    throw new DomainInvariantError("INVALID_SNAPSHOT", message);
  }
}
