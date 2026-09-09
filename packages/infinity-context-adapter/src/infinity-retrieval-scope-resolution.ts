import { createHash } from "node:crypto";
import { FetchTransport, InfinityContextClient, type HttpTransport } from "@infinity-context/sdk";
import type { FocusedRetrievalScopeResolutionPort } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import type { InfinityContextRetrievalV2Config } from "./infinity-context-retrieval-v2.js";

const collectionLimit = 100;
const metadataByteLimit = 65_536;
const preparationBudgetMs = 500;

/** SDK 0.2.4 exposes limit but no cursor or total. A full page cannot prove uniqueness. */
export class InfinityRetrievalScopeResolution implements FocusedRetrievalScopeResolutionPort {
  readonly #resolved = new WeakMap<object, string>();

  public matches(input: Parameters<FocusedRetrievalScopeResolutionPort["matches"]>[0]): boolean {
    return input.request.scope.spaceId === input.spaceId &&
      input.request.scope.memoryScopeId === input.memoryScopeId &&
      this.#resolved.get(input.request) ===
      JSON.stringify([input.spaceSlug, input.roomScopeExternalRef,
        input.spaceId, input.memoryScopeId]);
  }

  public constructor(private readonly config: InfinityContextRetrievalV2Config) {}

  public async resolve(input: Parameters<FocusedRetrievalScopeResolutionPort["resolve"]>[0]) {
    const controller = new AbortController();
    const abort = () => { controller.abort(input.signal?.reason); };
    if (input.signal?.aborted === true) { abort(); }
    else { input.signal?.addEventListener("abort", abort, { once: true }); }
    const timer = setTimeout(() => { controller.abort(new DOMException("Scope preparation expired", "TimeoutError")); },
      Math.min(preparationBudgetMs, this.config.operationTimeoutMs));
    const signal = controller.signal;
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(signal.reason); };
      if (signal.aborted) { onAbort(); }
      else { signal.addEventListener("abort", onAbort, { once: true }); }
    });
    try {
      return await Promise.race([this.read({ ...input }, signal), cancelled]);
    } catch {
      return { status: "unavailable" as const };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async read(input: Parameters<FocusedRetrievalScopeResolutionPort["resolve"]>[0], signal: AbortSignal) {
    const delegate = this.config.transport ?? new FetchTransport();
    let ordinal = 0;
    const transport: HttpTransport = { send: async (request) => {
      signal.throwIfAborted();
      const kind = ordinal++ === 0 ? "scope_spaces" : "scope_memory_scopes";
      if (ordinal > 2 || request.method !== "GET") { throw new Error("Invalid scope read"); }
      const requestSha256 = hash(`${request.method} ${request.url.pathname}${request.url.search}`);
      await input.effects?.beforeRead({ kind, requestSha256 });
      signal.throwIfAborted();
      let response;
      try {
        response = await delegate.send({ ...request, signal,
          maxResponseBytes: metadataByteLimit, maxErrorResponseBytes: metadataByteLimit });
        signal.throwIfAborted();
        const bytes = typeof response.body === "string" ? new TextEncoder().encode(response.body) : response.body;
        if (bytes.byteLength > metadataByteLimit) { throw new Error("Scope metadata overflow"); }
        await input.effects?.observe({ kind, requestSha256, responseSha256: hash(bytes),
          responseBytes: bytes.byteLength, status: "received" });
      } catch (error) {
        if (!signal.aborted) {
          await input.effects?.observe({ kind, requestSha256, responseSha256: null,
            responseBytes: 0, status: "failed" });
        }
        throw error;
      }
      signal.throwIfAborted();
      return response;
    } };
    const client = new InfinityContextClient({ baseUrl: this.config.baseUrl,
      retryPolicy: { maxAttempts: 1 }, timeoutMs: Math.min(preparationBudgetMs, this.config.requestTimeoutMs),
      ...(this.config.token === undefined ? {} : { token: this.config.token }), transport });
    signal.throwIfAborted();
    const spaces = await client.spaces.listSpaces({ limit: collectionLimit, signal });
    const space = unique(spaces, "slug", input.spaceSlug);
    if (space === null || !validId(space.id)) { return { status: "unavailable" as const }; }
    signal.throwIfAborted();
    const scopes = await client.spaces.listMemoryScopes({ spaceId: space.id, limit: collectionLimit, signal });
    const scope = unique(scopes, "external_ref", input.roomScopeExternalRef);
    if (scope === null || !validId(scope.id) || scope.space_id !== space.id) {
      return { status: "unavailable" as const };
    }
    signal.throwIfAborted();
    const authority = JSON.stringify([input.spaceSlug, input.roomScopeExternalRef, space.id, scope.id]);
    let bound = false;
    return Object.freeze({ status: "resolved" as const, spaceId: space.id, memoryScopeId: scope.id,
      bind: (request: Parameters<FocusedRetrievalScopeResolutionPort["matches"]>[0]["request"]) => {
        if (bound || this.#resolved.has(request) || !Object.isFrozen(request) || !Object.isFrozen(request.scope) ||
          request.scope.spaceId !== space.id || request.scope.memoryScopeId !== scope.id) {
          throw new Error("Invalid request scope binding");
        }
        bound = true;
        this.#resolved.set(request, authority);
      },
    });
  }
}

function unique(envelope: unknown, key: string, expected: string): Record<string, unknown> | null {
  if (typeof envelope !== "object" || envelope === null ||
    Object.keys(envelope).some((field) => field !== "data")) { return null; }
  const rows = (envelope as { data?: unknown }).data;
  if (!Array.isArray(rows) || rows.length >= collectionLimit || rows.some((row: unknown) =>
    typeof row !== "object" || row === null)) { return null; }
  const matches = (rows as Record<string, unknown>[]).filter((row) => row[key] === expected);
  return matches.length === 1 ? matches[0]! : null;
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(value);
}
function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
