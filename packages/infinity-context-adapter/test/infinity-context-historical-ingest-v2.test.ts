import { describe, expect, it } from "vitest";

import {
  buildHistoricalIndexPlan,
  historicalEmbeddingTokenProfile,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  HmacHistoricalOpaqueIds,
  InfinityContextHistoricalMemoryAdapter,
  PinnedMultilingualMiniLmTokenizer,
} from "../src/index.js";
import { DisposableInfinityEndpoint } from "./disposable-infinity-endpoint.js";
import { finalMeeting } from "./historical-e2e-test-kit.js";

const tokenizer = new PinnedMultilingualMiniLmTokenizer();

function adapter(endpoint: DisposableInfinityEndpoint) {
  return new InfinityContextHistoricalMemoryAdapter({
    actorKeys: {
      activeActorKey: (actorId) => ({
        "123456789012345671": "dactor1.r1.actor-z",
        "123456789012345672": "dactor1.r1.actor-a-umlaut",
        "123456789012345673": "dactor1.r1.actor-Z",
      })[actorId] ?? (() => { throw new Error("unknown Discord actor"); })(),
    },
    baseUrl: "http://disposable.infinity.invalid",
    embeddingTokenProfile: () => historicalEmbeddingTokenProfile(tokenizer),
    requestTimeoutMs: 1_000,
    schemaVersion: 1,
    transport: endpoint,
  });
}

function fixture() {
  const plan = buildHistoricalIndexPlan(
    finalMeeting(1, "Tuesday"),
    new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x72)),
    undefined,
    tokenizer,
  );
  const original = plan.documents[0]!;
  const source = original.manifest.turnSources[0]!;
  const speakers = [
    "123456789012345671",
    "123456789012345672",
    "123456789012345673",
    "123456789012345672",
  ];
  const document = Object.freeze({
    ...original,
    manifest: Object.freeze({
      ...original.manifest,
      turnSources: Object.freeze(speakers.map((speakerId, index) => Object.freeze({
        ...source,
        sourceRef: `${source.sourceRef}-${index}`,
        speakerId,
      }))),
    }),
  });
  return Object.freeze({ ...plan, documents: Object.freeze([document]) });
}

describe("Infinity Context historical Retrieval V2 projection ingest", () => {
  it("sends the exact official SDK V2 wire projection and preserves source refs", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const plan = fixture();

    await expect(adapter(endpoint).indexFinalMeeting(plan)).resolves.toMatchObject({
      status: "applied",
    });

    const ingest = endpoint.requests.find(({ method, path }) =>
      method === "POST" && path === "/v1/documents"
    );
    expect(ingest?.body).toEqual({
      classification: "internal",
      memory_scope_external_ref: plan.topology.roomScopeExternalRef,
      retrieval_projection: {
        actor_keys: [
          "dactor1.r1.actor-Z",
          "dactor1.r1.actor-a-umlaut",
          "dactor1.r1.actor-z",
        ],
        category: "meeting_evidence",
        kind: "record_block",
        locator: plan.documents[0]!.manifest.candidateLocator,
        projection_generation: plan.topology.indexGeneration,
        relative_time_interval: {
          end_ms: plan.documents[0]!.manifest.endMs,
          start_ms: plan.documents[0]!.manifest.startMs,
        },
        schema_version: "document-retrieval-projection.v1",
        sequence_ordinal: plan.documents[0]!.manifest.ordinal,
        source_key: plan.topology.releaseRef,
        tags: [],
        time_interval: null,
      },
      source_external_id: plan.documents[0]!.manifest.documentExternalId,
      source_refs: [
        {
          source_id: plan.documents[0]!.manifest.candidateLocator,
          source_type: "meeting_evidence_locator",
        },
        ...plan.documents[0]!.manifest.turnSources.map(({ sourceRef }) => ({
          source_id: sourceRef,
          source_type: "meeting_evidence_turn",
        })),
      ],
      source_type: "meeting_final_human_evidence",
      space_slug: plan.topology.spaceSlug,
      text: plan.documents[0]!.embeddingText,
      thread_external_ref: plan.topology.threadExternalRef,
      title: plan.documents[0]!.title,
    });
  });

  it("rejects an invalid canonical projection before any transport call", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const plan = fixture();
    const document = plan.documents[0]!;
    const invalid = {
      ...plan,
      documents: [{
        ...document,
        manifest: {
          ...document.manifest,
          turnSources: [{
            ...document.manifest.turnSources[0]!,
            speakerId: "actor\u0000invalid",
          }],
        },
      }],
    };

    await expect(adapter(endpoint).indexFinalMeeting(invalid)).resolves.toEqual({
      code: "memory.index_plan_outside_qualified_bounds",
      retryable: false,
      status: "rejected",
    });
    expect(endpoint.requests).toEqual([]);
  });
});
