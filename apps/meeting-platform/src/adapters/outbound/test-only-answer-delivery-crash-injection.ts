import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { z } from "zod";

import type { AnswerDeliveryPort } from "@discord-meeting/meeting-core/publishing";

const armSchema = z.object({
  campaignId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  injectionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  schemaVersion: z.literal(1),
}).strict();
const MAX_CONTROL_FILE_BYTES = 16 * 1024;

export const publicReplyCrashInjectionReceiptV1Schema = armSchema.extend({
  crashAfterPublicReplyEffect: z.literal(true),
  crashedHostProcessId: z.number().int().positive(),
  crashedWorkerId: z.string().min(1).max(256),
  effectId: z.string().min(1).max(512),
  externalReceipt: z.string().min(1).max(512),
  triggeredAt: z.iso.datetime(),
}).strict();

export type TestOnlyAnswerWorkerExit = (
  receipt: z.infer<typeof publicReplyCrashInjectionReceiptV1Schema>,
) => Promise<never>;

export class TestOnlyAnswerDeliveryCrashInjection implements AnswerDeliveryPort {
  readonly #armPath: string;
  readonly #receiptPath: string;

  public constructor(
    private readonly delegate: AnswerDeliveryPort,
    root: string,
    private readonly workerId: string,
    private readonly now: () => number = Date.now,
    private readonly exitWorker: TestOnlyAnswerWorkerExit = exitCurrentWorker,
  ) {
    if (!isAbsolute(root) || normalize(root) !== root || root === "/" ||
      workerId.trim().length === 0 || workerId.length > 256) {
      throw new Error("Test-only public-reply crash injection configuration is invalid");
    }
    this.#armPath = join(root, "public-reply-effect.arm.json");
    this.#receiptPath = join(root, "public-reply-effect.triggered.json");
  }

  public async create(input: Parameters<AnswerDeliveryPort["create"]>[0]): Promise<string> {
    const arm = await this.#readArmIfPresent();
    if (arm !== undefined) {
      const priorReceipt = await this.#readReceiptIfPresent();
      if (priorReceipt !== undefined) {
        if (priorReceipt.campaignId !== arm.campaignId ||
          priorReceipt.injectionId !== arm.injectionId ||
          priorReceipt.effectId === input.effectId) {
          throw new Error("TEST_ONLY_PUBLIC_REPLY_POST_EFFECT_CRASH_ALREADY_TRIGGERED");
        }
        return this.delegate.create(input);
      }
    }
    const externalReceipt = await this.delegate.create(input);
    if (arm === undefined) {
      return externalReceipt;
    }
    const receipt = publicReplyCrashInjectionReceiptV1Schema.parse({
      ...arm,
      crashAfterPublicReplyEffect: true,
      crashedHostProcessId: process.pid,
      crashedWorkerId: this.workerId,
      effectId: input.effectId,
      externalReceipt,
      triggeredAt: new Date(this.now()).toISOString(),
    });
    await writeCreateOnlyJson(this.#receiptPath, receipt);
    return this.exitWorker(receipt);
  }

  public inspect(input: Parameters<AnswerDeliveryPort["inspect"]>[0]) {
    return this.delegate.inspect(input);
  }

  public remove(input: Parameters<AnswerDeliveryPort["remove"]>[0]) {
    return this.delegate.remove(input);
  }

  async #readArmIfPresent() {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.#armPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      assertPrivateControlFile(before);
      const payload = await handle.readFile("utf8");
      const after = await handle.stat();
      assertPrivateControlFile(after);
      if (!sameSnapshot(before, after) || Buffer.byteLength(payload, "utf8") !== before.size) {
        throw new Error("Test-only public-reply crash arm changed while reading");
      }
      return armSchema.parse(JSON.parse(payload) as unknown);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw new Error("Test-only public-reply crash arm is invalid or unreadable", { cause: error });
    } finally {
      await handle?.close();
    }
  }

  async #readReceiptIfPresent() {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.#receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      assertPrivateControlFile(before);
      const payload = await handle.readFile("utf8");
      const after = await handle.stat();
      assertPrivateControlFile(after);
      if (!sameSnapshot(before, after) || Buffer.byteLength(payload, "utf8") !== before.size) {
        throw new Error("Test-only public-reply crash receipt changed while reading");
      }
      return publicReplyCrashInjectionReceiptV1Schema.parse(JSON.parse(payload) as unknown);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw new Error("Test-only public-reply crash receipt is invalid or unreadable", {
        cause: error,
      });
    } finally {
      await handle?.close();
    }
  }
}

async function exitCurrentWorker(): Promise<never> {
  process.kill(process.pid, "SIGKILL");
  return new Promise<never>(() => {});
}

async function writeCreateOnlyJson(path: string, value: unknown): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

function assertPrivateControlFile(status: Stats): void {
  if (!status.isFile() || status.nlink !== 1 || (status.mode & 0o777) !== 0o600 ||
    status.size < 2 || status.size > MAX_CONTROL_FILE_BYTES ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())) {
    throw new Error("Test-only public-reply crash control file is not private and stable");
  }
}

function sameSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.sync();
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? error.code : undefined;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}
