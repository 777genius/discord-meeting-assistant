interface EventWaiter<Value> {
  readonly resolve: (result: IteratorResult<Value>) => void;
}

export class AsyncEventBuffer<Value> implements AsyncIterable<Value> {
  private readonly values: Value[] = [];
  private readonly waiters: EventWaiter<Value>[] = [];
  private closed = false;

  public push(value: Value): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(value);
    } else {
      waiter.resolve({ done: false, value });
    }
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<Value> {
    return {
      next: async (): Promise<IteratorResult<Value>> => {
        const queued = this.values.shift();
        if (queued !== undefined) {
          return { done: false, value: queued };
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<Value>>((resolve) => {
          this.waiters.push({ resolve });
        });
      },
    };
  }
}
