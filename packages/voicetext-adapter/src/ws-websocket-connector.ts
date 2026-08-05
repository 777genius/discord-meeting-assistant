import type { IncomingMessage } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { WebSocket as WsClient, type RawData } from "ws";

import { VoicetextTransportError } from "./errors.js";
import type {
  VoicetextInboundFrame,
  VoicetextWebSocketConnection,
  VoicetextWebSocketConnector,
  VoicetextWebSocketConnectRequest,
} from "./websocket-connector.js";

const maximumQueuedInboundFrames = 64;
const closeHandshakeTimeoutMs = 1_000;

export class WsVoicetextWebSocketConnector implements VoicetextWebSocketConnector {
  public async connect(
    request: VoicetextWebSocketConnectRequest,
  ): Promise<VoicetextWebSocketConnection> {
    request.signal.throwIfAborted();
    const socket = new WsClient(request.endpoint, {
      followRedirects: false,
      handshakeTimeout: request.handshakeTimeoutMs,
      headers: { Authorization: request.authorization },
      maxPayload: request.maxInboundFrameBytes,
      perMessageDeflate: false,
    });

    await waitForOpen(socket, request.signal);
    return new WsConnection(socket, request.maxInboundFrameBytes);
  }
}

class WsConnection implements VoicetextWebSocketConnection {
  private readonly inbound: Array<Error | VoicetextInboundFrame> = [];
  private waiter: {
    readonly reject: (error: unknown) => void;
    readonly resolve: (frame: VoicetextInboundFrame) => void;
  } | undefined;

  public constructor(
    private readonly socket: WsClient,
    private readonly maxInboundFrameBytes: number,
  ) {
    socket.on("message", (data, isBinary) => {
      const bytes = rawDataBytes(data);
      if (bytes.byteLength > this.maxInboundFrameBytes) {
        this.push(new VoicetextTransportError("closed", "Voicetext inbound frame exceeded the configured bound", { closeCode: 1_009 }));
        socket.terminate();
        return;
      }
      this.push(isBinary
        ? { data: Uint8Array.from(bytes), type: "binary" }
        : { data: bytes.toString("utf8"), type: "text" });
    });
    socket.on("close", (code, reason) => {
      this.push({ code, reason: reason.toString("utf8"), type: "close" });
    });
    socket.on("error", (error) => {
      this.push(new VoicetextTransportError("network", "Voicetext WebSocket transport error", {}, { cause: error }));
    });
  }

  public async sendText(data: string, signal: AbortSignal): Promise<void> {
    await this.send(data, false, signal);
  }

  public async sendBinary(data: Uint8Array, signal: AbortSignal): Promise<void> {
    await this.send(data, true, signal);
  }

  public async receive(signal: AbortSignal): Promise<VoicetextInboundFrame> {
    signal.throwIfAborted();
    if (this.waiter !== undefined) {
      throw new VoicetextTransportError("network", "Concurrent Voicetext receives are not supported");
    }
    const queued = this.inbound.shift();
    if (queued !== undefined) {
      if (queued instanceof Error) {
        throw queued;
      }
      return queued;
    }

    return await new Promise<VoicetextInboundFrame>((resolve, reject) => {
      const onAbort = () => {
        this.waiter = undefined;
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiter = {
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
        resolve: (frame) => {
          signal.removeEventListener("abort", onAbort);
          resolve(frame);
        },
      };
    });
  }

  public async close(code: number, reason: string): Promise<void> {
    if (this.socket.readyState === WsClient.CLOSED) {
      return;
    }
    const closed = once(this.socket, "close").then(() => true);
    const timedOut = delay(closeHandshakeTimeoutMs).then(() => false);
    this.socket.close(code, reason);
    if (!await Promise.race([closed, timedOut])) {
      this.socket.terminate();
    }
  }

  public terminate(): void {
    this.socket.terminate();
  }

  private async send(
    data: string | Uint8Array,
    binary: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.socket.readyState !== WsClient.OPEN) {
      throw new VoicetextTransportError("closed", "Voicetext WebSocket is not open");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.socket.terminate();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.socket.send(data, { binary }, (error: Error | null | undefined) => {
        signal.removeEventListener("abort", onAbort);
        // Node's writable callback convention permits null on success even though
        // @types/ws currently models only undefined here.
        if (error === undefined || error === null) {
          resolve();
        } else {
          reject(new VoicetextTransportError("network", "Voicetext WebSocket send failed", {}, { cause: error }));
        }
      });
    });
  }

  private push(item: Error | VoicetextInboundFrame): void {
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      if (item instanceof Error) {
        waiter.reject(item);
      } else {
        waiter.resolve(item);
      }
      return;
    }
    if (this.inbound.length >= maximumQueuedInboundFrames) {
      this.socket.terminate();
      this.inbound.splice(0, this.inbound.length, new VoicetextTransportError("closed", "Voicetext inbound queue exceeded its bound", { closeCode: 1_009 }));
      return;
    }
    this.inbound.push(item);
  }
}

async function waitForOpen(socket: WsClient, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpectedResponse);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onAbort = () => {
      // ws reports termination during CONNECTING as an asynchronous `error`.
      // `finish` removes the handshake listener, so retain one bounded absorber
      // for that expected cancellation error before terminating.
      socket.once("error", ignoreExpectedAbortError);
      finish(signal.reason);
      socket.terminate();
    };
    const onOpen = () => {
      finish();
    };
    const onError = (error: Error) => {
      finish(new VoicetextTransportError("network", "Voicetext WebSocket connection failed", {}, { cause: error }));
    };
    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
      response.resume();
      socket.terminate();
      finish(new VoicetextTransportError(
        "handshake",
        `Voicetext WebSocket handshake returned HTTP ${response.statusCode ?? "unknown"}`,
        response.statusCode === undefined ? {} : { status: response.statusCode },
      ));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("unexpected-response", onUnexpectedResponse);
  });
}

function ignoreExpectedAbortError(): void {
  // The abort reason is already returned to the caller by waitForOpen.
}

function rawDataBytes(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
