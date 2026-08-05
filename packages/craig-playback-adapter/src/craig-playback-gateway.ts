import type { CraigPlaybackCommand, CraigPlaybackEvent } from "@discord-meeting/craig-gateway-contracts";
import type {
  PortResult,
  VoicePlaybackPort,
  VoicePlaybackOpenOptions,
  VoicePlaybackRequest,
  VoicePlaybackSession,
} from "@discord-meeting/meeting-core";

import { CraigVoicePlaybackSession } from "./craig-voice-playback-session.js";
import {
  resolvePlaybackTerminalReceiptTimeoutMs,
} from "./playback-terminal-deadline.js";
import {
  playbackFailure as failure,
  playbackOpenCancelled,
} from "./playback-session-results.js";

export interface CraigPlaybackTransportIdentity {
  readonly channelId: string;
  readonly gatewaySessionId: string;
  readonly guildId: string;
  readonly recordingId: string;
}

export interface CraigPlaybackTransport {
  readonly bufferedBytes: number;
  readonly identity: CraigPlaybackTransportIdentity;

  close(code: number, reason: string): void;
  onClose(listener: (reason: string) => void): void;
  onEvent(listener: (event: CraigPlaybackEvent) => void): void;
  send(command: CraigPlaybackCommand): Promise<void>;
}

export class CraigPlaybackGateway implements VoicePlaybackPort {
  private readonly transports = new Map<string, RegisteredTransport>();

  public constructor(
    private readonly nowMilliseconds: () => number = () => performance.now(),
    private readonly terminalReceiptTimeoutMs = resolvePlaybackTerminalReceiptTimeoutMs(),
  ) {
    resolvePlaybackTerminalReceiptTimeoutMs(terminalReceiptTimeoutMs);
  }

  public register(transport: CraigPlaybackTransport): () => void {
    const existing = this.transports.get(transport.identity.recordingId);
    if (existing !== undefined) {
      existing.disconnect("replaced by a newer Craig playback session");
      existing.transport.close(1008, "recording session replaced");
    }
    const registered = new RegisteredTransport(
      transport,
      this.nowMilliseconds,
      this.terminalReceiptTimeoutMs,
      () => {
      if (this.transports.get(transport.identity.recordingId) === registered) {
        this.transports.delete(transport.identity.recordingId);
      }
      },
    );
    this.transports.set(transport.identity.recordingId, registered);
    transport.onEvent((event) => {
      registered.receive(event);
    });
    transport.onClose((reason) => {
      registered.disconnect(reason);
    });
    return () => {
      registered.disconnect("playback transport detached");
    };
  }

  public async open(
    request: VoicePlaybackRequest,
    options: VoicePlaybackOpenOptions = {},
  ): Promise<PortResult<VoicePlaybackSession>> {
    if (options.signal?.aborted === true) {
      return playbackOpenCancelled();
    }
    const registered = this.transports.get(request.recordingId);
    if (registered === undefined) {
      return failure(
        "CRAIG_PLAYBACK_UNAVAILABLE",
        "Craig playback session is not connected for this recording",
        true,
      );
    }
    return await registered.open(request, options.signal);
  }

  public close(): void {
    for (const registered of this.transports.values()) {
      registered.disconnect("playback gateway closed");
      registered.transport.close(1001, "playback gateway closed");
    }
    this.transports.clear();
  }

  public hasSession(recordingId: string): boolean {
    return this.transports.has(recordingId);
  }
}

class RegisteredTransport {
  private active: CraigVoicePlaybackSession | undefined;
  private disconnected = false;

  public constructor(
    public readonly transport: CraigPlaybackTransport,
    private readonly nowMilliseconds: () => number,
    private readonly terminalReceiptTimeoutMs: number,
    private readonly onDisconnected: () => void,
  ) {}

  public async open(
    request: VoicePlaybackRequest,
    signal?: AbortSignal,
  ): Promise<PortResult<VoicePlaybackSession>> {
    if (this.disconnected) {
      return failure(
        "CRAIG_PLAYBACK_DISCONNECTED",
        "Craig playback transport is disconnected",
        true,
      );
    }
    if (this.active !== undefined) {
      return failure(
        "CRAIG_PLAYBACK_BUSY",
        "Craig is already playing a conversation turn for this recording",
        true,
      );
    }
    const session = new CraigVoicePlaybackSession({
      request,
      transport: this.transport,
      nowMilliseconds: this.nowMilliseconds,
      terminalReceiptTimeoutMs: this.terminalReceiptTimeoutMs,
      onTerminal: () => {
        if (this.active === session) {
          this.active = undefined;
        }
      },
      onTerminalTimeout: () => {
        this.disconnect("playback terminal receipt timed out");
        this.transport.close(1011, "playback terminal receipt timed out");
      },
    });
    this.active = session;
    const started = await session.start(signal);
    if (!started.ok) {
      this.active = undefined;
      return started;
    }
    return { ok: true, value: session };
  }

  public receive(event: CraigPlaybackEvent): void {
    if (event.type === "session-ready") {
      this.disconnect("duplicate session-ready event");
      this.transport.close(1008, "duplicate session-ready event");
      return;
    }
    this.active?.receive(event);
  }

  public disconnect(reason: string): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.active?.transportDisconnected(reason);
    this.active = undefined;
    this.onDisconnected();
  }
}
