import {
  LiveSttDurabilityConflict, LiveSttDurabilityUnavailable, LiveTranscriptionAcceptanceUnknown,
  LiveTranscriptionAdmissionRejected, LiveTranscriptionNotAccepted, LiveTranscriptionTerminalFailure,
  type LiveDenied, type LiveFenceReason, type LiveGrant, type LiveOperation, type LiveSessionOwner,
  type LiveSttDurabilityPort, type LiveTranscriptionPort, type LiveTranscriptionSession,
} from "./contracts.js";

interface AttemptDependencies {
  readonly durability: LiveSttDurabilityPort;
  readonly onFailure: (error: unknown) => boolean;
  readonly signal: AbortSignal;
  readonly transcriber: LiveTranscriptionPort;
}
interface OwnedSession {
  readonly identity: LiveSessionOwner;
  provider?: LiveTranscriptionSession;
  clean: boolean;
  abandoned: boolean;
}
function failureReason(error: unknown): LiveFenceReason {
  if (error instanceof LiveTranscriptionAdmissionRejected) { return "admission-rejected"; }
  if (error instanceof LiveTranscriptionTerminalFailure) { return "provider-terminal"; }
  return "acceptance-unknown";
}
function rejectionError(result: LiveDenied): Error {
  if (result.status === "fenced" && result.reason === "admission-rejected") { return new LiveTranscriptionAdmissionRejected(); }
  if (result.status === "fenced" && result.reason === "provider-terminal") { return new LiveTranscriptionTerminalFailure(); }
  return new LiveTranscriptionAcceptanceUnknown();
}

/** One speaker's write-ahead effects. Pending persistence remains supervised after cancellation. */
export class LiveSttAttemptController implements LiveTranscriptionPort {
  private current: OwnedSession | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private persistenceFailure: unknown;
  private fenced = false;

  public constructor(private readonly dependencies: AttemptDependencies) {}

  public async settle(): Promise<void> {
    if (this.pending.size > 0) { throw new LiveTranscriptionAcceptanceUnknown(); }
    if (this.persistenceFailure !== undefined) { throw this.persistenceFailure; }
  }

  public openSession(request: Parameters<LiveTranscriptionPort["openSession"]>[0]): Promise<LiveTranscriptionSession> {
    return this.supervise(this.open(request));
  }

  private async open(request: Parameters<LiveTranscriptionPort["openSession"]>[0]): Promise<LiveTranscriptionSession> {
    const recovery = await this.persist(() => this.dependencies.durability.recoverRecording(request.meetingId));
    this.assertActive();
    const operation = this.requireGrant(await this.persist(() =>
      this.dependencies.durability.beginOpen(recovery.owner, request.speakerId)), "open");
    const owned: OwnedSession = { identity: operation.session, clean: false, abandoned: false };
    this.current = owned;
    if (this.cancelled() || this.openingCancelled(request.signal)) {
      await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "not-accepted" }));
      owned.clean = true;
      throw new LiveTranscriptionNotAccepted();
    }
    try {
      owned.provider = await this.dependencies.transcriber.openSession({
        ...request,
        idempotencyKey: JSON.stringify(["live-transcription:v4", request.meetingId, request.speakerId, operation.session.generation]),
        onTranscript: (event) => {
          if (this.current === owned && !owned.abandoned && !this.cancelled()) { request.onTranscript(event); }
        },
      });
      if (this.cancelled() || this.openingCancelled(request.signal) || owned.abandoned) {
        owned.provider.terminate();
        throw new LiveTranscriptionAcceptanceUnknown();
      }
      await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "opened" }));
      this.assertActive();
      return this.wrap(owned);
    } catch (error) {
      await this.failed(owned, operation, error);
      throw error;
    }
  }

  private wrap(owned: OwnedSession): LiveTranscriptionSession {
    return {
      sendPacket: (packet) => this.supervise(this.send(owned, packet)),
      finalize: () => this.supervise(this.finalize(owned)),
      terminate: () => {
        owned.provider?.terminate();
        if (owned.clean || owned.abandoned) { return; }
        owned.abandoned = true;
        this.latch(new LiveTranscriptionAcceptanceUnknown());
        void this.supervise(this.persist(() => this.dependencies.durability.fence(owned.identity, "acceptance-unknown")))
          .catch(() => {});
      },
    };
  }

  private async send(owned: OwnedSession, packet: Parameters<LiveTranscriptionSession["sendPacket"]>[0]): Promise<"accepted" | "reused"> {
    this.assertOwned(owned);
    const grant = await this.persist(() => this.dependencies.durability.beginSend(owned.identity, packet.packetId));
    if (grant.status === "already-accepted") { return "reused"; }
    const operation = this.requireGrant(grant, "send");
    if (this.cancelled() || owned.abandoned) {
      await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "not-accepted" }));
      throw new LiveTranscriptionNotAccepted();
    }
    try {
      await owned.provider!.sendPacket(packet);
    } catch (error) {
      await this.failed(owned, operation, error);
      throw error instanceof LiveTranscriptionNotAccepted ? error : this.classify(error);
    }
    // Acceptance remains evidence even if a terminal callback raced the receipt.
    await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "accepted" }));
    this.assertOwned(owned);
    return "accepted";
  }

  private async finalize(owned: OwnedSession): Promise<void> {
    this.assertOwned(owned);
    const operation = this.requireGrant(await this.persist(() => this.dependencies.durability.beginFinalize(owned.identity)), "finalize");
    if (this.cancelled() || owned.abandoned) {
      await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "not-accepted" }));
      throw new LiveTranscriptionAcceptanceUnknown();
    }
    try { await owned.provider!.finalize(); }
    catch (error) {
      await this.failed(owned, operation, error);
      throw this.classify(error);
    }
    await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "finalized" }));
    this.assertOwned(owned);
    owned.clean = true;
  }

  private async failed(owned: OwnedSession, operation: LiveOperation, error: unknown): Promise<void> {
    owned.abandoned = true;
    owned.provider?.terminate();
    if (this.persistenceFailure !== undefined || error instanceof LiveSttDurabilityUnavailable || error instanceof LiveSttDurabilityConflict) { return; }
    if (error instanceof LiveTranscriptionNotAccepted && !this.fenced) {
      await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "not-accepted" }));
      owned.clean = true;
      return;
    }
    this.latch(this.classify(error));
    await this.persist(() => this.dependencies.durability.complete({ operation, outcome: failureReason(error) }));
  }

  private requireGrant<K extends LiveOperation["kind"]>(result: LiveGrant | LiveDenied, kind: K): Extract<LiveOperation, { kind: K }> {
    if (result.status !== "granted") { const error = rejectionError(result); this.latch(error); throw error; }
    if (result.operation.kind !== kind) { throw new LiveSttDurabilityConflict(); }
    return result.operation as Extract<LiveOperation, { kind: K }>;
  }
  private classify(error: unknown): Error {
    return error instanceof LiveTranscriptionAdmissionRejected || error instanceof LiveTranscriptionTerminalFailure
      ? error : new LiveTranscriptionAcceptanceUnknown();
  }
  private latch(error: unknown): void { this.fenced = true; this.dependencies.onFailure(error); }
  private openingCancelled(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
  private cancelled(): boolean { return this.fenced || this.dependencies.signal.aborted; }
  private assertActive(): void { if (this.cancelled()) { throw new LiveTranscriptionAcceptanceUnknown(); } }
  private assertOwned(owned: OwnedSession): void {
    this.assertActive();
    if (this.current !== owned || owned.abandoned || owned.clean) { throw new LiveTranscriptionAcceptanceUnknown(); }
  }
  private supervise<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => {});
    return work;
  }
  private async persist<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      this.persistenceFailure = error;
      this.latch(new LiveTranscriptionAcceptanceUnknown());
      this.current?.provider?.terminate();
      throw error;
    }
  }
}

/** Cancellation releases a waiter; the attempt controller still supervises its effects. */
export async function awaitLiveCancellation(work: Promise<void>, signal: AbortSignal): Promise<void> {
  let onAbort!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { resolve(); }
  });
  try { await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
