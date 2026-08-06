import { resolveConversationLocale } from "./conversation-locale.js";

import type {
  LiveConversationConfiguration,
  LiveRuntimeLogger,
  LiveTranscriptionEvent,
} from "./contracts.js";

export interface ConversationBridgeDependencies {
  readonly configuration: LiveConversationConfiguration;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly meetingStartedAtMs: number;
}

/** Serializes derived conversation observations for one active meeting. */
export class ConversationBridge {
  private chain: Promise<void> = Promise.resolve();
  private speechObservationQueued = false;
  private readonly speakingParticipants = new Set<string>();

  public constructor(
    private readonly dependencies: ConversationBridgeDependencies,
  ) {}

  public observeSpeech(event: LiveTranscriptionEvent, finishing: boolean): void {
    if (finishing) {
      return;
    }
    const speakerWasActive = this.speakingParticipants.has(event.speakerId);
    const conversationWasActive = this.speakingParticipants.size > 0;
    const observedAtMs = this.nowMilliseconds();
    if (!event.isFinal) {
      this.speakingParticipants.add(event.speakerId);
      void this.enqueue(async () => {
        if (conversationWasActive) {
          await this.dependencies.configuration.coordinator.speechActivity(
            this.dependencies.meetingId,
            observedAtMs,
          );
        } else {
          await this.dependencies.configuration.coordinator.speechStarted(
            this.dependencies.meetingId,
            observedAtMs,
          );
        }
      });
      return;
    }
    this.speakingParticipants.delete(event.speakerId);
    const conversationRemainsActive = this.speakingParticipants.size > 0;
    void this.enqueue(async () => {
      if (!speakerWasActive && !conversationWasActive) {
        await this.dependencies.configuration.coordinator.speechStarted(
          this.dependencies.meetingId,
          observedAtMs,
        );
      }
      if (conversationRemainsActive) {
        await this.dependencies.configuration.coordinator.speechActivity(
          this.dependencies.meetingId,
          observedAtMs,
        );
      } else {
        await this.dependencies.configuration.coordinator.speechEnded(
          this.dependencies.meetingId,
          observedAtMs,
        );
      }
    });
  }

  public observeFinalizedTurn(
    event: LiveTranscriptionEvent,
    turnId: string,
    isMeetingFinishing: () => boolean,
  ): Promise<void> {
    if (isMeetingFinishing()) {
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      if (isMeetingFinishing()) {
        return;
      }
      const wakeDetectedAtUnixMs = this.nowMilliseconds();
      const outcome = await this.dependencies.configuration.coordinator
        .handleFinalizedTurn({
          locale: this.dependencies.configuration.locale,
          meetingId: this.dependencies.meetingId,
          nowMs: wakeDetectedAtUnixMs,
          recordingId: this.dependencies.meetingId,
          speakerId: event.speakerId,
          systemPrompt: this.dependencies.configuration.systemPrompt,
          text: event.text,
          thinkingCueLocale: resolveConversationLocale(
            this.dependencies.configuration.locale,
            event.text,
          ),
          turnEndedAtUnixMs: this.dependencies.meetingStartedAtMs + event.endMs,
          transcriptEndMs: event.endMs,
          transcriptStartMs: event.startMs,
          turnId,
          voiceProfileId: this.dependencies.configuration.voiceProfileId,
          wakeDetectedAtUnixMs,
        });
      this.dependencies.logger.info("Live conversation turn observed", {
        meetingId: this.dependencies.meetingId,
        outcome: outcome.status,
        speakerId: event.speakerId,
        turnId,
      });
    });
  }

  public advance(finishing: boolean): void {
    if (finishing) {
      return;
    }
    const observedAtMs = this.nowMilliseconds();
    void this.enqueue(async () => {
      this.dependencies.configuration.coordinator.advanceMeeting(
        this.dependencies.meetingId,
        observedAtMs,
      );
    });
  }

  public scheduleSpeechObservation(isMeetingFinishing: () => boolean): void {
    if (
      isMeetingFinishing() ||
      this.speechObservationQueued ||
      this.speakingParticipants.size === 0
    ) {
      return;
    }
    const observedAtMs = this.nowMilliseconds();
    this.speechObservationQueued = true;
    void this.enqueue(async () => {
      try {
        if (!isMeetingFinishing() && this.speakingParticipants.size > 0) {
          await this.dependencies.configuration.coordinator.speechActivity(
            this.dependencies.meetingId,
            observedAtMs,
          );
        }
      } finally {
        this.speechObservationQueued = false;
      }
    });
  }

  public close(): void {
    this.speakingParticipants.clear();
    const observedAtMs = this.nowMilliseconds();
    void this.enqueue(async () => {
      await this.dependencies.configuration.coordinator.closeMeeting(
        this.dependencies.meetingId,
        observedAtMs,
      );
    });
  }

  public async settle(): Promise<void> {
    await this.chain;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const guarded = async (): Promise<void> => {
      try {
        await task();
      } catch (error) {
        this.dependencies.logger.warn("Live conversation operation failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: this.dependencies.meetingId,
        });
      }
    };
    this.chain = this.chain.then(guarded, guarded);
    return this.chain;
  }

  private nowMilliseconds(): number {
    const value = Math.floor(this.dependencies.configuration.nowMilliseconds());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Conversation observation clock must be a non-negative integer");
    }
    return value;
  }
}
