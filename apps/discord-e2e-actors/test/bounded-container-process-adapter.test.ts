import { describe, expect, it } from "vitest";

import { BoundedContainerProcessAdapter } from
  "../src/bounded-container-process-adapter.js";

const executeNode = (
  source: string,
  options: Readonly<{
    maximumOutputBytes?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }> = {},
) => new BoundedContainerProcessAdapter({
  environment: { SENTINEL: "trusted" },
  terminationGraceMs: 100,
}).execute({
  args: ["-e", source],
  executable: process.execPath,
  maximumOutputBytes: options.maximumOutputBytes ?? 4_096,
  ...(options.signal === undefined ? {} : { signal: options.signal }),
  timeoutMs: options.timeoutMs ?? 2_000,
});

describe("bounded container process adapter", () => {
  it("uses the supplied executable and argv without a shell or inherited environment", async () => {
    const shellText = "$(printf unsafe); ' quoted ; text";
    const result = await executeNode(
      "process.stdout.write(JSON.stringify({argv:process.argv[1],env:process.env}))",
      { maximumOutputBytes: 16_384 },
    );
    const explicit = await new BoundedContainerProcessAdapter({
      environment: { SENTINEL: "trusted" }, terminationGraceMs: 100,
    }).execute({
      args: ["-e", "process.stdout.write(JSON.stringify({argv:process.argv[1],env:process.env}))", shellText],
      executable: process.execPath, maximumOutputBytes: 16_384, timeoutMs: 2_000,
    });

    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
    const observed = JSON.parse(explicit.stdout) as { argv: string; env: Record<string, string> };
    expect(observed.argv).toBe(shellText);
    expect(observed.env.SENTINEL).toBe("trusted");
    expect(observed.env.PATH).toBeUndefined();
    expect(observed.env.HOME).toBeUndefined();
  });

  it("captures stdout and stderr and reports the exact non-zero exit", async () => {
    const result = await executeNode(
      "process.stdout.write('out');process.stderr.write('err');process.exitCode=7",
    );
    expect(result).toEqual({
      exitCode: 7, signal: null, stderr: "err", stdout: "out", timedOut: false,
    });
  });

  it("times out and settles only after terminating the child", async () => {
    const result = await executeNode("setInterval(()=>{},1_000)", { timeoutMs: 30 });
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(true);
  });

  it("terminates descendants in the isolated POSIX process group", async () => {
    const source = [
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      "process.stdout.write(String(child.pid)+'\\n')",
      "setInterval(()=>{},1000)",
    ].join(";");
    const result = await executeNode(source, { timeoutMs: 250 });
    const descendantPid = Number.parseInt(result.stdout, 10);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(() => { process.kill(descendantPid, 0); }).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("honors AbortSignal without misreporting a timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => { controller.abort(); }, 30).unref();
    const result = await executeNode("setInterval(()=>{},1_000)", {
      signal: controller.signal, timeoutMs: 2_000,
    });
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
  });

  it("enforces one hard combined stdout and stderr byte cap", async () => {
    const result = await executeNode(
      "process.stdout.write('123456');process.stderr.write('abcdef');setInterval(()=>{},1_000)",
      { maximumOutputBytes: 10 },
    );
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(10);
    expect(result.stdout).toBe("123456");
    expect(result.stderr).toBe("abcd");
    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
  });

  it("rejects spawn failures without leaking an unhandled rejection", async () => {
    const adapter = new BoundedContainerProcessAdapter({ terminationGraceMs: 100 });
    await expect(adapter.execute({
      args: [], executable: "/definitely/not/a/real/executable",
      maximumOutputBytes: 10, timeoutMs: 100,
    })).rejects.toMatchObject({ code: "ENOENT" });
  });
});
