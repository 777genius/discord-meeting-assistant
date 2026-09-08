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
  fencedDurably?: boolean;
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
  private durabilityPending = 0;
  private persistenceFailure: Error | undefined;
  private fenced = false;

  public constructor(private readonly dependencies: AttemptDependencies) {}

  public async settle(): Promise<void> {
    if (this.durabilityPending > 0 || (this.pending.size > 0 && this.current?.fencedDurably !== true)) { throw new LiveTranscriptionAcceptanceUnknown(); }
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
    const abort = (): void => { this.abandon(owned); };
    request.signal?.addEventListener("abort", abort, { once: true });
    this.dependencies.signal.addEventListener("abort", abort, { once: true });
    try {
      owned.provider = await this.dependencies.transcriber.openSession({
        ...request,
        idempotencyKey: JSON.stringify(["live-transcription:v4", request.meetingId, request.speakerId, operation.session.generation]),
        onTranscript: (event) => {
          if (this.current === owned && !owned.clean && !owned.abandoned && !this.cancelled() && !this.openingCancelled(request.signal)) { request.onTranscript(event); }
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
    } finally {
      request.signal?.removeEventListener("abort", abort);
      this.dependencies.signal.removeEventListener("abort", abort);
    }
  }

  private wrap(owned: OwnedSession): LiveTranscriptionSession {
    return {
      sendPacket: (packet) => this.supervise(this.send(owned, packet)),
      finalize: () => this.supervise(this.finalize(owned)),
      terminate: () => { this.abandon(owned); },
    };
  }

  private abandon(owned: OwnedSession): void {
    if (owned.clean || owned.abandoned) { owned.provider?.terminate(); return; }
    owned.abandoned = true;
    this.latch(new LiveTranscriptionAcceptanceUnknown());
    void this.persist(() => this.dependencies.durability.fence(owned.identity, "acceptance-unknown"))
      .then(() => { owned.fencedDurably = true; return undefined; })
      .catch(() => {});
    owned.provider?.terminate();
  }

  private async send(owned: OwnedSession, packet: Parameters<LiveTranscriptionSession["sendPacket"]>[0]): Promise<"accepted" | "reused"> {
    this.assertOwned(owned);
    const grant = await this.persist(() => this.dependencies.durability.beginSend(owned.identity, packet.packetId));
    if (grant.status === "already-accepted") { return "reused"; }
    const operation = this.requireGrant(grant, "send");
    if (owned.abandoned) { throw new LiveTranscriptionAcceptanceUnknown(); }
    if (this.cancelled()) {
      await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "not-accepted" }));
      throw new LiveTranscriptionNotAccepted();
    }
    try {
      await owned.provider!.sendPacket(packet);
    } catch (error) {
      await this.failed(owned, operation, error);
      throw error instanceof LiveTranscriptionNotAccepted ? error : this.classify(error);
    }
    this.assertOwned(owned);
    // Only the still-owned generation can publish an outcome.
    await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "accepted" }));
    this.assertOwned(owned);
    return "accepted";
  }

  private async finalize(owned: OwnedSession): Promise<void> {
    this.assertOwned(owned);
    const operation = this.requireGrant(await this.persist(() => this.dependencies.durability.beginFinalize(owned.identity)), "finalize");
    if (owned.abandoned) { throw new LiveTranscriptionAcceptanceUnknown(); }
    if (this.cancelled()) {
      await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "not-accepted" }));
      throw new LiveTranscriptionAcceptanceUnknown();
    }
    try { await owned.provider!.finalize(); }
    catch (error) {
      await this.failed(owned, operation, error);
      throw this.classify(error);
    }
    this.assertOwned(owned);
    owned.clean = true;
    await this.persist(() => this.dependencies.durability.complete({ operation, outcome: "finalized" }));
  }

  private async failed(owned: OwnedSession, operation: LiveOperation, error: unknown): Promise<void> {
    if (owned.abandoned) { return; }
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
    owned.fencedDurably = true;
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
    this.durabilityPending += 1;
    try { return await work(); }
    catch (error) {
      this.persistenceFailure = error instanceof Error
        ? error : new LiveSttDurabilityUnavailable({ cause: error });
      this.latch(new LiveTranscriptionAcceptanceUnknown());
      this.current?.provider?.terminate();
      throw error;
    } finally { this.durabilityPending -= 1; }
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
