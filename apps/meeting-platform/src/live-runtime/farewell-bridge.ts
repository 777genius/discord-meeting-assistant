import { MeetingFarewellPolicy } from "@discord-meeting/meeting-core/conversation";

import type {
  LiveConversationConfiguration,
  LiveFarewellClassificationInput,
  LiveFarewellTurn,
  LiveRuntimeLogger,
  LiveTranscriptionEvent,
} from "./contracts.js";

const fastPathFenceMs = 100;
const maximumContextTurns = 5;
const oneShotReceiptLeaseSeconds = 120;
const farewellTurnId = "meeting-farewell:v1";

interface FarewellBridgeDependencies {
  readonly configuration: LiveConversationConfiguration;
  readonly isMeetingFinishing: () => boolean;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
}

interface PendingFastPath {
  readonly dueAtMs: number;
  readonly evidenceTurnIds: readonly string[];
  readonly locale: "en" | "ru";
  readonly reason: string;
  readonly revision: number;
}

interface FarewellReceiptInput {
  readonly kind: "farewell";
  readonly meetingId: string;
  readonly subjectId: "meeting";
}

/** Meeting-local farewell policy with a 100 ms continuation fence. */
export class FarewellBridge {
  private attemptOrdinal = 0;
  private classificationPromise: Promise<void> | null = null;
  private closed = false;
  private readonly contextTurns: LiveFarewellTurn[] = [];
  private pendingFastPath: PendingFastPath | null = null;
  private readonly policy = new MeetingFarewellPolicy();
  private readonly presentParticipantIds = new Set<string>();
  private queuedReview: LiveFarewellClassificationInput | null = null;
  private revision = 0;
  private readonly tasks = new Set<Promise<void>>();

  public constructor(private readonly dependencies: FarewellBridgeDependencies) {}

  public participantsPresent(participantIds: readonly string[]): void {
    for (const participantId of participantIds) {
      this.presentParticipantIds.add(participantId);
    }
  }

  public participantJoined(participantId: string): void {
    if (!this.closed && !this.presentParticipantIds.has(participantId)) {
      this.presentParticipantIds.add(participantId);
      this.bumpRevision();
    }
  }

  public participantLeft(participantId: string): void {
    // Leaving immediately after a farewell must not invalidate that farewell.
    // New speech and new arrivals still fence a pending decision.
    this.presentParticipantIds.delete(participantId);
  }

  /** Returns the context revision that belongs to this STT observation. */
  public observeSpeech(_event: LiveTranscriptionEvent): number {
    this.bumpRevision();
    return this.revision;
  }

  public observeFinalizedTurn(
    event: LiveTranscriptionEvent,
    turnId: string,
    observedRevision: number,
  ): void {
    if (this.closed || this.dependencies.isMeetingFinishing()) {
      return;
    }
    const turn = Object.freeze({
      endMs: event.endMs,
      speakerId: event.speakerId,
      startMs: event.startMs,
      text: event.text,
      turnId,
    });
    this.contextTurns.push(turn);
    while (this.contextTurns.length > maximumContextTurns) {
      this.contextTurns.shift();
    }
    const decision = this.policy.observe({
      endMs: event.endMs,
      presentParticipantCount: this.presentParticipantIds.size,
      speakerId: event.speakerId,
      text: event.text,
      turnId,
    });
    if (observedRevision !== this.revision) {
      return;
    }
    if (decision.status === "trigger") {
      this.pendingFastPath = {
        dueAtMs: this.nowMilliseconds() + fastPathFenceMs,
        evidenceTurnIds: decision.evidenceTurnIds,
        locale: decision.locale,
        reason: decision.reason,
        revision: observedRevision,
      };
      return;
    }
    if (
      decision.status === "review" &&
      this.dependencies.configuration.farewells?.classifier !== undefined
    ) {
      this.queueClassification(observedRevision);
    }
  }

  public advance(): void {
    const pending = this.pendingFastPath;
    if (
      pending === null ||
      pending.dueAtMs > this.nowMilliseconds() ||
      pending.revision !== this.revision
    ) {
      return;
    }
    this.pendingFastPath = null;
    this.track(this.play(pending.locale, pending.reason, pending.evidenceTurnIds));
  }

  public close(): void {
    this.closed = true;
    this.pendingFastPath = null;
    this.queuedReview = null;
    this.presentParticipantIds.clear();
  }

  public async settle(): Promise<void> {
    while (this.classificationPromise !== null || this.tasks.size > 0) {
      await Promise.all([
        ...(this.classificationPromise === null ? [] : [this.classificationPromise]),
        ...this.tasks,
      ]);
    }
  }

  private bumpRevision(): void {
    if (this.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error("Farewell context revision exhausted");
    }
    this.revision += 1;
    this.pendingFastPath = null;
  }

  private queueClassification(revision: number): void {
    const farewells = this.dependencies.configuration.farewells;
    if (farewells?.classifier === undefined) {
      return;
    }
    const input: LiveFarewellClassificationInput = Object.freeze({
      meetingId: this.dependencies.meetingId,
      participantIds: Object.freeze([...this.presentParticipantIds].toSorted()),
      participantNames: farewells.participantNames,
      revision,
      turns: Object.freeze([...this.contextTurns]),
    });
    if (this.classificationPromise !== null) {
      this.queuedReview = input;
      return;
    }
    this.startClassification(input);
  }

  private startClassification(input: LiveFarewellClassificationInput): void {
    const classifier = this.dependencies.configuration.farewells?.classifier;
    if (classifier === undefined) {
      return;
    }
    let running!: Promise<void>;
    running = (async () => {
      let outcome: Awaited<ReturnType<typeof classifier.classify>>;
      try {
        outcome = await classifier.classify(input);
      } catch (error) {
        this.dependencies.logger.warn("Farewell classification failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: this.dependencies.meetingId,
        });
        return;
      }
      if (
        outcome !== "reject" &&
        !this.closed &&
        !this.dependencies.isMeetingFinishing() &&
        input.revision === this.revision
      ) {
        await this.play(
          outcome,
          "semantic",
          [input.turns.at(-1)?.turnId].filter(
            (turnId): turnId is string => turnId !== undefined,
          ),
        );
      }
    })().finally(() => {
      if (this.classificationPromise === running) {
        this.classificationPromise = null;
      }
      const queued = this.queuedReview;
      this.queuedReview = null;
      if (
        queued !== null &&
        queued.revision === this.revision &&
        !this.closed
      ) {
        this.startClassification(queued);
      }
    });
    this.classificationPromise = running;
  }

  private async play(
    locale: "en" | "ru",
    reason: string,
    evidenceTurnIds: readonly string[],
  ): Promise<void> {
    const farewells = this.dependencies.configuration.farewells;
    if (
      farewells === undefined ||
      this.closed ||
      this.dependencies.isMeetingFinishing()
    ) {
      return;
    }
    const cue = farewells.cues.select({
      locale,
      meetingId: this.dependencies.meetingId,
      voiceProfileId: this.dependencies.configuration.voiceProfileId,
    });
    if (cue === null) {
      return;
    }
    const receiptInput: FarewellReceiptInput = {
      kind: "farewell", meetingId: this.dependencies.meetingId, subjectId: "meeting",
    };
    const receipt = await this.dependencies.configuration.oneShotReceipts
      ?.reserve({ ...receiptInput, leaseSeconds: oneShotReceiptLeaseSeconds }) ?? {
        leaseToken: "meeting-local-farewell",
        status: "reserved" as const,
      };
    if (receipt.status !== "reserved") {
      return;
    }
    if (!this.policy.reserve()) {
      await this.dependencies.configuration.oneShotReceipts?.release({
        ...receiptInput,
        leaseToken: receipt.leaseToken,
      });
      return;
    }
    await this.beginDurableAttempt(receiptInput, receipt.leaseToken);
    const turnId = this.currentTurnId();
    let outcome: Awaited<ReturnType<
      LiveConversationConfiguration["coordinator"]["playPreparedCue"]
    >>;
    try {
      outcome = await this.dependencies.configuration.coordinator
        .playPreparedCue({
          ...(cue.assetSha256 === undefined ? {} : { assetSha256: cue.assetSha256 }),
          cueId: cue.cueId,
          locale,
          meetingId: this.dependencies.meetingId,
          nowMs: this.nowMilliseconds(),
          pcmChunks: cue.pcmChunks,
          playbackAttemptId: cue.playbackAttemptId,
          preemptive: true,
          recordingId: this.dependencies.meetingId,
          speakerId: "farewell-system",
          turnId,
          voiceProfileId: this.dependencies.configuration.voiceProfileId,
        });
    } catch (error) {
      // Provider invocation may have admitted audio before its response was
      // lost. Keep the durable attempted fence terminal across restart.
      this.logPlaybackFailure(error, locale, reason);
      return;
    }
    const admitted = outcome.status === "active" || outcome.status === "queued" ||
      (outcome.status === "reused" && outcome.disposition !== "busy");
    if (!admitted) {
      await this.releaseRetryableReceipt(
        receiptInput,
        receipt.leaseToken,
        "busy",
        true,
      );
      return;
    }
    let settlement: "played" | "unplayed" | "partial" | "unknown";
    try {
      settlement = await this.dependencies.configuration.coordinator
        .whenTurnPlaybackSettled(this.dependencies.meetingId, turnId);
    } catch (error) {
      await this.completeAmbiguousReceipt(receiptInput, receipt.leaseToken);
      this.logPlaybackFailure(error, locale, reason);
      return;
    }
    await this.settleAdmittedPlayback({
      evidenceTurnIds,
      leaseToken: receipt.leaseToken,
      locale,
      playbackAttemptId: cue.playbackAttemptId,
      reason,
      receiptInput,
      settlement,
      turnId,
    });
  }

  private async settleAdmittedPlayback(input: {
    readonly evidenceTurnIds: readonly string[];
    readonly leaseToken: string;
    readonly locale: "en" | "ru";
    readonly playbackAttemptId: string;
    readonly reason: string;
    readonly receiptInput: FarewellReceiptInput;
    readonly settlement: "played" | "unplayed" | "partial" | "unknown";
    readonly turnId: string;
  }): Promise<void> {
    if (input.settlement === "unplayed") {
      await this.releaseRetryableReceipt(
        input.receiptInput,
        input.leaseToken,
        "unplayed",
        true,
      );
      return;
    }
    if (input.settlement !== "played") {
      await this.settleTerminalReceipt(
        input.receiptInput,
        input.leaseToken,
        "suppressed",
        "ambiguous",
      );
      this.dependencies.logger.warn("Meeting farewell playback fenced after ambiguous settlement", {
        locale: input.locale,
        meetingId: this.dependencies.meetingId,
        playbackAttemptId: input.playbackAttemptId,
        settlement: input.settlement,
        turnId: input.turnId,
      });
      return;
    }
    await this.settleTerminalReceipt(
      input.receiptInput,
      input.leaseToken,
      "played",
    );
    this.dependencies.logger.info("Meeting farewell playback settled", {
      evidenceTurnIds: input.evidenceTurnIds,
      locale: input.locale,
      meetingId: this.dependencies.meetingId,
      playbackAttemptId: input.playbackAttemptId,
      reason: input.reason,
      turnId: input.turnId,
    });
  }

  private async releaseRetryableReceipt(
    receiptInput: FarewellReceiptInput,
    leaseToken: string,
    evidence: "busy" | "unplayed",
    advanceAttempt: boolean,
  ): Promise<void> {
    try {
      const receipts = this.dependencies.configuration.oneShotReceipts;
      if (receipts?.releaseFarewellAttempt !== undefined) {
        await receipts.releaseFarewellAttempt({
          evidence,
          ...receiptInput,
          leaseToken,
        });
      } else {
        await receipts?.release({ ...receiptInput, leaseToken });
      }
    } finally {
      this.policy.releaseReservation();
      if (advanceAttempt) {
        this.advanceAttemptOrdinal();
      }
    }
  }

  private async beginDurableAttempt(
    receiptInput: FarewellReceiptInput,
    leaseToken: string,
  ): Promise<void> {
    const receipts = this.dependencies.configuration.oneShotReceipts;
    if (receipts?.beginFarewellAttempt !== undefined) {
      await receipts.beginFarewellAttempt({ ...receiptInput, leaseToken });
      return;
    }
    await receipts?.complete({ ...receiptInput, leaseToken });
  }

  private async completeAmbiguousReceipt(
    receiptInput: FarewellReceiptInput,
    leaseToken: string,
  ): Promise<void> {
    await this.settleTerminalReceipt(
      receiptInput,
      leaseToken,
      "suppressed",
      "ambiguous",
    );
  }

  private async settleTerminalReceipt(
    receiptInput: FarewellReceiptInput,
    leaseToken: string,
    outcome: "played" | "suppressed",
    reason?: "ambiguous",
  ): Promise<void> {
    const receipts = this.dependencies.configuration.oneShotReceipts;
    if (receipts?.settleFarewell !== undefined) {
      await receipts.settleFarewell({
        ...receiptInput,
        leaseToken,
        outcome,
        ...(reason === undefined ? {} : { reason }),
      });
      return;
    }
    await receipts?.complete({ ...receiptInput, leaseToken });
  }

  private currentTurnId(): string {
    return this.attemptOrdinal === 0 ? farewellTurnId
      : `${farewellTurnId}:retry-${this.attemptOrdinal}`;
  }

  private advanceAttemptOrdinal(): void {
    if (this.attemptOrdinal === Number.MAX_SAFE_INTEGER) {
      throw new Error("Farewell playback attempt ordinal exhausted");
    }
    this.attemptOrdinal += 1;
  }

  private logPlaybackFailure(
    error: unknown,
    locale: "en" | "ru",
    reason: string,
  ): void {
    this.dependencies.logger.warn("Meeting farewell failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      locale,
      meetingId: this.dependencies.meetingId,
      reason,
    });
  }

  private track(task: Promise<void>): void {
    let guarded!: Promise<void>;
    guarded = task.catch((error: unknown) => {
      this.dependencies.logger.warn("Meeting farewell task failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: this.dependencies.meetingId,
      });
    }).finally(() => {
      this.tasks.delete(guarded);
    });
    this.tasks.add(guarded);
  }

  private nowMilliseconds(): number {
    const value = Math.floor(this.dependencies.configuration.nowMilliseconds());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Farewell observation clock must be a non-negative integer");
    }
    return value;
  }
}
