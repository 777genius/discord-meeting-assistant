import type {
  LiveRuntimeLogger,
  LiveTranscriptionEvent,
  LiveTranscriptionPort,
  LiveTranscriptionSession,
} from "./contracts.js";
import type {
  LiveSessionAdmission,
  LiveSessionRelease,
} from "./live-packet-flow-control.js";

interface SpeakerTranscriptionProviderSessionDependencies {
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly onTranscript: (event: LiveTranscriptionEvent) => void;
  readonly sessionAdmission: LiveSessionAdmission;
  readonly speakerId: string;
  readonly transcriber: LiveTranscriptionPort;
}

/** Owns the provider session, its admission lease and segment identity. */
export class SpeakerTranscriptionProviderSession {
  private openingAbortController: AbortController | null = null;
  private session: LiveTranscriptionSession | null = null;
  private sessionLease: LiveSessionRelease | null = null;

  public constructor(
    private readonly dependencies: SpeakerTranscriptionProviderSessionDependencies,
  ) {}

  public get isOpen(): boolean {
    return this.session !== null;
  }

  public abortOpening(): void {
    this.openingAbortController?.abort();
  }

  public async open(signal: AbortSignal): Promise<LiveTranscriptionSession | null> {
    if (this.session !== null) {
      return this.session;
    }
    const lease = await this.dependencies.sessionAdmission.acquire(signal);
    if (lease === null) {
      return null;
    }
    if (signal.aborted) {
      lease();
      return null;
    }
    this.sessionLease = lease;
    const openingAbortController = new AbortController();
    this.openingAbortController = openingAbortController;
    try {
      const session = await this.dependencies.transcriber.openSession({
        idempotencyKey: [
          "live-transcription:v3",
          this.dependencies.meetingId,
          this.dependencies.speakerId,
        ].join("|"),
        meetingId: this.dependencies.meetingId,
        onTranscript: this.dependencies.onTranscript,
        signal: openingAbortController.signal,
        speakerId: this.dependencies.speakerId,
      });
      if (openingAbortController.signal.aborted || this.sessionLease !== lease) {
        session.terminate();
        this.releaseLease(lease);
        return null;
      }
      this.session = session;
      return session;
    } catch (error) {
      this.releaseLease(lease);
      throw error;
    } finally {
      if (this.openingAbortController === openingAbortController) {
        this.openingAbortController = null;
      }
    }
  }

  public terminate(): void {
    const session = this.session;
    const lease = this.sessionLease;
    this.session = null;
    this.sessionLease = null;
    session?.terminate();
    lease?.();
  }

  public async finalize(failureMessage: string): Promise<void> {
    const session = this.session;
    const lease = this.sessionLease;
    // Finalization still owns the session: a finish deadline must terminate it.
    if (session === null) {
      lease?.();
      return;
    }
    try {
      await session.finalize();
    } catch (error) {
      if (this.session === session) { this.terminate(); }
      this.dependencies.logger.warn(failureMessage, {
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: this.dependencies.meetingId,
        speakerId: this.dependencies.speakerId,
      });
    } finally {
      if (this.session === session) { this.session = null; }
      if (lease !== null) { this.releaseLease(lease); }
    }
  }

  private releaseLease(lease: LiveSessionRelease): void {
    if (this.sessionLease === lease) {
      this.sessionLease = null;
      lease();
    }
  }
}
