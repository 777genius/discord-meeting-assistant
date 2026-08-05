/** Serializes operations that mutate one derived live-meeting lifecycle. */
export class RecordingOperationQueue {
  private readonly activeRecordingIds = new Set<string>();
  private readonly chains = new Map<string, Promise<null>>();

  public enqueue<Value>(
    recordingId: string,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    this.activeRecordingIds.add(recordingId);
    const previous = this.chains.get(recordingId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => null,
      () => null,
    );
    this.chains.set(recordingId, tail);
    void tail.finally(() => {
      if (this.chains.get(recordingId) !== tail) {
        return;
      }
      this.chains.delete(recordingId);
      this.activeRecordingIds.delete(recordingId);
    });
    return result;
  }

  public pendingRecordingIds(): readonly string[] {
    return [...this.activeRecordingIds];
  }
}
