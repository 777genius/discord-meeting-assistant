import type {
  LiveConversationConfiguration,
  LiveParticipantGreetingProfile,
  LiveRuntimeLogger,
} from "./contracts.js";

const exactGreetingSystemPrompt = [
  "Speak exactly the greeting provided by the user.",
  "Do not add, remove, translate, explain, or quote anything.",
  "Return only the greeting itself.",
].join(" ");
const maximumBusyRetries = 3;

interface ResolvedParticipantGreeting {
  readonly locale: "en" | "ru";
  readonly prompt: string;
}

interface ParticipantGreetingBridgeDependencies {
  readonly configuration: LiveConversationConfiguration;
  readonly isMeetingFinishing: () => boolean;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
}

/** Meeting-local, bounded queue for one proactive greeting per participant. */
export class ParticipantGreetingBridge {
  private closed = false;
  private drainPromise: Promise<void> | null = null;
  private readonly greetedParticipantIds = new Set<string>();
  private readonly pendingParticipantIds = new Set<string>();
  private readonly presentParticipantIds = new Set<string>();
  private readonly retryCounts = new Map<string, number>();

  public constructor(
    private readonly dependencies: ParticipantGreetingBridgeDependencies,
  ) {}

  public participantsPresent(participantIds: readonly string[]): void {
    for (const participantId of participantIds) {
      this.participantJoined(participantId);
    }
  }

  public participantJoined(participantId: string): void {
    if (this.closed) {
      return;
    }
    this.presentParticipantIds.add(participantId);
    if (
      this.greeting(participantId) !== undefined &&
      !this.greetedParticipantIds.has(participantId)
    ) {
      this.pendingParticipantIds.add(participantId);
    }
    this.advance();
  }

  public participantLeft(participantId: string): void {
    this.presentParticipantIds.delete(participantId);
    this.pendingParticipantIds.delete(participantId);
  }

  public advance(): void {
    const greetings = this.dependencies.configuration.greetings;
    if (
      greetings === undefined ||
      this.closed ||
      this.dependencies.isMeetingFinishing() ||
      this.drainPromise !== null ||
      this.pendingParticipantIds.size === 0 ||
      !greetings.isPlaybackReady(this.dependencies.meetingId)
    ) {
      return;
    }

    let draining!: Promise<void>;
    draining = this.drain()
      .catch((error: unknown) => {
        this.dependencies.logger.warn("Participant greeting queue failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: this.dependencies.meetingId,
        });
      })
      .finally(() => {
        if (this.drainPromise === draining) {
          this.drainPromise = null;
        }
      });
    this.drainPromise = draining;
  }

  public close(): void {
    this.closed = true;
    this.pendingParticipantIds.clear();
    this.presentParticipantIds.clear();
  }

  public async settle(): Promise<void> {
    await this.drainPromise;
  }

  private async drain(): Promise<void> {
    const greetings = this.dependencies.configuration.greetings;
    if (greetings === undefined) {
      return;
    }

    while (!this.closed && !this.dependencies.isMeetingFinishing()) {
      if (!greetings.isPlaybackReady(this.dependencies.meetingId)) {
        return;
      }
      const participantId = this.pendingParticipantIds.values().next().value;
      if (participantId === undefined) {
        return;
      }
      this.pendingParticipantIds.delete(participantId);
      const greeting = this.greeting(participantId);
      if (
        greeting === undefined ||
        !this.presentParticipantIds.has(participantId) ||
        this.greetedParticipantIds.has(participantId)
      ) {
        continue;
      }

      await this.dependencies.configuration.coordinator.whenIdle(
        this.dependencies.meetingId,
      );
      if (this.shouldStopGreeting(participantId)) {
        continue;
      }
      if (!greetings.isPlaybackReady(this.dependencies.meetingId)) {
        this.pendingParticipantIds.add(participantId);
        return;
      }

      // Reserve before the external runtime/playback effect. A failed attempt is
      // intentionally not repeated during this meeting. `busy` is the sole safe
      // retry because it proves that no external effect was admitted.
      this.greetedParticipantIds.add(participantId);
      const outcome = await this.speak(participantId, greeting);
      if (outcome === "busy") {
        const retryCount = (this.retryCounts.get(participantId) ?? 0) + 1;
        this.retryCounts.set(participantId, retryCount);
        this.greetedParticipantIds.delete(participantId);
        if (
          retryCount <= maximumBusyRetries &&
          this.presentParticipantIds.has(participantId)
        ) {
          this.pendingParticipantIds.add(participantId);
        }
        return;
      }
      this.retryCounts.delete(participantId);
      await this.dependencies.configuration.coordinator.whenIdle(
        this.dependencies.meetingId,
      );
    }
  }

  private async speak(
    participantId: string,
    greeting: ResolvedParticipantGreeting,
  ): Promise<string> {
    const retryCount = this.retryCounts.get(participantId) ?? 0;
    const turnId = retryCount === 0
      ? `participant-greeting:${participantId}`
      : `participant-greeting:${participantId}:retry-${retryCount}`;
    try {
      const outcome = await this.dependencies.configuration.coordinator
        .handleProactiveTurn({
          locale: greeting.locale,
          meetingId: this.dependencies.meetingId,
          nowMs: this.nowMilliseconds(),
          prompt: greeting.prompt,
          recordingId: this.dependencies.meetingId,
          speakerId: participantId,
          systemPrompt: exactGreetingSystemPrompt,
          turnId,
          voiceProfileId: this.dependencies.configuration.voiceProfileId,
        });
      this.dependencies.logger.info("Participant greeting admitted", {
        meetingId: this.dependencies.meetingId,
        outcome: outcome.status,
        participantId,
      });
      return outcome.status;
    } catch (error) {
      this.dependencies.logger.warn("Participant greeting failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: this.dependencies.meetingId,
        participantId,
      });
      return "failed";
    }
  }

  private profile(
    participantId: string,
  ): LiveParticipantGreetingProfile | undefined {
    return this.dependencies.configuration.greetings?.profiles[participantId];
  }

  private greeting(
    participantId: string,
  ): ResolvedParticipantGreeting | undefined {
    const greetings = this.dependencies.configuration.greetings;
    if (
      greetings === undefined ||
      greetings.excludedParticipantIds.includes(participantId)
    ) {
      return undefined;
    }
    const profile = this.profile(participantId);
    if (profile === undefined) {
      return greetings.defaultLocale === "ru"
        ? { locale: "ru", prompt: "Привет!" }
        : { locale: "en", prompt: "Hi!" };
    }
    return profile.greetingLocale === "ru"
      ? { locale: "ru", prompt: `Привет, ${profile.spokenName}!` }
      : { locale: "en", prompt: `Hi, ${profile.spokenName}!` };
  }

  /** Re-reads mutable meeting state after asynchronous coordinator settlement. */
  private shouldStopGreeting(participantId: string): boolean {
    return this.closed ||
      this.dependencies.isMeetingFinishing() ||
      !this.presentParticipantIds.has(participantId);
  }

  private nowMilliseconds(): number {
    const value = Math.floor(this.dependencies.configuration.nowMilliseconds());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Greeting observation clock must be a non-negative integer");
    }
    return value;
  }
}
