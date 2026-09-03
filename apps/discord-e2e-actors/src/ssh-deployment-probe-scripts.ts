export const containerProvenanceFormat = `{"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}},"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"composeService":{{json (index .Config.Labels "com.docker.compose.service")}},"containerId":{{json .Id}},"containerStartedAt":{{json .State.StartedAt}},"imageId":{{json .Image}}}`;

export const imageProvenanceFormat = `{"imageId":{{json .Id}},"repositoryDigests":{{json .RepoDigests}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}`;

export const historicalReplyWorkerProcessFormat = `{"containerId":{{json .Id}},"hostProcessId":{{json .State.Pid}}}`;

export const replayTargetContainerFormat = `{"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"composeService":{{json (index .Config.Labels "com.docker.compose.service")}},"testOnly":{{json (index .Config.Labels "e2e.test-only")}}}`;

export const completionReceiptsScript = String.raw`
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.env.RECORDING_SPOOL_ROOT, "completed-v1");
const rootStats = await lstat(root);
if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
  throw new Error("recording completion receipt root is unsafe");
}
const receipts = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!/^[a-f\d]{64}\.json$/u.test(entry.name)) continue;
  const path = join(root, entry.name);
  const stats = await lstat(path);
  if (!entry.isFile() || !stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("recording completion receipt path is unsafe");
  }
  receipts.push(JSON.parse(await readFile(path, "utf8")));
}
console.log(JSON.stringify(receipts));
`;

export const postgresEvidenceQuery = `
WITH target AS (
  SELECT snapshot
  FROM meeting_core.meetings
  WHERE snapshot -> 'recording' ->> 'recordingId' = '__RECORDING_ID__'
  ORDER BY updated_at DESC
  LIMIT 1
)
SELECT jsonb_build_object(
  'snapshot', (SELECT snapshot FROM target),
  'matchingMeetingCount', (
    SELECT count(*) FROM meeting_core.meetings
    WHERE meeting_id = (SELECT snapshot ->> 'meetingId' FROM target)
  ),
  'matchingRecordingCount', (
    SELECT count(*) FROM meeting_core.meetings
    WHERE snapshot -> 'recording' ->> 'recordingId' = '__RECORDING_ID__'
  ),
  'matchingTranscriptCount', (
    SELECT count(*) FROM meeting_core.meetings
    WHERE snapshot -> 'transcript' ->> 'transcriptId' =
      (SELECT snapshot -> 'transcript' ->> 'transcriptId' FROM target)
  ),
  'matchingSummaryCount', (
    SELECT count(*) FROM meeting_core.meetings
    WHERE snapshot -> 'summary' ->> 'summaryId' =
      (SELECT snapshot -> 'summary' ->> 'summaryId' FROM target)
  )
)::text;
`;

export const historicalReplyRehydrationQuery = `
WITH candidate AS (
  SELECT *
  FROM meeting_core.historical_memory_sync
  WHERE meeting_id = '__MEETING_ID__'
    AND is_current
    AND operation = 'index'
    AND state = 'applied'
    AND profile_rebuild_requested = false
    AND plan IS NOT NULL
    AND jsonb_typeof(remote_document_ids) = 'object'
    AND jsonb_object_length(remote_document_ids) > 0
), singleton AS (
  SELECT * FROM candidate
  WHERE (SELECT count(*) FROM candidate) = 1
), lifecycle AS (
  SELECT snapshot
  FROM meeting_core.meetings
  WHERE meeting_id = '__MEETING_ID__'
    AND snapshot ->> 'lifecycleGeneration' ~ '^[3-9][0-9]*$'
    AND snapshot -> 'identityProvenance' ->> 'producerCapabilityId' =
      'meeting.lifecycle.sealed-actor-roster.v1'
    AND snapshot -> 'identityProvenance' ->> 'actorObservationState' = 'consistent'
    AND snapshot -> 'identityProvenance' ->> 'actorSemanticsVersion' = '1'
    AND snapshot -> 'identityProvenance' ->> 'rosterState' = 'sealed'
)
SELECT jsonb_build_object(
  'historicalReleaseId', release_id,
  'sourceMeetingId', meeting_id,
  'desiredSourceGeneration', desired_generation,
  'transcriptId', transcript_id,
  'transcriptVersion', transcript_version,
  'state', state,
  'infinityDocumentCount', jsonb_object_length(remote_document_ids),
  'appliedIndexGeneration', applied_index_generation,
  'appliedIndexProfileId', applied_index_profile_id,
  'appliedReleaseRef', plan -> 'topology' ->> 'releaseRef',
  'profileRebuildRequested', profile_rebuild_requested,
  'canonicalTurnIds', (
    SELECT jsonb_agg(turn_id ORDER BY turn_id)
    FROM (
      SELECT DISTINCT jsonb_array_elements_text(
        document -> 'manifest' -> 'turnIds'
      ) AS turn_id
      FROM jsonb_array_elements(plan -> 'documents') AS document
    ) AS covered
  ),
  'documentMappings', (
    SELECT jsonb_agg(jsonb_build_object(
      'documentExternalId', remote.key,
      'remoteDocumentId', remote.value,
      'plannedIndexGeneration', document -> 'manifest' ->> 'indexGeneration',
      'plannedProfileId', document -> 'manifest' ->> 'embeddingTokenProfile',
      'canonicalTurnIds', document -> 'manifest' -> 'turnIds'
    ) ORDER BY remote.key)
    FROM jsonb_each_text(remote_document_ids) AS remote
    JOIN LATERAL (
      SELECT document FROM jsonb_array_elements(plan -> 'documents') AS document
      WHERE document -> 'manifest' ->> 'documentExternalId' = remote.key
    ) AS planned ON true
  ),
  'plannedDocumentCount', jsonb_array_length(plan -> 'documents'),
  'plannedGeneration', plan -> 'topology' ->> 'indexGeneration',
  'plannedProfileIds', (
    SELECT jsonb_agg(DISTINCT document -> 'manifest' ->> 'embeddingTokenProfile')
    FROM jsonb_array_elements(plan -> 'documents') AS document
  ),
  'plannedScopeId', plan -> 'binding' ->> 'scopeId',
  'plannedRoomId', plan -> 'binding' ->> 'roomId',
  'scopeId', scope_id,
  'roomId', room_id,
  'trustedLifecycle', jsonb_build_object(
    'lifecycleGeneration', (lifecycle.snapshot ->> 'lifecycleGeneration')::bigint,
    'actorObservationState', lifecycle.snapshot -> 'identityProvenance' ->> 'actorObservationState',
    'actorSemanticsVersion', (lifecycle.snapshot -> 'identityProvenance' ->> 'actorSemanticsVersion')::bigint,
    'producerCapabilityId', lifecycle.snapshot -> 'identityProvenance' ->> 'producerCapabilityId',
    'producerRevision', lifecycle.snapshot -> 'identityProvenance' ->> 'producerRevision',
    'rosterState', lifecycle.snapshot -> 'identityProvenance' ->> 'rosterState',
    'actors', lifecycle.snapshot -> 'actors'
  ),
  'observedAt', to_char(
    updated_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ),
  'retrievalPath', 'infinity_locator_v2'
)::text
FROM singleton CROSS JOIN lifecycle;
`;

export const historicalReplyQuestionAdmissionQuery = `
WITH candidate AS (
  SELECT job.question_id, job.state, job.generation, job.policy_epoch,
         worker_protocol_epoch, worker_protocol_generation,
         binding -> 'retrievalBinding' AS retrieval_binding,
         job.provider_attempt_id AS attempt_id,
         job.grounding_plan::text AS grounding_plan_canonical_json,
         effect.effect_id
  FROM meeting_knowledge.question_jobs AS job
  JOIN meeting_core.answer_effects AS effect
    ON effect.effect_id = 'meeting-knowledge-answer:v1:' || job.question_id
  WHERE job.question_id = '__QUESTION_ID__'
    AND job.state = 'ready'
    AND job.provider_attempt_id IS NOT NULL
    AND job.grounding_plan IS NOT NULL
    AND effect.state IN ('request_started', 'outcome_unknown', 'delivered')
    AND binding ->> 'bindingProtocolVersion' = '2'
    AND binding -> 'retrievalBinding' ->> 'retrievalPath' = 'infinity_locator_v2'
), singleton AS (
  SELECT * FROM candidate WHERE (SELECT count(*) FROM candidate) = 1
)
SELECT jsonb_build_object(
  'questionId', question_id,
  'jobId', question_id,
  'state', state,
  'attemptId', attempt_id,
  'groundingPlanCanonicalJson', grounding_plan_canonical_json,
  'effectId', effect_id,
  'jobGeneration', generation,
  'policyEpoch', policy_epoch,
  'retrievalBinding', retrieval_binding,
  'workerProtocolEpoch', worker_protocol_epoch,
  'workerProtocolGeneration', worker_protocol_generation,
  'observedAt', to_char(
    clock_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  )
)::text
FROM singleton;
`;

export const historicalReplyQuestionOutcomeQuery = `
WITH candidate AS (
  SELECT question_id, state, outcome
  FROM meeting_knowledge.question_jobs
  WHERE question_id = '__QUESTION_ID__'
    AND state = 'terminal'
    AND outcome IN ('answered', 'insufficient_evidence')
), singleton AS (
  SELECT * FROM candidate
  WHERE (SELECT count(*) FROM candidate) = 1
)
SELECT jsonb_build_object(
  'questionId', question_id,
  'state', state,
  'outcome', outcome,
  'observedAt', to_char(
    clock_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  )
)::text
FROM singleton;
`;

export const historicalReplySettlementQuery = `
WITH candidate AS (
  SELECT job.question_id AS job_id,
         job.provider_attempt_id AS attempt_id,
         job.grounding_plan::text AS grounding_plan_canonical_json,
         effect.effect_id,
         effect.external_receipt
  FROM meeting_knowledge.question_jobs AS job
  JOIN meeting_core.answer_effects AS effect
    ON effect.effect_id = 'meeting-knowledge-answer:v1:' || job.question_id
  WHERE job.question_id = '__QUESTION_ID__'
    AND job.state = 'terminal'
    AND job.grounding_plan IS NOT NULL
    AND effect.state = 'delivered'
    AND effect.external_receipt IS NOT NULL
), singleton AS (
  SELECT * FROM candidate WHERE (SELECT count(*) FROM candidate) = 1
)
SELECT jsonb_build_object(
  'jobId', job_id,
  'attemptId', attempt_id,
  'groundingPlanCanonicalJson', grounding_plan_canonical_json,
  'effectId', effect_id,
  'externalReceipt', external_receipt,
  'observedAt', to_char(
    clock_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  )
)::text
FROM singleton;
`;

export const greetingLedgerRowsQuery = `
WITH requested(receipt_id, ordinal) AS (
  VALUES __GREETING_RECEIPTS__
), candidate AS (
  SELECT requested.ordinal, receipt.receipt_id, receipt.cue_kind,
         receipt.state, receipt.completed_at
  FROM requested
  JOIN meeting_core.conversation_one_shot_receipts AS receipt
    ON receipt.receipt_id = requested.receipt_id
  WHERE receipt.cue_kind = 'greeting'
    AND receipt.state = 'played'
    AND receipt.completed_at IS NOT NULL
)
SELECT jsonb_build_object(
  'rows', COALESCE(jsonb_agg(jsonb_build_object(
    'receiptId', receipt_id,
    'cueKind', cue_kind,
    'state', state,
    'completedAt', to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) ORDER BY ordinal), '[]'::jsonb),
  'settlementObservedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)::text
FROM candidate
HAVING count(*) = 4;
`;

export const liveMemoryRowsQuery = `
WITH canonical AS (
  SELECT jsonb_agg(jsonb_build_object(
    'turnId', turn_id, 'speakerId', speaker_id, 'startMs', start_ms,
    'endMs', end_ms, 'observationState', 'final',
    'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) ORDER BY start_ms, end_ms, speaker_id, turn_id) AS rows
  FROM meeting_core.live_meeting_turns WHERE meeting_id = '__MEETING_ID__'
), hot AS (
  SELECT jsonb_agg(jsonb_build_object(
    'turnId', hot.turn_id, 'speakerId', turn.speaker_id, 'observationState', 'final',
    'sourceGeneration', hot.source_generation,
    'identityGeneration', hot.identity_generation, 'turnHash', hot.turn_hash,
    'projectedAt', to_char(hot.projected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) ORDER BY hot.source_generation) AS rows
  FROM meeting_knowledge.live_memory_hot_tail AS hot
  JOIN meeting_core.live_meeting_turns AS turn
    ON turn.meeting_id = hot.meeting_id AND turn.turn_id = hot.turn_id
  WHERE hot.meeting_id = '__MEETING_ID__'
), outbox AS (
  SELECT jsonb_agg(jsonb_build_object(
    'turnId', outbox.turn_id, 'speakerId', turn.speaker_id, 'observationState', 'final',
    'sourceGeneration', outbox.source_generation, 'identityGeneration', outbox.identity_generation,
    'state', outbox.state, 'turnHash', outbox.turn_hash,
    'updatedAt', to_char(outbox.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) ORDER BY outbox.source_generation) AS rows
  FROM meeting_knowledge.live_memory_outbox AS outbox
  JOIN meeting_core.live_meeting_turns AS turn
    ON turn.meeting_id = outbox.meeting_id AND turn.turn_id = outbox.turn_id
  WHERE outbox.meeting_id = '__MEETING_ID__'
), lifecycle AS (
  SELECT snapshot
  FROM meeting_core.meetings
  WHERE meeting_id = '__MEETING_ID__'
    AND snapshot ->> 'lifecycleGeneration' ~ '^[3-9][0-9]*$'
    AND snapshot -> 'identityProvenance' ->> 'producerCapabilityId' =
      'meeting.lifecycle.sealed-actor-roster.v1'
    AND snapshot -> 'identityProvenance' ->> 'actorObservationState' = 'consistent'
    AND snapshot -> 'identityProvenance' ->> 'actorSemanticsVersion' = '1'
    AND snapshot -> 'identityProvenance' ->> 'rosterState' = 'sealed'
)
SELECT jsonb_build_object(
  'canonicalTurns', COALESCE(canonical.rows, '[]'::jsonb),
  'hotTail', COALESCE(hot.rows, '[]'::jsonb),
  'outbox', COALESCE(outbox.rows, '[]'::jsonb),
  'trustedLifecycle', jsonb_build_object(
    'lifecycleGeneration', (lifecycle.snapshot ->> 'lifecycleGeneration')::bigint,
    'actorObservationState', lifecycle.snapshot -> 'identityProvenance' ->> 'actorObservationState',
    'actorSemanticsVersion', (lifecycle.snapshot -> 'identityProvenance' ->> 'actorSemanticsVersion')::bigint,
    'producerCapabilityId', lifecycle.snapshot -> 'identityProvenance' ->> 'producerCapabilityId',
    'producerRevision', lifecycle.snapshot -> 'identityProvenance' ->> 'producerRevision',
    'rosterState', lifecycle.snapshot -> 'identityProvenance' ->> 'rosterState',
    'actors', lifecycle.snapshot -> 'actors'
  ),
  'observedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)::text FROM canonical, hot, outbox, lifecycle;
`;

export const s3EvidenceScript = String.raw`
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [rawIdentity, expectedRecordingId] = process.argv.slice(1);
const identity = JSON.parse(rawIdentity);
const secret = async (path) => (await readFile(path, "utf8")).trim();
const client = new S3Client({
  credentials: {
    accessKeyId: await secret(process.env.S3_ACCESS_KEY_ID_FILE),
    secretAccessKey: await secret(process.env.S3_SECRET_ACCESS_KEY_FILE),
  },
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  region: process.env.S3_REGION,
});
const parseLocator = (value) => {
  const match = /^s3:\/\/([^/]+)\/(.+)$/u.exec(value);
  if (!match || match[1] !== process.env.S3_BUCKET) {
    throw new Error("locator outside configured bucket");
  }
  return { Bucket: match[1], Key: match[2] };
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const get = async (expected) => {
  const response = await client.send(new GetObjectCommand({
    ...parseLocator(expected.locator),
    ChecksumMode: "ENABLED",
    VersionId: expected.revision,
  }));
  if (
    !response.Body ||
    response.VersionId !== expected.revision ||
    response.ContentLength !== expected.sizeBytes ||
    response.Metadata?.["artifact-sha256"] !== expected.checksumSha256 ||
    response.Metadata?.["artifact-size-bytes"] !== String(expected.sizeBytes)
  ) {
    throw new Error("S3 object identity does not match the database snapshot");
  }
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  if (bytes.length !== expected.sizeBytes || digest(bytes) !== expected.checksumSha256) {
    throw new Error("S3 object bytes do not match the database snapshot");
  }
  return bytes;
};
const durationMs = (bytes) => {
  let offset = 0;
  let maximum = 0n;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || bytes.toString("ascii", offset, offset + 4) !== "OggS") {
      throw new Error("invalid Ogg page in S3 track");
    }
    const count = bytes[offset + 26];
    let body = 0;
    for (let index = 0; index < count; index += 1) {
      body += bytes[offset + 27 + index];
    }
    const end = offset + 27 + count + body;
    if (end > bytes.length) {
      throw new Error("truncated Ogg track in S3");
    }
    const granule = bytes.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn && granule > maximum) {
      maximum = granule;
    }
    offset = end;
  }
  if (maximum === 0n) {
    throw new Error("S3 Ogg track has no duration");
  }
  return Math.round(Number(maximum) / 48);
};
const manifestBytes = await get({
  checksumSha256: identity.manifestChecksumSha256,
  locator: identity.manifestLocator,
  revision: identity.manifestRevision,
  sizeBytes: identity.manifestSizeBytes,
});
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.recordingId !== expectedRecordingId || manifest.source?.kind !== "craig-original-multitrack") {
  throw new Error("S3 manifest is not the requested authoritative Craig recording");
}
const expectedBySpeaker = new Map(identity.speakerAudio.map((track) => [track.speakerId, track]));
if (expectedBySpeaker.size !== identity.speakerAudio.length ||
  new Set(manifest.tracks.map((track) => track.speakerId)).size !== manifest.tracks.length ||
  manifest.tracks.length !== identity.speakerAudio.length) {
  throw new Error("Authoritative track identity is not bijective");
}
const tracks = [];
for (const declared of manifest.tracks) {
  const expected = expectedBySpeaker.get(declared.speakerId);
  if (!expected || declared.locator !== expected.audioLocator ||
    declared.artifactRevision !== expected.artifactRevision ||
    declared.checksumSha256 !== expected.checksumSha256 ||
    declared.sizeBytes !== expected.sizeBytes ||
    declared.timelineOffsetMs !== expected.timelineOffsetMs) {
    throw new Error("S3 manifest track does not match the database snapshot");
  }
  const bytes = await get({
    checksumSha256: expected.checksumSha256,
    locator: expected.audioLocator,
    revision: expected.artifactRevision,
    sizeBytes: expected.sizeBytes,
  });
  tracks.push({
    artifactRevision: expected.artifactRevision,
    checksumSha256: expected.checksumSha256,
    durationMs: durationMs(bytes),
    locator: expected.audioLocator,
    sizeBytes: expected.sizeBytes,
    speakerId: expected.speakerId,
    timelineOffsetMs: expected.timelineOffsetMs,
  });
}
console.log(JSON.stringify({
  endedAt: manifest.endedAt,
  manifestChecksumSha256: identity.manifestChecksumSha256,
  manifestLocator: identity.manifestLocator,
  manifestRevision: identity.manifestRevision,
  manifestSizeBytes: identity.manifestSizeBytes,
  recordingId: manifest.recordingId,
  sourceChecksumSha256: manifest.source.checksumSha256,
  startedAt: manifest.startedAt,
  tracks,
}));
await client.destroy();
`;


const replayConnectionScript = String.raw`
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const redisUrl = (await readFile(process.env.REDIS_URL_FILE, "utf8")).trim();
const url = new URL(redisUrl);
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
  db: Number(url.pathname.slice(1) || 0),
};
const meetingId = process.argv[1];
const digest = createHash("sha256")
  .update("post-call-job-v2", "utf8")
  .update("\0", "utf8")
  .update(meetingId, "utf8")
  .digest("hex");
const jobId = "post-call-v2-" + digest;
`;

export const replayReadinessScript = String.raw`
import { Queue } from "bullmq";
${replayConnectionScript}
const queue = new Queue("meeting-post-call-v2", { connection, prefix: "discord-meeting-v2" });
try {
  await queue.waitUntilReady();
  const job = await queue.getJob(jobId);
  if (!job || await job.getState() !== "completed" || !job.processedOn) {
    throw new Error("completed post-call job is unavailable for replay");
  }
  console.log(JSON.stringify({ beforeProcessedOn: job.processedOn, jobId, state: "completed" }));
} finally {
  await queue.close();
}
`;

export const replayJobScript = String.raw`
import { Queue } from "bullmq";
${replayConnectionScript}
const expectedBeforeProcessedOn = Number(process.argv[2]);
const queue = new Queue("meeting-post-call-v2", { connection, prefix: "discord-meeting-v2" });
try {
  await queue.waitUntilReady();
  const job = await queue.getJob(jobId);
  if (
    !job ||
    await job.getState() !== "completed" ||
    job.processedOn !== expectedBeforeProcessedOn
  ) {
    throw new Error("post-call job changed after replay safety preflight");
  }
  await job.retry("completed");
  const deadline = Date.now() + 300000;
  let fresh;
  while (Date.now() < deadline) {
    fresh = await queue.getJob(jobId);
    if (fresh && await fresh.getState() === "completed" && (fresh.processedOn || 0) > expectedBeforeProcessedOn) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!fresh || await fresh.getState() !== "completed" || (fresh.processedOn || 0) <= expectedBeforeProcessedOn) {
    throw new Error("real replay did not complete before deadline");
  }
  console.log(JSON.stringify({
    afterProcessedOn: fresh.processedOn,
    beforeProcessedOn: expectedBeforeProcessedOn,
    jobId,
    state: "completed",
  }));
} finally {
  await queue.close();
}
`;
/* oxlint-disable max-lines -- script fixture embeds complete deployment probe */
