import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fixtureManifestV1Schema } from "../src/e2e-fixture-manifest-schema.js";
import { sha256, canonical, type Artifact } from "../src/oss-campaign-artifacts.js";
import { baseRevision, planSchema, runSchema, wireSchema } from "../src/oss-campaign-profile.js";

const identityPart = (value: string) => `${value.length}:${value}`;

export async function campaignFixture(root: string, generatedAuthoritativeIds = false) {
  const manifestBytes = await readFile(new URL("./fixtures/manifest.v1.json", import.meta.url));
  const manifest = fixtureManifestV1Schema.parse(JSON.parse(manifestBytes.toString()));
  const fixtureAudio = await Promise.all(manifest.fixtures.map((fixture) =>
    readFile(new URL(`./fixtures/${fixture.audioPath}`, import.meta.url))));
  const plan = planSchema.parse({
    kind: "oss-discord-stt-plan-v1", campaignId: "offline-test",
    collectorRevision: "c".repeat(40), target: {
      project: "vtoss-test-oss-8f49a06-r1", testOnly: true,
      guildId: "1533228590643155034", voiceChannelId: "1533228823045214398",
      resultsChannelId: "1533228891827736657", recorderId: "1533877611258708230",
      publicationApplicationId: "1533224474609057793", platformService: "meeting-platform",
      craigService: "craig-bot", platformRevision: baseRevision, craigRevision: "a".repeat(40),
      gatewayRevision: "b".repeat(40), gatewayEndpoint: "wss://oss-gateway.test/v1/stream",
      operatorCaSha256: sha256("offline-public-ca"), summaryProvider: "transcript-outline",
      conversationEnabled: false, liveEnabled: true,
    }, runs: ["sequential", "overlap", "reconnect"].map((scenario, i) => ({ scenario, runId: `run-${i}` })),
  });
  const files = new Map<string, { system: Artifact["source"]["system"]; value: unknown }>();
  const put = (path: string, system: Artifact["source"]["system"], value: unknown) => {
    files.set(path, { system, value }); return path;
  };
  put("operator-ca.pem", "deployment", Buffer.from("offline-public-ca"));
  const wires: z.infer<typeof wireSchema>[] = [];
  const actors: Array<{ events: Array<{ actorName: string; type: string; atEpochMs: number; fixtureId?: string }> }> = [];
  const runs = plan.runs.map((planned, i) => {
    const started = 100000 + i * 200000;
    const offsets = [1000, planned.scenario === "sequential" ? 30735 : 1750];
    const turns = manifest.fixtures.map((fixture, j) => ({
      turnId: `turn-${i}-${j}`,
      speakerId: fixture.speakerId, text: fixture.sourceText, startMs: offsets[j]!,
      endMs: offsets[j]! + fixture.durationMs
    }));
    const ended = started + Math.max(...turns.map((turn) => turn.endMs)) + 1000;
    const actor = {
      schemaVersion: 1, fixtureSetId: manifest.fixtureSetId, runId: planned.runId,
      scenario: planned.scenario, recordingId: null, timelineOrigin: "unix-epoch",
      fixtures: manifest.fixtures.map(({ fixtureId, audioSha256, sourceSha256, durationMs }) =>
        ({ fixtureId, audioSha256, sourceSha256, durationMs })),
      events: manifest.fixtures.flatMap((fixture, j) => [
        { actorName: fixture.actorName, type: "ready", atEpochMs: started },
        ...(planned.scenario === "reconnect" && j === 1 ? [
          { actorName: fixture.actorName, type: "disconnected", atEpochMs: started + 1750 },
          { actorName: fixture.actorName, type: "ready", atEpochMs: started + 1750 },
        ] : []),
        { actorName: fixture.actorName, fixtureId: fixture.fixtureId, type: "playback-start", atEpochMs: started + offsets[j]! },
        { actorName: fixture.actorName, fixtureId: fixture.fixtureId, type: "playback-end", atEpochMs: started + turns[j]!.endMs },
      ]).toSorted((a, b) => a.atEpochMs - b.atEpochMs),
    };
    actors.push(actor);
    const original = put(`recording-${i}.original`, "craig", Buffer.from(`offline-original-${i}`));
    // Mirror operationIdentity and stableVoicetextBatchId using synthetic immutable
    // artifact locators/revisions. No provider access or producer deep import.
    const operationKey = ["final-transcription:v2", ...[
      `meeting-${i}`, `recording-${i}`,
      ...turns.flatMap((turn, j) => [
        `s3://vtoss-test-oss/campaigns/00000000-0000-4000-8000-000000000000/sequential/run/recordings/recording-${i}/speakers/${turn.speakerId}/audio.ogg`,
        "00000000-0000-4000-8000-000000000000", "a".repeat(64), j === 0 ? "100000" : "1000000",
      ]),
    ].map(identityPart)].join("|");
    const transcript = {
      transcriptId: generatedAuthoritativeIds ? `transcript:v2:${identityPart(operationKey)}` : `transcript-${i}`,
      version: "1",
      turns: generatedAuthoritativeIds ? turns.map((turn, j) => ({
        ...turn, turnId: `turn:v2:${identityPart(operationKey)}:${identityPart(String(j + 1))}:2:10`,
      })) : turns,
    };
    const summaryKey = `evidence-summary:v3|${`meeting-${i}`.length}:meeting-${i}|${transcript.transcriptId.length}:${transcript.transcriptId}`;
    const summary = {
      summaryId: `outline-${sha256(`meeting-${i}\0${summaryKey}\0${transcript.transcriptId}`).slice(0, 32)}`, transcriptId: transcript.transcriptId,
      version: 1, title: "Meeting transcript", overview: `Authoritative transcript finalized with ${turns.length} turns. See the attached transcript for complete evidence.`, decisions: [], actionItems: [],
      topics: [], openQuestions: []
    };
    const run = runSchema.parse({
      kind: "oss-discord-stt-run-v1", ...planned, campaignId: plan.campaignId,
      meetingId: `meeting-${i}`, recordingId: `recording-${i}`, startedAtMs: started,
      endedAtMs: ended, terminalAtMs: ended + 100,
      completionPath: `completion-${i}.json`, originalInventoryPath: `original-inventory-${i}.json`,
      databasePath: `database-${i}.json`,
      manifestPath: put(`manifest-${i}.json`, "object-storage", { recordingId: `recording-${i}` }),
      actorPath: put(`actor-${i}.json`, "actor", actor),
      lifecycle: ["meeting.started", "meeting.ended", "recording.authoritative_ready"].map((type, j) =>
        ({ type, recordingId: `recording-${i}`, atMs: [started, ended, ended + 10][j] })),
      originals: [original], tracks: turns.map((turn, j) => ({
        speakerId: turn.speakerId,
        path: put(`recording-${i}.track-${j}.ogg`, "object-storage", fixtureAudio[j]),
        originalPaths: [original], timelineOffsetMs: offsets[j]
      })), transcript, liveTurns: turns,
      sessions: turns.map((turn, j) => {
        const sessionId = `session-${i}-${j}`;
        const wire = wireSchema.parse({
          sessionId, recordingId: `recording-${i}`, meetingId: `meeting-${i}`,
          speakerId: turn.speakerId, gatewayEndpoint: plan.target.gatewayEndpoint,
          events: [
            { type: "ready", atMs: started, encoding: "opus", sampleRate: 48000, channels: 1 },
            ...Array.from({ length: Math.ceil((turn.endMs - turn.startMs) / 20) }, (_, packet) => [
              {
                type: "audio", atMs: started + turn.startMs + packet * 20, seq: packet + 1,
                offset: packet * 3, size: 3,
                craigPacketPath: `recording-${i}.craig-${j}.opus`,
                gatewayPacketPath: `recording-${i}.gateway-${j}.opus`
              },
              { type: "ack", atMs: started + turn.startMs + packet * 20, seq: packet + 1 },
            ]).flat(),
            { type: "partial", atMs: ended, turn }, { type: "final", atMs: ended, turn },
            { type: "finalize", atMs: ended },
            { type: "finalize_complete", atMs: ended, status: "flushed", sawResult: true },
            { type: "closed", atMs: ended, code: 1000 },
          ]
        });
        const packetBytes = Buffer.from(Array.from({ length: Math.ceil((turn.endMs - turn.startMs) / 20) },
          () => [0xf8, 0xff, 0xfe]).flat());
        put(`recording-${i}.craig-${j}.opus`, "craig", packetBytes);
        put(`recording-${i}.gateway-${j}.opus`, "gateway", packetBytes);
        wires.push(wire);
        return {
          sessionId, speakerId: turn.speakerId, sourceRevision: plan.target.gatewayRevision,
          wirePath: put(`${sessionId}.json`, "gateway", wire)
        };
      }), summary,
      stages: ["transcription", "summary", "publication"].map((stage, j) => ({
        stage, status: "succeeded",
        startedAtMs: ended + 10 + j * 10, completedAtMs: ended + 20 + j * 10
      })),
      publication: {
        messageId: `154640799877851138${i}`, channelId: plan.target.resultsChannelId,
        authorId: plan.target.publicationApplicationId, createdAtMs: ended + 35,
        transcriptAttachmentPath: put(`attachment-${i}.md`, "discord", Buffer.from(turns.map((t) => t.text).join("\n"))),
        summaryAttachmentPath: put(`outline-${i}.md`, "discord", Buffer.from(`${summary.title}\n${summary.overview}`))
      },
      settled: [200, 300].map((delay) => ({
        observedAtMs: ended + delay, terminalAtMs: ended + 100,
        meetingIds: [`meeting-${i}`], recordingIds: [`recording-${i}`], transcriptIds: [transcript.transcriptId],
        summaryIds: [summary.summaryId], finalMessageIds: [`154640799877851138${i}`], transcriptSha256: sha256(canonical(transcript))
      })),
    });
    const manifestValue = {
      schemaVersion: 1, recordingId: run.recordingId, guildId: plan.target.guildId,
      channelId: plan.target.voiceChannelId, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(),
      source: { kind: "craig-original-multitrack", checksumSha256: sha256(`offline-source-${i}`) },
      tracks: run.tracks.map((track, j) => ({
        speakerId: track.speakerId, locator: track.path,
        artifactRevision: "offline-version-1", checksumSha256: sha256(fixtureAudio[j]!),
        sizeBytes: fixtureAudio[j]!.length, timelineOffsetMs: track.timelineOffsetMs, trackNumber: j + 1
      }))
    };
    put(run.manifestPath, "object-storage", manifestValue);
    const recordingManifestBytes = Buffer.from(JSON.stringify(manifestValue));
    const acceptedTracks = manifestValue.tracks.map(({ locator, trackNumber: _number, ...track }) =>
      ({ ...track, audioLocator: locator }));
    put(run.completionPath, "postgres", {
      schemaVersion: 6, lifecycleSchemaVersion: 1,
      actors: null, identityProvenance: null, channelId: plan.target.voiceChannelId, guildId: plan.target.guildId,
      recordingId: run.recordingId, finalEventId: "event-2", finalEventDigest: "f".repeat(64),
      events: run.lifecycle.map((event, j) => ({
        type: event.type, occurredAt: new Date(event.atMs).toISOString(),
        eventId: `event-${j}`, digest: "f".repeat(64)
      })),
      recording: {
        recordingId: run.recordingId, authoritativeDurationMs: ended - started,
        manifestChecksumSha256: sha256(recordingManifestBytes), manifestLocator: run.manifestPath,
        manifestRevision: "offline-version-1", manifestSizeBytes: recordingManifestBytes.length, speakerAudio: acceptedTracks
      },
      authoritativeTracks: acceptedTracks.map(({ artifactRevision, ...track }, j) =>
        ({ ...track, artifactVersionId: artifactRevision, trackNumber: j + 1, uploadId: `upload-${j}` }))
    });
    put(run.originalInventoryPath, "craig", {
      recordingId: run.recordingId, craigRevision: plan.target.craigRevision,
      sourceFilesChecksumSha256: manifestValue.source.checksumSha256,
      files: [{ path: original, sha256: sha256(`offline-original-${i}`), size: Buffer.byteLength(`offline-original-${i}`) }]
    });
    put(run.databasePath, "postgres", {
      matchingMeetingCount: 1, matchingRecordingCount: 1,
      matchingSummaryCount: 1, matchingTranscriptCount: 1, snapshot: {
        meetingId: run.meetingId, revision: 1, publicationTargetId: plan.target.resultsChannelId,
        publication: { externalPublicationId: `discord:v2:channel:${plan.target.resultsChannelId}:message:${run.publication.messageId}`, idempotencyKey: "test-publish" },
        publicationStage: { status: "succeeded", attempts: 1 },
        summaryStage: { status: "succeeded", attempts: 1 },
        transcriptionStage: { status: "succeeded", attempts: 1 },
        recording: {
          recordingId: run.recordingId, manifestLocator: run.manifestPath,
          manifestRevision: "offline-version-1", manifestSizeBytes: recordingManifestBytes.length,
          manifestChecksumSha256: sha256(recordingManifestBytes),
          speakerAudio: run.tracks.map((track, j) => ({
            speakerId: track.speakerId, audioLocator: track.path,
            checksumSha256: sha256(fixtureAudio[j]!), sizeBytes: fixtureAudio[j]!.length,
            artifactRevision: "offline-version-1", timelineOffsetMs: track.timelineOffsetMs
          }))
        },
        transcript: { transcriptId: run.transcript.transcriptId, turns: run.transcript.turns }, summary: run.summary,
      }
    });
    put(`run-${i}.json`, "postgres", run);
    return run;
  });
  const deployment = {
    target: plan.target, targetAfter: structuredClone(plan.target), beforeMs: 0,
    afterMs: 1000000, platformImageDigest: `sha256:${"a".repeat(64)}`,
    craigImageDigest: `sha256:${"b".repeat(64)}`, gatewayImageDigest: `sha256:${"c".repeat(64)}`,
    operatorCaPath: "operator-ca.pem", recordingIdsBefore: [], recordingIdsAfter: runs.map((run) => run.recordingId)
  };
  put("deployment.json", "deployment", deployment);
  const planPath = join(root, "plan.json");
  const save = async () => {
    await mkdir(root, { recursive: true });
    const planBytes = JSON.stringify(plan);
    await writeFile(planPath, planBytes);
    const artifacts: Artifact[] = [];
    for (const [path, file] of files) {
      const bytes = Buffer.isBuffer(file.value) ? file.value : Buffer.from(JSON.stringify(file.value));
      await writeFile(join(root, path), bytes);
      artifacts.push({
        path, sha256: sha256(bytes), size: bytes.length,
        source: { system: file.system, locator: path, version: "offline-version-1" }
      });
    }
    const index = {
      kind: "oss-discord-stt-collection-v1", planSha256: sha256(planBytes),
      collectorRevision: plan.collectorRevision, capturedAtMs: 1000001, artifacts,
      runs: plan.runs.map(({ runId }, i) => ({ runId, evidencePath: `run-${i}.json` })), deploymentPath: "deployment.json"
    };
    const bytes = Buffer.from(JSON.stringify(index));
    await writeFile(join(root, "collection.json"), bytes);
  };
  return { plan, planPath, runs, wires, actors, deployment, files, save, manifestBytes };
}
