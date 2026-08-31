import { startDisposableInfinityHttpService } from
  "@discord-meeting/infinity-context-adapter/test-support";
import { expect } from "vitest";

import type { PlatformHistoricalMemoryRuntime } from
  "../src/composition/historical-memory.js";
import type { PlatformConfig } from "../src/config.js";
import { allowOnlySyntheticRoom, currentActor, currentMeetingId,
  historicalActorA, historicalActorB } from
  "./meeting-knowledge-production-composition-fixtures.js";

type InfinityService = Awaited<ReturnType<typeof startDisposableInfinityHttpService>>;

export async function proveActorScopedRetrievalRequest(input: {
  readonly authorization: ReturnType<typeof allowOnlySyntheticRoom>;
  readonly infinity: InfinityService;
  readonly providerBinding: NonNullable<
    NonNullable<PlatformConfig["meetingKnowledge"]>["retrievalV2ProviderBinding"]
  >;
  readonly roomId: string;
  readonly runtime: PlatformHistoricalMemoryRuntime;
  readonly scopeId: string;
  readonly signal: AbortSignal;
}): Promise<number> {
  const requestIndex = retrievalRequests(input.infinity).length;
  const request = await input.runtime
    .createRetrievalV2Admission(input.providerBinding)
    .prepare({
      currentMeetingId,
      question: `What did <@${historicalActorA}> Vlad record about PINE-GOLF?`,
      roomId: input.roomId,
      scopeId: input.scopeId,
      signal: input.signal,
    });
  if (request.status !== "prepared") {
    throw new Error("actor-scoped Retrieval V2 request was not admitted");
  }
  await input.runtime.createFocusedLocatorRetrievalV2(input.authorization)
    .retrieveEvidence({
      authorizationPrincipalRef: "synthetic-principal",
      currentMeetingId,
      request,
      roomId: input.roomId,
      scopeId: input.scopeId,
      signal: input.signal,
    });
  expect(retrievalRequests(input.infinity)).toHaveLength(requestIndex + 1);
  return requestIndex;
}

export function assertRetrievalRequestPrivacy(
  infinity: InfinityService,
  actorScopedRequestIndex: number,
): number {
  const requests = retrievalRequests(infinity);
  expect(requests.length).toBeGreaterThanOrEqual(2);
  const projectedActorKeys = infinity.endpoint.requests
    .filter(({ path }) => path === "/v1/documents")
    .flatMap(({ body }) => (body as null | { readonly retrieval_projection?: {
      readonly actor_keys?: readonly string[] } })
      ?.retrieval_projection?.actor_keys ?? []);
  for (const [index, request] of requests.entries()) {
    const actorKeys = (request.body as null | { readonly filters?: {
      readonly actor_keys?: readonly string[] } })?.filters?.actor_keys;
    if (index === actorScopedRequestIndex) {
      expect(actorKeys).toHaveLength(2);
      expect(actorKeys).toEqual([
        expect.stringMatching(/^dactor1\.synthetic-r0\.[A-Za-z0-9_-]{43}$/u),
        expect.stringMatching(/^dactor1\.synthetic-r1\.[A-Za-z0-9_-]{43}$/u),
      ]);
      expect(actorKeys?.map((key) => key.split(".")[1])).toEqual([
        "synthetic-r0",
        "synthetic-r1",
      ]);
      expect(projectedActorKeys).toEqual(expect.arrayContaining(
        actorKeys?.filter((key) => key.startsWith("dactor1.synthetic-r1.")) ?? [],
      ));
    } else {
      expect(actorKeys === undefined || actorKeys.length === 0).toBe(true);
    }
    assertProviderRequestContainsNoPrivateDiscordData(JSON.stringify(request.body));
  }
  const exactRetrievalBodies = infinity.endpoint.exactHttpRequests
    .filter(({ path }) => path === "/v1/context/retrieve")
    .map(({ bodyBytes }) => new TextDecoder().decode(bodyBytes));
  expect(exactRetrievalBodies).toHaveLength(requests.length);
  for (const [index, body] of exactRetrievalBodies.entries()) {
    assertProviderRequestContainsNoPrivateDiscordData(body);
    if (index !== actorScopedRequestIndex) {
      expect(body).toMatch(/anchor.*pine-golf/u);
    }
  }
  return requests.length;
}

function retrievalRequests(infinity: InfinityService) {
  return infinity.endpoint.requests.filter(
    ({ path }) => path === "/v1/context/retrieve",
  );
}

function assertProviderRequestContainsNoPrivateDiscordData(body: string): void {
  expect(body).not.toMatch(new RegExp([
    currentActor, historicalActorA, historicalActorB,
    "Alice Smith", "Alice", "Vlad", "Vladimir", "Ｖｌａｄ", "𝐕𝐥𝐚𝐝", "🔥",
    "Boba", "Hopa",
    // Discord question identity and locally held credentials are raw secrets,
    // not provider query intent.
    "777777777777777701", "synthetic-secret", "synthetic-principal", "a{64}",
  ].join("|"), "iu"));
}
