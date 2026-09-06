import { z } from "zod";

export const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const revision = z.string().regex(/^[a-f0-9]{40}$/u);
export const id = z.string().min(1).max(256);
export const time = z.number().int().nonnegative();
const scenario = z.enum(["sequential", "overlap", "reconnect"]);
export const baseRevision = "8f49a06128307bfcd13d8cb7a95e00daa528f2ea";
export const manifestDigest = "6ecf3ae9570937da48465bab1d87563c47c0e1b3c1ef46191c0143c3fad3ff79";
export const targetSchema = z.object({
  project: z.literal("vtoss-test-oss-8f49a06-r1"),
  testOnly: z.literal(true),
  guildId: z.literal("1533228590643155034"),
  voiceChannelId: z.literal("1533228823045214398"),
  resultsChannelId: z.literal("1533228891827736657"),
  recorderId: z.literal("1533877611258708230"),
  publicationApplicationId: z.literal("1533224474609057793"),
  platformService: z.literal("meeting-platform"),
  craigService: z.literal("craig-bot"),
  // The reviewed integration supplies its exact revision; native collection checks the image source.
  platformRevision: revision,
  craigRevision: revision,
  gatewayRevision: revision,
  gatewayEndpoint: z.url().refine((value) => {
    const url = new URL(value);
    return ["https:", "wss:"].includes(url.protocol) && !url.username && !url.password &&
      !url.search && !url.hash && !/(^|\.)voicetext\.ai$/u.test(url.hostname);
  }, "Explicit OSS TLS endpoint required"),
  operatorCaSha256: digest,
  summaryProvider: z.literal("transcript-outline"),
  conversationEnabled: z.literal(false),
  liveEnabled: z.literal(true),
}).strict();
export const planSchema = z.object({
  kind: z.literal("oss-discord-stt-plan-v1"),
  campaignId: id,
  target: targetSchema,
  collectorRevision: revision,
  runs: z.array(z.object({ runId: id, scenario }).strict()).length(3),
}).strict().superRefine((value, ctx) => {
  if (value.runs.map((run) => run.scenario).join() !== "sequential,overlap,reconnect" ||
    new Set(value.runs.map((run) => run.runId)).size !== 3) {
    ctx.addIssue({ code: "custom", message: "Three ordered, distinct scenario/run identities required" });
  }
});
export type OssPlan = z.infer<typeof planSchema>;
export const artifactSchema = z.object({
  path: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/u).refine(
    (path) => path.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
  ),
  sha256: digest,
  size: z.number().int().nonnegative().max(512 * 1024 * 1024),
  // An immutable source version, not a URL to fetch.
  source: z.object({
    system: z.enum(["actor", "craig", "postgres", "object-storage", "gateway", "discord", "deployment"]),
    locator: id,
    version: id.refine((value) => !["null", "latest", "current"].includes(value), "Immutable source version required"),
  }).strict(),
}).strict();
export const indexSchema = z.object({
  kind: z.literal("oss-discord-stt-collection-v1"),
  planSha256: digest,
  collectorRevision: revision,
  capturedAtMs: time,
  artifacts: z.array(artifactSchema).min(1).max(10000),
  runs: z.array(z.object({ runId: id, evidencePath: id }).strict()).length(3),
  deploymentPath: id,
  nativeSources: z.object({
    livePath: id, postCallPath: id, deploymentPaths: z.array(id).length(2),
    runs: z.array(z.object({
      runId: id, snapshots: z.array(id).length(2),
      publications: z.array(id).length(2), originalsPath: id
    }).strict()).length(3),
  }).strict().optional(),
}).strict();
export const turnSchema = z.object({
  turnId: id, speakerId: id, startMs: time, endMs: time, text: z.string().min(1).max(20000),
}).strict();
export const runSchema = z.object({
  kind: z.literal("oss-discord-stt-run-v1"),
  campaignId: id, runId: id, scenario,
  meetingId: id, recordingId: id,
  startedAtMs: time, endedAtMs: time, terminalAtMs: time,
  actorPath: id, databasePath: id, manifestPath: id, completionPath: id, originalInventoryPath: id,
  lifecycle: z.array(z.object({
    type: z.enum(["meeting.started", "meeting.ended", "recording.authoritative_ready"]),
    atMs: time, recordingId: id,
  }).strict()).length(3),
  originals: z.array(id).min(1),
  tracks: z.array(z.object({
    speakerId: id, path: id, originalPaths: z.array(id).min(1),
    timelineOffsetMs: time,
  }).strict()).length(2),
  transcript: z.object({ transcriptId: id, version: id, turns: z.array(turnSchema).min(2).max(500) }).strict(),
  liveTurns: z.array(turnSchema).min(2).max(1000),
  sessions: z.array(z.object({
    sessionId: id, speakerId: id, sourceRevision: revision, wirePath: id,
  }).strict()).min(2).max(20),
  summary: z.object({
    summaryId: z.string().regex(/^outline-[a-f0-9]{32}$/u), transcriptId: id,
    version: z.literal(1), title: id, overview: z.string().min(1).max(4000),
    decisions: z.array(z.never()).length(0), actionItems: z.array(z.never()).length(0),
    topics: z.array(z.never()).length(0), openQuestions: z.array(z.never()).length(0),
  }).strict(),
  stages: z.array(z.object({
    stage: z.enum(["transcription", "summary", "publication"]),
    status: z.literal("succeeded"), startedAtMs: time, completedAtMs: time,
  }).strict()).length(3),
  publication: z.object({
    messageId: id, channelId: id, authorId: id, createdAtMs: time,
    transcriptAttachmentPath: id, summaryAttachmentPath: id,
  }).strict(),
  // Two independent database reads bracket collection; no queue replay is implied.
  settled: z.array(z.object({
    observedAtMs: time, terminalAtMs: time,
    meetingIds: z.array(id), recordingIds: z.array(id), transcriptIds: z.array(id),
    summaryIds: z.array(id), finalMessageIds: z.array(id), transcriptSha256: digest,
  }).strict()).length(2),
}).strict();
export type OssRun = z.infer<typeof runSchema>;
const eventBase = { atMs: time };
export const wireSchema = z.object({
  sessionId: id, recordingId: id, meetingId: id, speakerId: id,
  gatewayEndpoint: id,
  events: z.array(z.discriminatedUnion("type", [
    z.object({
      ...eventBase, type: z.literal("ready"), encoding: z.literal("opus"),
      sampleRate: z.literal(48000), channels: z.literal(1)
    }).strict(),
    z.object({
      ...eventBase, type: z.literal("audio"), seq: z.number().int().positive(),
      craigPacketPath: id, gatewayPacketPath: id, offset: time, size: z.number().int().min(2).max(1275)
    }).strict(),
    z.object({ ...eventBase, type: z.literal("ack"), seq: z.number().int().positive() }).strict(),
    z.object({ ...eventBase, type: z.literal("partial"), turn: turnSchema }).strict(),
    z.object({ ...eventBase, type: z.literal("final"), turn: turnSchema }).strict(),
    z.object({ ...eventBase, type: z.literal("finalize") }).strict(),
    z.object({
      ...eventBase, type: z.literal("finalize_complete"),
      status: z.literal("flushed"), sawResult: z.literal(true)
    }).strict(),
    z.object({ ...eventBase, type: z.literal("closed"), code: z.literal(1000) }).strict(),
  ])).min(8).max(100000),
}).strict();
