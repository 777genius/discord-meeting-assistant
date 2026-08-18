import type { MeetingFarewellPolicy } from "@discord-meeting/meeting-core/conversation";

import type {
  LiveConversationConfiguration,
  LiveRuntimeLogger,
} from "./contracts.js";

const oneShotReceiptLeaseSeconds = 120;
const farewellTurnId = "meeting-farewell:v1";

interface FarewellPlaybackAttemptDependencies {
  readonly configuration: LiveConversationConfiguration;
  readonly isClosed: () => boolean;
  readonly isMeetingFinishing: () => boolean;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly policy: MeetingFarewellPolicy;
}

interface FarewellReceiptInput {
  readonly kind: "farewell";
  readonly meetingId: string;
  readonly subjectId: "meeting";
}

interface AdmittedPlaybackInput {
  readonly evidenceTurnIds: readonly string[];
  readonly leaseToken: string;
  readonly locale: "en" | "ru";
  readonly playbackAttemptId: string;
  readonly reason: string;
  readonly receiptInput: FarewellReceiptInput;
  readonly settlement: "played" | "unplayed" | "partial" | "unknown";
  readonly turnId: string;
}

/** Owns durable farewell admission, provider invocation, and terminal settlement. */
export class FarewellPlaybackAttempts {
  private attemptOrdinal = 0;

  public constructor(
    private readonly dependencies: FarewellPlaybackAttemptDependencies,
  ) {}

  public async play(
    locale: "en" | "ru",
    reason: string,
    evidenceTurnIds: readonly string[],
  ): Promise<void> {
    const farewells = this.dependencies.configuration.farewells;
    if (
      farewells === undefined ||
      this.dependencies.isClosed() ||
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
    if (!this.dependencies.policy.reserve()) {
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

  private async settleAdmittedPlayback(input: AdmittedPlaybackInput): Promise<void> {
    if (input.settlement === "unplayed") {
      await this.releaseRetryableReceipt(
        input.receiptInput,
        input.leaseToken,
        "unplayed",
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
      this.dependencies.policy.releaseReservation();
      this.advanceAttemptOrdinal();
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

  private nowMilliseconds(): number {
    const value = Math.floor(this.dependencies.configuration.nowMilliseconds());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Farewell observation clock must be a non-negative integer");
    }
    return value;
  }
}
