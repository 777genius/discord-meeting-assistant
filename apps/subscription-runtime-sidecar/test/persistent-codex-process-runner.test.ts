import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  conversationAnswerExecutionProfile,
  finalSummaryExecutionProfile,
  providerConversationAnswerJsonSchema,
  providerMeetingSummaryJsonSchema,
  type JsonObject,
} from "@discord-meeting/subscription-runtime-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PersistentCodexProcessRunner,
  type PersistentCodexProcessRunnerOptions,
  type PersistentCodexProfile,
} from "../src/persistent-codex-process-runner.js";
import type { RuntimeWorker } from "../src/persistent-codex-process-contracts.js";
import type { ProcessRunRequest } from "../src/types.js";
import {
  canonicalRequest,
  conversationCanonicalRequest,
} from "./fixture.js";

const conversationProfile: PersistentCodexProfile = {
  execution: conversationAnswerExecutionProfile,
  outputSchema: providerConversationAnswerJsonSchema,
};
const finalSummaryProfile: PersistentCodexProfile = {
  execution: finalSummaryExecutionProfile,
  outputSchema: providerMeetingSummaryJsonSchema,
};
let root: string | undefined;
let runners: PersistentCodexProcessRunner[] = [];

describe("PersistentCodexProcessRunner", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(runners.map((runner) => runner.dispose()));
    runners = [];
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true });
    }
    root = undefined;
  });

  it("identifies the warm app-server execution engine", identifiesRuntimeEngine);

  it("creates and prewarms one conversation worker, then reuses it for two requests", async () => {
    const fixture = await createFixture();

    await fixture.runner.prewarm(
      conversationProfile,
      fixture.environment,
      "slot-1",
    );
    const first = await fixture.runner.run(await requestFor(
      fixture,
      "conversation-first",
      conversationCanonicalRequest,
    ));
    const second = await fixture.runner.run(await requestFor(
      fixture,
      "conversation-second",
      conversationCanonicalRequest,
    ));

    expect(fixture.state.modulePaths).toHaveLength(1);
    expect(fixture.state.poolModulePaths[0]).toMatch(
      /\/dist\/worker-core\/index\.js$/u,
    );
    expect(fixture.state.workers).toHaveLength(1);
    const worker = requiredWorker(fixture.state, 0);
    expect(worker.startCalls).toBe(1);
    expect(worker.seededAuthPaths).toEqual([fixture.authJsonPath]);
    expect(worker.prewarmCalls).toBe(1);
    expect(worker.runInputs).toHaveLength(2);
    expect(worker.runInputs[0]?.systemPrompt).toContain(
      conversationCanonicalRequest.task.systemPrompt,
    );
    expect(worker.runInputs[0]?.systemPrompt).toContain(
      "Return only one JSON value with no markdown or commentary.",
    );
    expect(worker.runInputs[0]?.systemPrompt).toContain(
      JSON.stringify(providerConversationAnswerJsonSchema),
    );
    expect(worker.options).toMatchObject({
      cleanThreadPrewarm: true,
      executionEngine: "app-server",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      sessionCacheSlots: 1,
      sourceEnv: { PATH: "/test/bin" },
      workerId:
        "discord-meeting-discord_meeting-conversation-answer-slot-1:slot-1",
    });
    expect(JSON.parse(first.stdout)).toMatchObject({
      outputText: conversationCanonicalRequest.runId,
      status: "completed",
    });
    expect(JSON.parse(second.stdout)).toMatchObject({
      outputText: conversationCanonicalRequest.runId,
      status: "completed",
    });
  });

  it(
    "delegates concurrent work for one account to native bounded worker slots",
    delegatesConcurrentWorkToNativePool,
  );

  it("starts with a partially healthy account pool", async () => {
    const partiallyHealthy = await createFixture(2);
    partiallyHealthy.state.prewarm = async (worker) => {
      if (worker.options.workerId ===
        "discord-meeting-discord_meeting-conversation-answer-slot-1:slot-1") {
        throw new Error("synthetic unavailable account");
      }
    };

    await expect(partiallyHealthy.runner.prewarmAccounts(
      conversationProfile,
      partiallyHealthy.environment,
    )).resolves.toEqual({
      failures: [{ code: "backend_unavailable", slotId: "slot-1" }],
      readyAccounts: 1,
      totalAccounts: 2,
    });
  });

  it("fails closed when no account prewarms", async () => {
    const unavailable = await createFixture(2);
    unavailable.state.prewarm = async () => {
      throw new Error("synthetic unavailable account");
    };
    await expect(unavailable.runner.prewarmAccounts(
      conversationProfile,
      unavailable.environment,
    )).rejects.toThrow("account pool prewarm failed");
  });

  it("forwards provider lifecycle and text deltas from the warm worker", async () => {
    const fixture = await createFixture();
    fixture.state.run = async (input, options) => {
      await options?.onProviderTaskStarted?.();
      options?.onProviderTextDelta?.('{"answer":"');
      options?.onProviderTextDelta?.('Привет"}');
      return successfulWorkerResult(input);
    };
    const events: string[] = [];

    const result = await fixture.runner.runStreaming(
      await requestFor(fixture, "conversation-stream", conversationCanonicalRequest),
      {
        onProviderTaskStarted: () => {
          events.push("started");
        },
        onProviderTextDelta: (text) => events.push(text),
      },
    );

    expect(events).toEqual(["started", '{"answer":"', 'Привет"}']);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed" });
    expect(fixture.state.workers).toHaveLength(1);
  });

  it(
    "preserves a nested quota failure for account failover",
    preservesNestedQuotaFailure,
  );

  it("creates distinct prewarmed workers for distinct purpose profiles", async () => {
    const fixture = await createFixture();

    await fixture.runner.run(await requestFor(
      fixture,
      "conversation",
      conversationCanonicalRequest,
    ));
    await fixture.runner.run(await requestFor(
      fixture,
      "final-summary",
      canonicalRequest,
    ));

    expect(fixture.state.modulePaths).toHaveLength(2);
    expect(fixture.state.workers).toHaveLength(2);
    expect(fixture.state.workers.map((worker) => worker.prewarmCalls)).toEqual([1, 1]);
    expect(fixture.state.workers.map((worker) => worker.options.workerId)).toEqual([
      "discord-meeting-discord_meeting-conversation-answer-slot-1:slot-1",
      "discord-meeting-discord_meeting-summary-generate-slot-1:slot-1",
    ]);
  });

  it("maps an external AbortSignal to the persistent worker and returns cancellation", async () => {
    const fixture = await createFixture();
    const workerInputStarted = deferred<FakeWorkerInput>();
    fixture.state.run = async (input) => {
      workerInputStarted.resolve(input);
      await waitForAbort(input.abortSignal);
      return successfulWorkerResult(input);
    };
    const controller = new AbortController();
    const execution = fixture.runner.run(await requestFor(
      fixture,
      "conversation-cancelled",
      conversationCanonicalRequest,
      { signal: controller.signal },
    ));

    const workerInput = await workerInputStarted.promise;
    expect(workerInput.abortSignal).not.toBe(controller.signal);
    expect(workerInput.abortSignal.aborted).toBe(false);
    controller.abort();

    await expect(execution).resolves.toMatchObject({
      cancelled: true,
      timedOut: false,
    });
    expect(workerInput.abortSignal.aborted).toBe(true);
  });

  it("disposes every prewarmed worker and refuses later requests", async () => {
    const fixture = await createFixture();

    await fixture.runner.prewarm(
      conversationProfile,
      fixture.environment,
      "slot-1",
    );
    await fixture.runner.prewarm(
      finalSummaryProfile,
      fixture.environment,
      "slot-1",
    );
    await fixture.runner.dispose();
    await fixture.runner.dispose();

    expect(fixture.state.workers).toHaveLength(2);
    expect(fixture.state.workers.map((worker) => worker.disposeCalls)).toEqual([1, 1]);
    await expect(fixture.runner.run(await requestFor(
      fixture,
      "after-dispose",
      conversationCanonicalRequest,
    ))).rejects.toThrow("Persistent Codex runner is disposed");
  });

  it("fails closed for launcher and prewarmed profile mismatches", async () => {
    const fixture = await createFixture();
    const otherLauncherPath = join(fixture.root, "other-launcher.mjs");
    await writeFile(otherLauncherPath, "export {};\n");

    await expect(fixture.runner.run(await requestFor(
      fixture,
      "wrong-launcher",
      conversationCanonicalRequest,
      { command: otherLauncherPath },
    ))).rejects.toThrow("Runtime launcher conflicts with persistent runner policy");
    expect(fixture.state.workers).toHaveLength(0);

    await fixture.runner.prewarm(
      conversationProfile,
      fixture.environment,
      "slot-1",
    );
    const mismatchedProfileRequest = {
      ...conversationCanonicalRequest,
      task: {
        ...conversationCanonicalRequest.task,
        controls: {
          ...conversationCanonicalRequest.task.controls,
          maxOutputTokens: 2_048,
        },
      },
    };

    await expect(fixture.runner.run(await requestFor(
      fixture,
      "mismatched-profile",
      mismatchedProfileRequest,
    ))).rejects.toThrow("Persistent worker profile changed after prewarm");
    expect(requiredWorker(fixture.state, 0).runInputs).toHaveLength(0);
  });

  it("rejects state and account arguments outside the admitted pool policy", async () => {
    const fixture = await createFixture(2);
    const wrongState = await requestFor(
      fixture,
      "wrong-state",
      conversationCanonicalRequest,
    );

    await expect(fixture.runner.run({
      ...wrongState,
      args: replaceArgument(wrongState.args, "--state-root", "/other/state"),
    })).rejects.toThrow("Persistent worker state root conflicts with policy");

    const mismatchedAccount = await requestFor(
      fixture,
      "mismatched-account",
      conversationCanonicalRequest,
    );
    await expect(fixture.runner.run({
      ...mismatchedAccount,
      args: replaceArgument(
        mismatchedAccount.args,
        "--provider-instance",
        "discord-meeting-summary-v3-slot-2",
      ),
    })).rejects.toThrow("Persistent worker account conflicts with policy");
  });
});

async function identifiesRuntimeEngine(): Promise<void> {
  const fixture = await createFixture();
  expect(fixture.runner.runtimeEngine).toBe("subscription-runtime-app-server");
}

async function delegatesConcurrentWorkToNativePool(): Promise<void> {
  const fixture = await createFixture(1, 3);
  const allStarted = deferred<void>();
  const release = deferred<void>();
  let started = 0;
  fixture.state.run = async (input) => {
    started += 1;
    if (started === 3) {
      allStarted.resolve();
    }
    await release.promise;
    return successfulWorkerResult(input);
  };

  const executions = Promise.all([
    fixture.runner.run(await requestFor(
      fixture,
      "parallel-1",
      conversationCanonicalRequest,
    )),
    fixture.runner.run(await requestFor(
      fixture,
      "parallel-2",
      conversationCanonicalRequest,
    )),
    fixture.runner.run(await requestFor(
      fixture,
      "parallel-3",
      conversationCanonicalRequest,
    )),
  ]);
  await allStarted.promise;

  expect(fixture.state.poolOptions).toEqual([
    expect.objectContaining({
      poolId: "discord-meeting-discord_meeting-conversation-answer-slot-1",
      prewarmOnStart: true,
      slots: 3,
    }),
  ]);
  expect(fixture.state.workers).toHaveLength(3);
  expect(fixture.state.workers.map((worker) => worker.runInputs.length))
    .toEqual([1, 1, 1]);

  release.resolve();
  await executions;
}

async function preservesNestedQuotaFailure(): Promise<void> {
  const fixture = await createFixture();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  fixture.state.run = async () => {
    throw new Error("Codex usage limit exhausted");
  };

  const result = await fixture.runner.run(await requestFor(
    fixture,
    "conversation-quota",
    conversationCanonicalRequest,
  ));

  expect(JSON.parse(result.stdout)).toMatchObject({
    failure: { code: "quota_limited", retryable: true },
    status: "failed",
  });
}

interface Fixture {
  readonly authJsonPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly launcherPath: string;
  readonly root: string;
  readonly runner: PersistentCodexProcessRunner;
  readonly state: FakeWorkerState;
  readonly workspacePath: string;
}

interface FakeWorkerInput {
  readonly abortSignal: AbortSignal;
  readonly controls: JsonObject;
  readonly kind: "structured-prompt";
  readonly metadata: Readonly<Record<string, string>>;
  readonly outputSchemaName: string;
  readonly prompt: string;
  readonly runId: string;
  readonly systemPrompt: string;
}

interface FakeWorkerResult {
  readonly outputText: string;
  readonly status?: "completed" | "waiting_for_input";
  readonly structuredOutput?: unknown;
  readonly usage?: Readonly<Record<string, number>>;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
}

interface FakeWorkerRunOptions {
  readonly abortSignal?: AbortSignal;
  readonly onProviderTaskStarted?: () => Promise<void> | void;
  readonly onProviderTextDelta?: (text: string) => void;
}

interface FakeWorkerState {
  readonly modulePaths: string[];
  readonly poolModulePaths: string[];
  readonly poolOptions: FakeWorkerPoolOptions[];
  readonly workers: FakeWorker[];
  prewarm: (worker: FakeWorker) => Promise<void>;
  run: (
    input: FakeWorkerInput,
    options?: FakeWorkerRunOptions,
  ) => Promise<FakeWorkerResult>;
}

class FakeWorker {
  public disposeCalls = 0;
  public prewarmCalls = 0;
  public readonly runInputs: FakeWorkerInput[] = [];
  public readonly seededAuthPaths: string[] = [];
  public startCalls = 0;

  public constructor(
    public readonly options: Readonly<Record<string, unknown>>,
    private readonly fakeState: FakeWorkerState,
  ) {
    fakeState.workers.push(this);
  }

  public get state(): string {
    return "ready";
  }

  public get workerId(): string {
    return String(this.options.workerId);
  }

  public async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }

  public async prewarm(): Promise<void> {
    this.prewarmCalls += 1;
    await this.fakeState.prewarm(this);
  }

  public async health(): Promise<unknown> {
    return { status: "healthy" };
  }

  public async run(
    input: FakeWorkerInput,
    options?: FakeWorkerRunOptions,
  ): Promise<FakeWorkerResult> {
    this.runInputs.push(input);
    return await this.fakeState.run(input, options);
  }

  public async seedCodexAuthJsonFile(path: string): Promise<void> {
    this.seededAuthPaths.push(path);
  }

  public async start(): Promise<void> {
    this.startCalls += 1;
  }
}

interface FakeWorkerPoolOptions {
  readonly maxQueueSize: number;
  readonly poolId: string;
  readonly prewarmOnStart: boolean;
  readonly slots: number;
  readonly workerFactory: (input: {
    readonly slotIndex: number;
    readonly workerId: string;
  }) => RuntimeWorker;
}

class FakeWorkerPool {
  private readonly busy: boolean[];
  private readonly workers: RuntimeWorker[];

  public constructor(private readonly options: FakeWorkerPoolOptions) {
    this.workers = Array.from({ length: options.slots }, (_, slotIndex) =>
      options.workerFactory({
        slotIndex,
        workerId: `${options.poolId}:slot-${slotIndex + 1}`,
      }));
    this.busy = this.workers.map(() => false);
  }

  public async start(): Promise<void> {
    for (const worker of this.workers) {
      await worker.start();
    }
    if (this.options.prewarmOnStart) {
      await Promise.all(this.workers.map(async (worker) => worker.prewarm()));
    }
  }

  public async run(
    input: FakeWorkerInput,
    options?: FakeWorkerRunOptions,
  ): Promise<FakeWorkerResult> {
    const slotIndex = this.busy.findIndex((busy) => !busy);
    if (slotIndex < 0) {
      throw new Error("Synthetic worker pool has no available slot");
    }
    const worker = this.workers[slotIndex];
    if (worker === undefined) {
      throw new Error("Synthetic worker pool slot is invalid");
    }
    this.busy[slotIndex] = true;
    try {
      return await worker.run(input, options);
    } catch (error: unknown) {
      throw new Error("Worker pool slot failed to run a task", { cause: error });
    } finally {
      this.busy[slotIndex] = false;
    }
  }

  public async dispose(): Promise<void> {
    await Promise.all(this.workers.map(async (worker) => worker.dispose()));
  }
}

async function createFixture(
  accountCount = 1,
  maximumConcurrentTasksPerAccount = 1,
): Promise<Fixture> {
  const testRoot = await mkdtemp(join(tmpdir(), "persistent-codex-runner-test-"));
  root = testRoot;
  const launcherPath = join(testRoot, "launcher.mjs");
  const packageManifestPath = join(testRoot, "package.json");
  const authJsonPath = join(testRoot, "auth.json");
  const authJsonPaths = Array.from(
    { length: accountCount },
    (_, index) => index === 0
      ? authJsonPath
      : join(testRoot, `auth-${index + 1}.json`),
  );
  const stateRoot = join(testRoot, "state");
  const workspacePath = join(testRoot, "workspace");
  await Promise.all([
    mkdir(stateRoot),
    mkdir(workspacePath),
    ...authJsonPaths.map(async (path) => writeFile(path, "{}")),
    writeFile(
      launcherPath,
      "export function admitMeetingSummaryRequest() {}\n",
    ),
    writeFile(packageManifestPath, "{}"),
  ]);
  const state: FakeWorkerState = {
    modulePaths: [],
    poolModulePaths: [],
    poolOptions: [],
    workers: [],
    prewarm: async () => {},
    run: async (input) => successfulWorkerResult(input),
  };
  const environment = {
    AGENT_RUNTIME_REASONING_EFFORT: "low",
    PATH: "/test/bin",
    SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY: "test-encryption-key",
  };
  const runner = new PersistentCodexProcessRunner({
    accounts: authJsonPaths.map((path, index) => ({
      authJsonPath: path,
      id: `slot-${index + 1}`,
      providerInstanceId: index === 0
        ? "discord-meeting-summary-v3"
        : `discord-meeting-summary-v3-slot-${index + 1}`,
    })),
    launcherPath,
    packageManifestPath,
    stateRoot,
    maximumConcurrentTasksPerAccount,
    maximumQueuedTasks: 256,
    workerPoolModuleLoader: fakeWorkerPoolModuleLoader(state),
    workerModuleLoader: fakeWorkerModuleLoader(state),
    workspacePath,
  });
  runners.push(runner);
  return {
    authJsonPath,
    environment,
    launcherPath,
    root: testRoot,
    runner,
    state,
    workspacePath,
  };
}

function fakeWorkerPoolModuleLoader(
  state: FakeWorkerState,
): NonNullable<PersistentCodexProcessRunnerOptions["workerPoolModuleLoader"]> {
  return async (modulePath) => {
    state.poolModulePaths.push(modulePath);
    return {
      BoundedSubscriptionWorkerPool: class extends FakeWorkerPool {
        public constructor(options: FakeWorkerPoolOptions) {
          state.poolOptions.push(options);
          super(options);
        }
      },
    };
  };
}

function fakeWorkerModuleLoader(
  state: FakeWorkerState,
): NonNullable<PersistentCodexProcessRunnerOptions["workerModuleLoader"]> {
  return async (modulePath) => {
    state.modulePaths.push(modulePath);
    return {
      FileBackendCodexWorker: class FakeFileBackendCodexWorker extends FakeWorker {
        public constructor(options: Readonly<Record<string, unknown>>) {
          super(options, state);
        }
      },
    };
  };
}

async function requestFor(
  fixture: Fixture,
  name: string,
  requestPayload: unknown,
  override: Partial<ProcessRunRequest> = {},
): Promise<ProcessRunRequest> {
  const inputPath = join(fixture.root, `${name}.json`);
  await writeFile(inputPath, JSON.stringify(requestPayload));
  return {
    args: [
      "--input",
      inputPath,
      "--codex-auth-json",
      fixture.authJsonPath,
      "--provider-instance",
      "discord-meeting-summary-v3",
      "--state-root",
      join(fixture.root, "state"),
      "--model",
      controlText(requestPayload, "model"),
    ],
    command: fixture.launcherPath,
    cwd: fixture.workspacePath,
    env: {
      ...fixture.environment,
      AGENT_RUNTIME_REASONING_EFFORT: controlText(
        requestPayload,
        "reasoningEffort",
      ),
    },
    killGraceMs: 50,
    maxStderrBytes: 1_024,
    maxStdoutBytes: 64 * 1_024,
    timeoutMs: 10_000,
    ...override,
  };
}

function replaceArgument(
  args: readonly string[],
  name: string,
  value: string,
): string[] {
  const updated = [...args];
  const index = updated.indexOf(name);
  if (index < 0 || index + 1 >= updated.length) {
    throw new Error(`Request test fixture is missing ${name}`);
  }
  updated[index + 1] = value;
  return updated;
}

function controlText(
  requestPayload: unknown,
  key: "model" | "reasoningEffort",
): string {
  const value = (requestPayload as {
    readonly task?: { readonly controls?: Readonly<Record<string, unknown>> };
  }).task?.controls?.[key];
  if (typeof value !== "string") {
    throw new Error(`Request test fixture is missing ${key}`);
  }
  return value;
}

function successfulWorkerResult(input: FakeWorkerInput): FakeWorkerResult {
  return {
    outputText: input.runId,
    structuredOutput: { answer: input.prompt },
    warnings: [],
  };
}

function requiredWorker(state: FakeWorkerState, index: number): FakeWorker {
  const worker = state.workers[index];
  if (worker === undefined) {
    throw new Error(`Fake worker ${index} was not created`);
  }
  return worker;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolver: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  if (resolver === undefined) {
    throw new Error("Promise resolver was not initialized");
  }
  return { promise, resolve: resolver };
}
