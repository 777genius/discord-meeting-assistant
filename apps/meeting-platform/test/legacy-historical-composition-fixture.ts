import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { InfinityContextRetrievalV2Adapter, InfinityRetrievalScopeResolution } from "@discord-meeting/infinity-context-adapter";
import { createProductionCanonicalQuestionChain } from "@discord-meeting/infinity-context-adapter/quality-campaign/canonical-chain";
import { DISPOSABLE_RETRIEVAL_V2_BINDING, startDisposableInfinityHttpService } from
  "@discord-meeting/infinity-context-adapter/test-support";
import { createHistoricalReleaseBinding, LEGACY_HISTORICAL_SIGNING_CONTEXT,
  legacyHistoricalCanonicalJson, PrepareFocusedLocatorRetrievalV2Request } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { FinalTranscript } from "@discord-meeting/meeting-core/transcription";
import { PinnedLegacyHistoricalReceiptVerifier, PostgresHistoricalEvidenceAuthority,
  PostgresHistoricalMemoryStore, PostgresHistoricalRoomAuthoritySnapshot } from "@discord-meeting/postgres-adapter";
import { createGrpcQualifiedGroundedAnswerAdapter, GrpcSubscriptionRuntimeTransport } from
  "@discord-meeting/subscription-runtime-adapter";
import type { Pool } from "pg";
import { expect } from "vitest";
import { runLegacyHistoricalAdmissionCommand } from "../src/composition/legacy-historical-admission.js";
import { currentActor, currentMeeting, platformConfig, requiredHistoricalRuntime } from "./meeting-knowledge-production-composition-fixtures.js";
import { waitForHistoricalRows } from "./meeting-knowledge-production-composition-diagnostics.js";

import { createDiscordInfinityActorCustody, requireHistoricalRuntimeSecrets } from "../src/composition/discord-infinity-actor-custody.js";

const canonical = legacyHistoricalCanonicalJson;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Synthetic integration: real scheduler, official SDK fake endpoint, concrete canonical evidence chain. */
export async function proveLegacyHistoricalComposition(pool: Pool): Promise<void> {
  const meeting = currentMeeting();
  meeting.beginTranscription();
  meeting.completeTranscription(FinalTranscript.create({ recordingId: meeting.recording.recordingId,
    transcriptId: "legacy-composition-transcript", version: 1, turns: [
      { turnId: "legacy-human", speakerId: currentActor, startMs: 0, endMs: 1_000,
        text: "Project Atlas deployment was approved for Monday." },
      { turnId: "legacy-automation", speakerId: "synthetic-automation", startMs: 1_000, endMs: 2_000,
        text: "Automation text remains in the original transcript." },
    ] }));
  const snapshot = { ...meeting.toSnapshot(), meetingId: "legacy-composition-meeting",
    source: null, actors: null, identityProvenance: null, lifecycleGeneration: null };
  const binding = createHistoricalReleaseBinding({ acceptedMeetingRevision: snapshot.revision,
    desiredGeneration: 1, meetingId: snapshot.meetingId, roomId: "legacy-composition-room",
    scopeId: "legacy-composition-scope", transcriptId: snapshot.transcript!.transcriptId, transcriptVersion: 1 });
  const source = canonical(snapshot.transcript);
  const payload = { admission: "signed_legacy_v1", policyVersion: 1, policyId: "synthetic-policy",
    signerId: "synthetic-signer", binding, recordingId: snapshot.recording.recordingId,
    snapshotSha256: sha(canonical(snapshot)), transcriptSha256: sha(source), savedSourceSha256: sha(source),
    identityEvidenceSha256: sha("synthetic-identity"), scopeRoomEvidenceSha256: sha("synthetic-room"),
    durationEvidenceSha256: sha("synthetic-duration"), authoritativeDurationMs: 2_000,
    actors: [{ actorId: currentActor, kind: "human" }, { actorId: "synthetic-automation", kind: "automation" }] };
  const keys = generateKeyPairSync("ed25519");
  const trust = [{ policyId: payload.policyId, signerId: payload.signerId,
    publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }];
  const receipt = { payload, signature: sign(null,
    Buffer.from(LEGACY_HISTORICAL_SIGNING_CONTEXT + canonical(payload)), keys.privateKey).toString("base64") };
  const verifier = new PinnedLegacyHistoricalReceiptVerifier(trust);
  const infinity = await startDisposableInfinityHttpService();
  const runtime = requiredHistoricalRuntime(pool, infinity, true, true, "test", { legacyVerifier: verifier });
  const transport = new GrpcSubscriptionRuntimeTransport({ address: "127.0.0.1:1", serviceToken: "synthetic-unused-token" });
  const options = { attemptId: `sqv4-${sha("synthetic-legacy-attempt")}`, signal: new AbortController().signal };
  try {
    await pool.query("INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot) VALUES ($1, $2, $3)",
      [snapshot.meetingId, snapshot.revision, snapshot]);
    expect(await runLegacyHistoricalAdmissionCommand({ pool, receipt, savedSourceJson: source,
      pinnedPublicTrust: trust })).toBe("accepted");
    const room = new PostgresHistoricalRoomAuthoritySnapshot(pool, undefined, verifier);
    expect(await room.loadRoomAuthoritySnapshot({ ...binding, maximumSources: 10, pageSize: 1 }))
      .toMatchObject({ entries: [] });
    await runtime.assertReady(); await runtime.start();
    await waitForHistoricalRows(pool, (row) => row.meeting_id === snapshot.meetingId && row.state === "applied", 1, options.signal);
    await runtime.close();
    const config = platformConfig(infinity.baseUrl, true, true, "test");
    const { topologyKey } = requireHistoricalRuntimeSecrets(config);
    const { historicalIds: ids } = createDiscordInfinityActorCustody(config, topologyKey);
    const chain = createProductionCanonicalQuestionChain({ ids,
      answer: createGrpcQualifiedGroundedAnswerAdapter({ transport,
        beforeProviderCall: async () => { throw new Error("answer providers are prohibited in this fixture"); },
        options: { expectedLauncherSha256: "5".repeat(64) } }),
      audit: { seal: async () => {} }, journal: { reserve: async () => {}, terminal: async () => {} },
      spend: { reserve: async () => {} }, topology: { resolve: async () => ({ ...binding, currentMeetingId: "other-meeting" }) },
      evidenceAuthority: new PostgresHistoricalEvidenceAuthority(pool, undefined, verifier),
      store: new PostgresHistoricalMemoryStore(pool),
      preparer: new PrepareFocusedLocatorRetrievalV2Request({ scopeResolution: new InfinityRetrievalScopeResolution({
        baseUrl: infinity.baseUrl, token: "synthetic-token", operationTimeoutMs: 500, requestTimeoutMs: 500 }), ids, providerBinding: DISPOSABLE_RETRIEVAL_V2_BINDING, snapshot: room }),
      retrieval: new InfinityContextRetrievalV2Adapter({ baseUrl: infinity.baseUrl,
        operationTimeoutMs: 2_000, requestTimeoutMs: 1_000, token: "synthetic-token" }),
    });
    const packet = { locale: "en" as const, questionId: "legacy-question", source: "automatic" as const,
      questionText: "When was Project Atlas deployment approved?", scopeTopologyReference: "synthetic-topology" };
    const retrieved = await chain.retrieval.retrieve(packet, options);
    expect(retrieved.status, retrieved.status === "completed" ? undefined : retrieved.reason).toBe("completed");
    if (retrieved.status !== "completed") { throw new Error(retrieved.reason); }
    expect(retrieved.candidates.length).toBeGreaterThan(0);
    const evidence = await chain.evidence.rehydrate({ ...packet,
      locatorIds: retrieved.candidates.map((candidate) => candidate.locatorId) }, options);
    expect(evidence.turns.map(({ turnId }) => turnId)).toContain("legacy-human");
    expect(evidence.turns.map(({ turnId }) => turnId)).not.toContain("legacy-automation");
    await pool.query("UPDATE meeting_core.meetings SET snapshot = jsonb_set(snapshot, '{publicationTargetId}', '\"mutated\"') WHERE meeting_id = $1", [snapshot.meetingId]);
    await expect(chain.evidence.rehydrate({ ...packet,
      locatorIds: retrieved.candidates.map((candidate) => candidate.locatorId) }, options)).rejects.toThrow();
  } finally {
    transport.close(); await runtime.close(); await infinity.close();
    await pool.query("DELETE FROM meeting_core.historical_memory_sync WHERE meeting_id = $1", [snapshot.meetingId]);
    await pool.query("DELETE FROM meeting_core.meetings WHERE meeting_id = $1", [snapshot.meetingId]);
  }
}
