import type {
  FocusedRetrievalScopeResolutionEffects,
  FocusedRetrievalScopeResolutionPort,
} from "./ports/focused-locator-retrieval-v2.js";

export async function resolveFocusedRetrievalScope(
  scopeResolution: FocusedRetrievalScopeResolutionPort | undefined,
  input: {
    readonly scopeResolutionEffects?: FocusedRetrievalScopeResolutionEffects;
    readonly signal?: AbortSignal;
  },
  topology: { readonly spaceSlug: string; readonly roomScopeExternalRef: string },
) {
  let scope;
  try { scope = await scopeResolution?.resolve({
    ...(input.scopeResolutionEffects === undefined ? {} : { effects: input.scopeResolutionEffects }),
    spaceSlug: topology.spaceSlug,
    roomScopeExternalRef: topology.roomScopeExternalRef,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }); } catch {
    input.signal?.throwIfAborted();
    return null;
  }
  input.signal?.throwIfAborted();
  if (scope?.status !== "resolved" || !validResolvedId(scope.spaceId) ||
    !validResolvedId(scope.memoryScopeId)) {
    return null;
  }
  return scope;
}

function validResolvedId(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(value);
}
