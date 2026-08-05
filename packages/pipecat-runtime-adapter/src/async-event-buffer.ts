interface EventWaiter<Value> {
  readonly resolve: (result: IteratorResult<Value>) => void;
}

export class AsyncEventBuffer<Value> implements AsyncIterable<Value> {
  private readonly values: Value[] = [];
  private readonly waiters: EventWaiter<Value>[] = [];
  private closed = false;

  public constructor(
    private readonly onConsumed: (value: Value) => void = () => {},
  ) {}

  public push(value: Value): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(value);
      return;
    }
    this.onConsumed(value);
    waiter.resolve({ done: false, value });
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
        const value = this.values.shift();
        if (value !== undefined) {
          this.onConsumed(value);
          return { done: false, value };
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
