import type { Readable } from "node:stream";

export function waitForConversationVoiceTurnIdWhileGuardingAudio(input: {
  readonly isPacketAudible: (packet: Uint8Array) => boolean;
  readonly resolveTurnId: (signal: AbortSignal) => Promise<string>;
  readonly stream: Readable;
}): Promise<string> {
  if (input.stream.destroyed || input.stream.readableEnded) {
    return Promise.reject(new Error(
      "Configured Craig audio stream closed before runtime turn correlation",
    ));
  }
  return new Promise<string>((resolve, reject) => {
    const cancellation = new AbortController();
    let settled = false;
    const cleanup = (): void => {
      input.stream.pause();
      input.stream.off("data", onData);
      input.stream.off("end", onEnd);
      input.stream.off("error", onError);
    };
    const succeed = (turnId: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(turnId);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      cancellation.abort();
      reject(error);
    };
    const onData = (chunk: unknown): void => {
      try {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("Configured Craig audio stream emitted a non-binary packet");
        }
        if (input.isPacketAudible(chunk)) {
          throw new Error(
            "Configured Craig emitted audible audio before runtime turn correlation was confirmed",
          );
        }
      } catch (error: unknown) {
        fail(error);
      }
    };
    const onEnd = (): void => {
      fail(new Error("Configured Craig audio stream ended before runtime turn correlation"));
    };
    const onError = (error: unknown): void => {
      fail(new Error(
        "Configured Craig audio stream failed before runtime turn correlation",
        { cause: error },
      ));
    };
    input.stream.pause();
    input.stream.once("end", onEnd);
    input.stream.once("error", onError);
    input.stream.on("data", onData);
    input.stream.resume();
    void Promise.resolve()
      .then(() => input.resolveTurnId(cancellation.signal))
      .then(succeed, fail);
  });
}
