import { createHash } from "node:crypto";

import {
  HistoricalIndexPlanError,
  HistoricalIndexPlannerUnavailableError,
  canonicalHistoricalPlannerJson,
  historicalEmbeddingTokenProfileFromProfile,
  planHistoricalEmbeddingWindows,
  type AcceptedFinalMeetingV1,
  type HistoricalEmbeddingPartitions,
  type HistoricalEvidenceBlockPolicyV1,
  type HistoricalIndexPlannerOptionsV1,
  type HistoricalIndexPlannerPort,
  type HistoricalIndexPlannerResultV1,
  type HistoricalPreparedSegmentV1,
  type HistoricalPreparedWindowV1,
  type HistoricalReceiptDigestPort,
  type HistoricalWindowPlanningAction,
  type HistoricalWindowPlanningProfileV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE,
  PinnedMultilingualMiniLmTokenizer,
} from "./pinned-multilingual-minilm-tokenizer.js";

const DEFAULT_JOB_TIMEOUT_MS = 60_000;
const WORKER_REVISION = "meeting-knowledge.exact-window-planner.v1" as const;

export interface CooperativeHistoricalIndexPlannerConfigV1 {
  readonly jobTimeoutMs?: number;
}

export class Sha256HistoricalReceiptDigest implements HistoricalReceiptDigestPort {
  public digestUtf8(value: string): `sha256:${string}` {
    return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
  }
}

const receiptDigest = new Sha256HistoricalReceiptDigest();

function sha256(value: unknown): `sha256:${string}` {
  return receiptDigest.digestUtf8(canonicalHistoricalPlannerJson(value));
}

const profileIdentity = historicalEmbeddingTokenProfileFromProfile(
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE,
);
const maximumInputTokens =
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE.maxInputTokens;
const planningProfile: HistoricalWindowPlanningProfileV1 = Object.freeze({
  digestSha256: sha256({ identity: profileIdentity, maximumInputTokens }),
  identity: profileIdentity,
  maximumInputTokens,
  schemaVersion: "meeting-knowledge.window-planning-profile.v1",
});

export class CooperativeHistoricalIndexPlanner implements HistoricalIndexPlannerPort {
  readonly #jobTimeoutMs: number;
  #busy = false;
  #closed = false;
  #tokenizer: PinnedMultilingualMiniLmTokenizer | undefined;

  public constructor(config: CooperativeHistoricalIndexPlannerConfigV1 = {}) {
    const timeout = config.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 600_000) {
      throw new RangeError("historical window planner configuration is invalid");
    }
    this.#jobTimeoutMs = timeout;
  }

  public async start(): Promise<HistoricalWindowPlanningProfileV1> {
    if (this.#closed) {
      throw unavailable("historical window planner is closed");
    }
    try {
      this.#tokenizer ??= new PinnedMultilingualMiniLmTokenizer();
    } catch (error) {
      throw unavailable("historical exact tokenizer is unavailable", error);
    }
    return planningProfile;
  }

  public async prepareWindows(
    meeting: AcceptedFinalMeetingV1,
    candidatePolicy: HistoricalEvidenceBlockPolicyV1,
    options: HistoricalIndexPlannerOptionsV1 = {},
  ): Promise<HistoricalIndexPlannerResultV1> {
    options.signal?.throwIfAborted();
    if (this.#closed) {
      throw unavailable("historical window planner is closed");
    }
    if (this.#busy) {
      throw unavailable("historical window planner is busy");
    }
    this.#busy = true;
    const deadline = Date.now() + this.#jobTimeoutMs;
    try {
      await this.start();
      const tokenizer = this.#tokenizer!;
      const policy = resolvePolicy(candidatePolicy, tokenizer.profile.maxInputTokens);
      const cooperate = async (): Promise<void> => {
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        options.signal?.throwIfAborted();
        if (this.#closed) {
          throw unavailable("historical window planner closed during a job");
        }
        if (Date.now() > deadline) {
          throw unavailable("historical window planner job timed out");
        }
      };
      const countTokens = async (text: string): Promise<number> => {
        let count: number;
        try {
          count = tokenizer.countTokens(text);
        } catch (error) {
          throw unavailable("historical exact tokenizer failed", error);
        }
        await cooperate();
        return count;
      };
      const selected = await drivePlanner(
        planHistoricalEmbeddingWindows(meeting, policy),
        countTokens,
        cooperate,
      );
      const effectiveTurnOverlap = selected.effectiveTurnOverlap;
      const windows: HistoricalPreparedWindowV1[] = [];
      for (const window of selected.windows) {
        const text = window.map((projection) => projection.text).join("\n");
        windows.push(Object.freeze({
          segments: Object.freeze(window.map((projection) =>
            Object.freeze({
              sourceEndCodePoint: projection.sourceEndCodePoint,
              sourceStartCodePoint: projection.sourceStartCodePoint,
              text: projection.text,
              turnId: projection.turn.turnId,
            } satisfies HistoricalPreparedSegmentV1)
          )),
          tokenCount: await countTokens(text),
        }));
      }
      const withoutReceipt = Object.freeze({
        effectiveTurnOverlap,
        planningProfile,
        windows: Object.freeze(windows),
      });
      const requestSha256 = sha256({ meeting, policy: candidatePolicy });
      return Object.freeze({
        ...withoutReceipt,
        receipt: Object.freeze({
          requestSha256,
          resultSha256: sha256(withoutReceipt),
          schemaVersion: "meeting-knowledge.historical-index-planner-receipt.v1",
          workerRevision: WORKER_REVISION,
        }),
      });
    } finally {
      this.#busy = false;
    }
  }

  public async close(): Promise<void> {
    this.#closed = true;
  }
}

interface ResolvedPolicy {
  readonly maximumEmbeddingTokens: number;
  readonly maxBlockUtf8Bytes: number;
  readonly maxBlocksPerMeeting: number;
  readonly maxTurnsPerBlock: number;
  readonly turnOverlap: number;
}

function resolvePolicy(
  policy: HistoricalEvidenceBlockPolicyV1,
  providerMaximum: number,
): ResolvedPolicy {
  const maximumEmbeddingTokens = Math.min(
    policy.maximumEmbeddingTokens ?? 96,
    providerMaximum,
  );
  const turnOverlap = policy.turnOverlap ?? 2;
  if (
    policy.version !== "meeting-knowledge.block-policy.v1" ||
    !Number.isSafeInteger(maximumEmbeddingTokens) ||
    maximumEmbeddingTokens < 16 ||
    maximumEmbeddingTokens > 512 ||
    !Number.isSafeInteger(policy.maxBlockUtf8Bytes) ||
    policy.maxBlockUtf8Bytes < 256 ||
    policy.maxBlockUtf8Bytes > 32_768 ||
    !Number.isSafeInteger(policy.maxBlocksPerMeeting) ||
    policy.maxBlocksPerMeeting < 1 ||
    policy.maxBlocksPerMeeting > 500 ||
    !Number.isSafeInteger(policy.maxTurnsPerBlock) ||
    policy.maxTurnsPerBlock < 1 ||
    policy.maxTurnsPerBlock > 64 ||
    !Number.isSafeInteger(turnOverlap) ||
    turnOverlap < 0 ||
    turnOverlap > 8 ||
    turnOverlap >= policy.maxTurnsPerBlock
  ) {
    throw new HistoricalIndexPlanError(
      "INVALID_POLICY",
      "historical evidence block policy is outside its qualified bounds",
    );
  }
  return {
    maximumEmbeddingTokens,
    maxBlockUtf8Bytes: policy.maxBlockUtf8Bytes,
    maxBlocksPerMeeting: policy.maxBlocksPerMeeting,
    maxTurnsPerBlock: policy.maxTurnsPerBlock,
    turnOverlap,
  };
}


async function drivePlanner(
  planner: Generator<
    HistoricalWindowPlanningAction,
    HistoricalEmbeddingPartitions,
    number | undefined
  >,
  countTokens: (text: string) => Promise<number>,
  checkpoint: () => Promise<void>,
): Promise<HistoricalEmbeddingPartitions> {
  try {
    let step = planner.next();
    while (!step.done) {
      if (step.value.kind === "checkpoint") {
        await checkpoint();
        step = planner.next();
      } else {
        step = planner.next(await countTokens(step.value.text));
      }
    }
    return step.value;
  } catch (error) {
    if (error instanceof RangeError) {
      throw new HistoricalIndexPlanError("BLOCK_LIMIT_EXCEEDED", error.message);
    }
    throw error;
  }
}

function unavailable(
  message: string,
  cause?: unknown,
): HistoricalIndexPlannerUnavailableError {
  return new HistoricalIndexPlannerUnavailableError(
    cause instanceof Error ? `${message}: ${cause.name}` : message,
  );
}
