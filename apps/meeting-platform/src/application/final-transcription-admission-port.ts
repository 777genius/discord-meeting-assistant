import {
  type FinalTranscriptionPort,
  type FinalTranscriptionRequest,
  type GeneratedTranscript,
  type FinalTranscriptionResult,
} from "@discord-meeting/meeting-core/transcription";

type AdmissionRelease = () => void;

interface WaitingAdmission {
  readonly removeAbortListener?: () => void;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (release: AdmissionRelease) => void;
  readonly signal?: AbortSignal;
}

/**
 * Process-local FIFO admission for whole final-transcription meetings.
 *
 * It deliberately wraps only the final-transcription port: summary generation
 * and publication remain available to normal post-call worker concurrency.
 */
export class InProcessFinalTranscriptionAdmissionPort implements FinalTranscriptionPort {
  private readonly waiters: WaitingAdmission[] = [];
  private availableSlots: number;

  public constructor(
    private readonly delegate: FinalTranscriptionPort,
    maximumConcurrentMeetings: number,
  ) {
    if (!Number.isSafeInteger(maximumConcurrentMeetings) || maximumConcurrentMeetings < 1) {
      throw new RangeError("maximumConcurrentMeetings must be a positive integer");
    }
    this.availableSlots = maximumConcurrentMeetings;
  }

  public async transcribe(
    request: FinalTranscriptionRequest,
  ): Promise<FinalTranscriptionResult<GeneratedTranscript>> {
    const release = await this.acquire(request.signal);
    try {
      return await this.delegate.transcribe(request);
    } finally {
      release();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<AdmissionRelease> {
    signal?.throwIfAborted();
    if (this.availableSlots > 0) {
      this.availableSlots -= 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise<AdmissionRelease>((resolve, reject) => {
      if (signal === undefined) {
        this.waiters.push({ reject, resolve });
        return;
      }
      let waiter!: WaitingAdmission;
      const removeWaiter = () => {
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex < 0) {
          return;
        }
        this.waiters.splice(waiterIndex, 1);
        waiter.removeAbortListener?.();
        reject(signal.reason);
      };
      waiter = {
        reject,
        removeAbortListener: () => {
          signal.removeEventListener("abort", removeWaiter);
        },
        resolve,
        signal,
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", removeWaiter, { once: true });
      if (signal.aborted) {
        removeWaiter();
      }
    });
  }

  private releaseOnce(): AdmissionRelease {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.releaseNext();
    };
  }

  private releaseNext(): void {
    for (;;) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.availableSlots += 1;
        return;
      }
      if (waiter.signal?.aborted === true) {
        waiter.removeAbortListener?.();
        waiter.reject(waiter.signal.reason);
        continue;
      }
      waiter.removeAbortListener?.();
      waiter.resolve(this.releaseOnce());
      return;
    }
  }
}
