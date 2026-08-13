import type {
  VoicetextBatchClient,
  VoicetextBatchTaskResult,
} from "@discord-meeting/voicetext-adapter";

import { waitForVoicetextCanaryOperation } from "./voicetext-canary-deadline.js";

const maximumAttempts = 100;
const maximumPollDelayMs = 60_000;

export async function completeVoicetextCanaryBatch(
  client: VoicetextBatchClient,
  fixture: Uint8Array,
  idempotencyKey: string,
  wait: (delayMs: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<Extract<VoicetextBatchTaskResult, { kind: "completed" }>> {
  let task = await waitForVoicetextCanaryOperation(
    client.submit({ audio: fixture, idempotencyKey, keyterms: [], signal }), signal,
  );
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    if (task.kind === "completed") {return task;}
    if (task.kind === "failed") {
      throw new Error("Voicetext batch canary returned a terminal provider failure");
    }
    await wait(Math.min(task.retryAfterMs, maximumPollDelayMs), signal);
    task = await waitForVoicetextCanaryOperation(task.nextAction === "retry"
      ? client.submit({ audio: fixture, idempotencyKey, keyterms: [], signal })
      : client.poll({ jobId: task.jobId, signal }), signal);
  }
  throw new Error("Voicetext batch canary exceeded its bounded attempt limit");
}
