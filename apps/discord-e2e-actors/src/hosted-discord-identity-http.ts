export interface DiscordBotJsonClient {
  get(path: string, botToken: string, signal?: AbortSignal): Promise<unknown>;
}

interface DiscordFetchResponse {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: Headers;
  readonly status: number;
}

export type DiscordFetch = (
  input: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly redirect: "manual"; readonly signal: AbortSignal },
) => Promise<DiscordFetchResponse>;

const apiOrigin = "https://discord.com";
const apiPrefix = "/api/v10";

export class BoundedDiscordBotJsonClient implements DiscordBotJsonClient {
  public constructor(
    private readonly fetchResponse: DiscordFetch = globalThis.fetch,
    private readonly timeoutMs = 5_000,
    private readonly maximumBodyBytes = 16_384,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || !Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1) {
      throw new Error("Discord REST bounds must be positive safe integers");
    }
  }

  public async get(path: string, botToken: string, signal?: AbortSignal): Promise<unknown> {
    assertSafeDiscordPath(path);
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(this.timeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    requestSignal.throwIfAborted();
    const response = await this.fetchResponse(`${apiOrigin}${apiPrefix}${path}`, {
      headers: { accept: "application/json", authorization: `Bot ${botToken}` },
      redirect: "manual",
      signal: requestSignal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Discord REST redirects are forbidden");
    }
    if (response.status !== 200) {
      throw new Error(`Discord REST request failed with status ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new Error("Discord REST response is not JSON");
    }
    const body = await readBoundedBody(response.body, this.maximumBodyBytes, requestSignal);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new Error("Discord REST response contains invalid JSON");
    }
  }
}

function assertSafeDiscordPath(path: string): void {
  if (!/^\/(?:users\/@me|guilds\/\d{17,20}|channels\/\d{17,20})$/u.test(path)) {
    throw new Error("Discord REST path is outside the identity probe allowlist");
  }
}

async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  maximumBodyBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (stream === null) {throw new Error("Discord REST response body is missing");}
  const reader = stream.getReader();
  const abort = (): void => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {break;}
      total += value.byteLength;
      if (total > maximumBodyBytes) {throw new Error("Discord REST response body exceeds its limit");}
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => null);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {body.set(chunk, offset); offset += chunk.byteLength;}
  return body;
}
