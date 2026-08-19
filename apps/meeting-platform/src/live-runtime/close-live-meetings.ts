import type { LiveMeetingFinalizer } from "./live-meeting-finalizer.js";
import type { RecordingOperationQueue } from "./recording-operation-queue.js";

export async function closeLiveMeetings(input: {
  readonly endedAtMs: number;
  readonly finalizer: LiveMeetingFinalizer;
  readonly recordingIds: ReadonlySet<string>;
  readonly recordingOperations: RecordingOperationQueue;
}): Promise<void> {
  const results = await Promise.allSettled(
    [...input.recordingIds].map((recordingId) =>
      input.recordingOperations.enqueue(recordingId, () =>
        input.finalizer.finishRecording(recordingId, input.endedAtMs)
      )
    ),
  );
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "derived live runtime shutdown failed");
  }
}
