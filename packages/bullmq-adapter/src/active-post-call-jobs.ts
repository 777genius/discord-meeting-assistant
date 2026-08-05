export interface ActivePostCallJobLease {
  readonly signal: AbortSignal;
  release(): void;
}

interface ActiveJob {
  readonly controller: AbortController;
  removeWorkerAbortListener?: () => void;
}

interface IdleWaiter {
  reject(error: AggregateError): void;
  resolve(): void;
}

export class ActivePostCallJobs {
  readonly #active = new Map<string, ActiveJob>();
  readonly #idleWaiters = new Set<IdleWaiter>();
  readonly #terminalEffects = new Set<Promise<void>>();
  readonly #terminalEffectFailures: unknown[] = [];
  #shutdownReason: string | undefined;

  public markActive(jobId: string): void {
    this.active(jobId);
  }

  public begin(
    jobId: string,
    workerSignal: AbortSignal | undefined,
  ): ActivePostCallJobLease {
    const active = this.active(jobId);
    const abortFromWorker = (): void => {
      if (!active.controller.signal.aborted) {
        active.controller.abort(workerSignal?.reason);
      }
    };
    if (workerSignal?.aborted === true) {
      abortFromWorker();
    } else {
      workerSignal?.addEventListener("abort", abortFromWorker, { once: true });
    }
    active.removeWorkerAbortListener = () =>
      workerSignal?.removeEventListener("abort", abortFromWorker);
    return this.lease(jobId, active);
  }

  public complete(jobId: string): void {
    const active = this.#active.get(jobId);
    if (active !== undefined) {
      this.release(jobId, active);
    }
  }

  public trackTerminalEffect(effect: Promise<void>): void {
    this.#terminalEffects.add(effect);
    void effect.then(
      () => this.finishTerminalEffect(effect, false),
      (error: unknown) => this.finishTerminalEffect(effect, true, error),
    );
  }

  public cancelAll(reason: string): void {
    this.#shutdownReason ??= reason;
    for (const { controller } of this.#active.values()) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    }
  }

  public isAdmissionClosed(): boolean {
    return this.#shutdownReason !== undefined;
  }

  public waitForIdle(): Promise<void> {
    if (this.isIdle()) {
      return this.resolveIdle();
    }
    return new Promise<void>((resolve, reject) => {
      this.#idleWaiters.add({ reject, resolve });
    });
  }

  public assertTerminalEffectsSucceeded(): void {
    const failure = this.terminalEffectFailure();
    if (failure !== undefined) {
      throw failure;
    }
  }

  private active(jobId: string): ActiveJob {
    const existing = this.#active.get(jobId);
    if (existing !== undefined) {
      return existing;
    }
    const active = { controller: new AbortController() };
    if (this.#shutdownReason !== undefined) {
      active.controller.abort(this.#shutdownReason);
    }
    this.#active.set(jobId, active);
    return active;
  }

  private lease(jobId: string, active: ActiveJob): ActivePostCallJobLease {
    let released = false;
    return {
      signal: active.controller.signal,
      release: () => {
        if (released || this.#active.get(jobId) !== active) {
          return;
        }
        released = true;
        this.release(jobId, active);
      },
    };
  }

  private release(jobId: string, active: ActiveJob): void {
    active.removeWorkerAbortListener?.();
    this.#active.delete(jobId);
    this.notifyIfIdle();
  }

  private finishTerminalEffect(
    effect: Promise<void>,
    rejected: boolean,
    failure?: unknown,
  ): null {
    this.#terminalEffects.delete(effect);
    if (rejected) {
      this.#terminalEffectFailures.push(failure);
    }
    this.notifyIfIdle();
    return null;
  }

  private isIdle(): boolean {
    return this.#active.size === 0 && this.#terminalEffects.size === 0;
  }

  private notifyIfIdle(): void {
    if (!this.isIdle()) {
      return;
    }
    const failure = this.terminalEffectFailure();
    for (const waiter of this.#idleWaiters) {
      if (failure === undefined) {
        waiter.resolve();
      } else {
        waiter.reject(failure);
      }
    }
    this.#idleWaiters.clear();
  }

  private resolveIdle(): Promise<void> {
    const failure = this.terminalEffectFailure();
    return failure === undefined ? Promise.resolve() : Promise.reject(failure);
  }

  private terminalEffectFailure(): AggregateError | undefined {
    if (this.#terminalEffectFailures.length === 0) {
      return undefined;
    }
    return new AggregateError(
      [...this.#terminalEffectFailures],
      "One or more post-call terminal durability effects failed",
    );
  }
}
