import type { ActiveLiveMeeting } from "./live-meeting-state.js";
import type { RecordingOperationQueue } from "./recording-operation-queue.js";

/** Drains one singleton owner while preserving the durable active lifecycle. */
export async function releaseLiveMeetingsForRestart(input: {
  readonly meetings: Map<string, ActiveLiveMeeting>;
  readonly recordingOperations: RecordingOperationQueue;
}): Promise<void> {
  const recordingIds = new Set([
    ...input.meetings.keys(),
    ...input.recordingOperations.pendingRecordingIds(),
  ]);
  const results = await Promise.allSettled([...recordingIds].map(
    (recordingId) => input.recordingOperations.enqueue(recordingId, async () => {
      const state = input.meetings.get(recordingId);
      if (state === undefined) {
        return;
      }
      state.finishing = true;
      state.farewell?.close();
      state.greetings?.close();
      state.conversation?.close();
      state.transcription.beginFinish();
      await state.transcription.finish();
      state.transcriptionFenceClosed = true;
      await state.summary.settle();
      await state.farewell?.settle();
      await state.greetings?.settle();
      await state.conversation?.settle();
      await state.domainChain;
      input.meetings.delete(recordingId);
    }),
  ));
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      failures.push(reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "derived live runtime ownership release failed",
    );
  }
}
