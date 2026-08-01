import { describe, expect, it } from "vitest";

import {
  createJsonLogger,
  currentCorrelation,
  runWithCorrelation,
  type LogDestination,
} from "../src/index.js";

class MemoryDestination implements LogDestination {
  public readonly lines: string[] = [];

  public write(message: string): void {
    this.lines.push(message);
  }

  public records(): Record<string, unknown>[] {
    return this.lines
      .join("")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

describe("JSON logger", () => {
  it("recursively redacts secrets, content fields, and binary values", async () => {
    const destination = new MemoryDestination();
    const logger = createJsonLogger({ destination, timestamp: false });

    logger.info("authorization: raw-header", {
      apiKey: "api-key-value",
      audioBuffer: Buffer.from("raw-audio-value"),
      headers: {
        Authorization: "Bearer bearer-value",
        cookie: "session=cookie-value",
      },
      nested: {
        providerOutput: "provider-output-value",
        providerResponse: "provider-response-value",
        transcript: "transcript-value",
      },
      promptText: "prompt-value",
      safe: "retained",
    });
    await logger.flush();

    const serialized = destination.lines.join("");
    expect(serialized).not.toContain("raw-header");
    expect(serialized).not.toContain("api-key-value");
    expect(serialized).not.toContain("raw-audio-value");
    expect(serialized).not.toContain("bearer-value");
    expect(serialized).not.toContain("cookie-value");
    expect(serialized).not.toContain("provider-output-value");
    expect(serialized).not.toContain("provider-response-value");
    expect(serialized).not.toContain("transcript-value");
    expect(serialized).not.toContain("prompt-value");
    expect(serialized).toContain("retained");
    expect(serialized).toContain("[REDACTED]");
  });

  it("serializes production errors without messages, stack, causes, or provider payload", async () => {
    const destination = new MemoryDestination();
    const logger = createJsonLogger({
      destination,
      environment: "production",
      timestamp: false,
    });
    const error = Object.assign(
      new Error("provider-output-secret in error message", {
        cause: new Error("nested-cause-secret"),
      }),
      {
        code: "PROVIDER_UNAVAILABLE",
        providerPayload: "payload-secret",
      },
    );

    logger.error("provider request failed", { error });
    await logger.flush();

    const serialized = destination.lines.join("");
    expect(serialized).not.toContain("provider-output-secret");
    expect(serialized).not.toContain("nested-cause-secret");
    expect(serialized).not.toContain("payload-secret");
    expect(serialized).not.toContain("stack");
    expect(destination.records()[0]?.error).toEqual({
      code: "PROVIDER_UNAVAILABLE",
      name: "Error",
    });
  });

  it("merges child context deterministically and gives call fields precedence", async () => {
    const destination = new MemoryDestination();
    const logger = createJsonLogger({
      baseContext: { component: "worker", version: 1 },
      destination,
      timestamp: false,
    });
    const child = logger.child({ alpha: 1, component: "post-call", zeta: 3 });

    child.info("processed", { component: "transcription", outcome: "succeeded" });
    await child.flush();

    expect(destination.records()[0]).toMatchObject({
      alpha: 1,
      component: "transcription",
      outcome: "succeeded",
      version: 1,
      zeta: 3,
    });
  });

  it("isolates correlation across concurrent async request chains", async () => {
    const destination = new MemoryDestination();
    const logger = createJsonLogger({ destination, timestamp: false });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = runWithCorrelation({ requestId: "request-a" }, async () => {
      await gate;
      logger.info("first");
    });
    const second = runWithCorrelation(
      { requestId: "request-b", traceId: "trace-b" },
      async () => {
        release?.();
        await Promise.resolve();
        logger.info("second");
      },
    );
    await Promise.all([first, second]);
    await logger.flush();

    const byMessage = new Map(
      destination.records().map((record) => [record.message, record]),
    );
    expect(byMessage.get("first")).toMatchObject({ requestId: "request-a" });
    expect(byMessage.get("first")).not.toHaveProperty("traceId");
    expect(byMessage.get("second")).toMatchObject({
      requestId: "request-b",
      traceId: "trace-b",
    });
    expect(currentCorrelation()).toBeUndefined();
  });

  it("rejects unsafe correlation identifiers", () => {
    expect(() => {
      runWithCorrelation({ requestId: "Bearer secret value" }, () => null);
    }).toThrow(/requestId/u);
  });
});
