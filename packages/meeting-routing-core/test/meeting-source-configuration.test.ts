import { describe, expect, it } from "vitest";

import {
  ConfigureMeetingSource,
  MeetingSourceConfiguration,
  ResolveMeetingPublicationTarget,
  type MeetingSourceConfigurationRepository,
  type MeetingSourceConfigurationSnapshot,
  type MeetingSourceSetupPublisher,
} from "../src/index.js";

const input = {
  configuredByActorId: "administrator-a",
  publicationTargetId: "publication-target-a",
  roomId: "meeting-room-a",
  sourceId: "meeting-source-a",
} as const;

class MemoryRepository implements MeetingSourceConfigurationRepository {
  public snapshot: MeetingSourceConfigurationSnapshot | null = null;
  public saves = 0;
  public conflictRevision: number | null = null;

  public findBySourceId(
    sourceId: string,
  ): Promise<MeetingSourceConfigurationSnapshot | null> {
    return Promise.resolve(
      this.snapshot?.sourceId === sourceId ? this.snapshot : null,
    );
  }

  public save(
    snapshot: MeetingSourceConfigurationSnapshot,
    expectedRevision: number | null,
  ) {
    this.saves += 1;
    if (this.conflictRevision !== null) {
      return Promise.resolve({
        actualRevision: this.conflictRevision,
        status: "conflict" as const,
      });
    }
    const actual = this.snapshot?.revision ?? null;
    if (actual !== expectedRevision) {
      return Promise.resolve({
        actualRevision: actual ?? 0,
        status: "conflict" as const,
      });
    }
    this.snapshot = snapshot;
    return Promise.resolve({ status: "saved" as const });
  }
}

class MemoryPublisher implements MeetingSourceSetupPublisher {
  public calls = 0;
  public failure = false;
  public idempotencyKey: string | null = null;

  public publish(request: { readonly idempotencyKey: string }) {
    this.calls += 1;
    this.idempotencyKey = request.idempotencyKey;
    return Promise.resolve(this.failure
      ? {
          failure: {
            code: "setup-publication-failed" as const,
            message: "failed",
            retryable: true,
          },
          ok: false as const,
        }
      : { ok: true as const });
  }
}

describe("MeetingSourceConfiguration", () => {
  it("creates, restores and materially reconfigures an active route", () => {
    const initial = MeetingSourceConfiguration.configure(input);
    expect(initial.toSnapshot()).toEqual({
      ...input,
      revision: 0,
      status: "active",
    });
    expect(
      MeetingSourceConfiguration.restore(initial.toSnapshot()).toSnapshot(),
    ).toEqual(initial.toSnapshot());
    const changed = initial.reconfigure({
      ...input,
      configuredByActorId: "administrator-b",
      publicationTargetId: "publication-target-b",
    });
    expect(changed.toSnapshot()).toMatchObject({
      configuredByActorId: "administrator-b",
      publicationTargetId: "publication-target-b",
      revision: 1,
    });
  });

  it("reuses the aggregate when the route is unchanged", () => {
    const initial = MeetingSourceConfiguration.configure(input);
    expect(initial.reconfigure({
      ...input,
      configuredByActorId: "administrator-b",
    })).toBe(initial);
  });

  it("accepts opaque provider identities and rejects invalid identifiers", () => {
    expect(MeetingSourceConfiguration.configure(input).sourceId)
      .toBe("meeting-source-a");
    expect(() => MeetingSourceConfiguration.configure({ ...input, sourceId: " " }))
      .toThrow("sourceId must be a non-empty external identifier");
    expect(() => MeetingSourceConfiguration.configure({
      ...input,
      roomId: "x".repeat(257),
    })).toThrow("roomId must be a non-empty external identifier");
  });
});

describe("ConfigureMeetingSource", () => {
  it("verifies, publishes and saves a new configuration", async () => {
    const repository = new MemoryRepository();
    const publisher = new MemoryPublisher();
    let verified = 0;
    const useCase = new ConfigureMeetingSource(repository, {
      verify: () => {
        verified += 1;
        return Promise.resolve({ ok: true });
      },
    }, publisher);

    const result = await useCase.execute(input);

    expect(result.status).toBe("configured");
    expect(verified).toBe(1);
    expect(publisher.calls).toBe(1);
    expect(repository.saves).toBe(1);
  });

  it("rechecks permissions but reuses an unchanged route", async () => {
    const repository = new MemoryRepository();
    repository.snapshot = MeetingSourceConfiguration.configure(input).toSnapshot();
    const publisher = new MemoryPublisher();
    let verified = 0;
    const useCase = new ConfigureMeetingSource(repository, {
      verify: () => {
        verified += 1;
        return Promise.resolve({ ok: true });
      },
    }, publisher);

    expect((await useCase.execute(input)).status).toBe("reused");
    expect(verified).toBe(1);
    expect(publisher.calls).toBe(0);
    expect(repository.saves).toBe(0);
  });

  it("does not persist rejected verification or publication", async () => {
    const repository = new MemoryRepository();
    const publisher = new MemoryPublisher();
    const rejected = new ConfigureMeetingSource(repository, {
      verify: () => Promise.resolve({
        failure: {
          code: "capture-capability-unavailable",
          message: "missing",
          retryable: false,
        },
        ok: false,
      }),
    }, publisher);
    expect((await rejected.execute(input)).status).toBe("rejected");
    expect(repository.saves).toBe(0);

    publisher.failure = true;
    const failedPublish = new ConfigureMeetingSource(repository, {
      verify: () => Promise.resolve({ ok: true }),
    }, publisher);
    expect((await failedPublish.execute(input)).status).toBe("rejected");
    expect(repository.saves).toBe(0);
  });

  it("reports optimistic concurrency conflicts", async () => {
    const repository = new MemoryRepository();
    repository.conflictRevision = 4;
    const result = await new ConfigureMeetingSource(
      repository,
      { verify: () => Promise.resolve({ ok: true }) },
      new MemoryPublisher(),
    ).execute(input);
    expect(result).toEqual({ actualRevision: 4, status: "conflict" });
  });

  it("keeps idempotency identities unambiguous for opaque identifiers", async () => {
    const firstPublisher = new MemoryPublisher();
    const secondPublisher = new MemoryPublisher();
    await new ConfigureMeetingSource(
      new MemoryRepository(),
      { verify: () => Promise.resolve({ ok: true }) },
      firstPublisher,
    ).execute({ ...input, publicationTargetId: "target", roomId: "room|part" });
    await new ConfigureMeetingSource(
      new MemoryRepository(),
      { verify: () => Promise.resolve({ ok: true }) },
      secondPublisher,
    ).execute({ ...input, publicationTargetId: "part|target", roomId: "room" });

    expect(firstPublisher.idempotencyKey).not.toBe(secondPublisher.idempotencyKey);
  });
});

describe("ResolveMeetingPublicationTarget", () => {
  it("resolves only the configured source room", async () => {
    const repository = new MemoryRepository();
    const resolver = new ResolveMeetingPublicationTarget(repository);
    expect(await resolver.execute(input)).toEqual({ status: "not-configured" });
    repository.snapshot = MeetingSourceConfiguration.configure(input).toSnapshot();
    expect(await resolver.execute(input)).toEqual({
      publicationTargetId: input.publicationTargetId,
      status: "configured",
    });
    expect(await resolver.execute({ ...input, roomId: "meeting-room-b" }))
      .toEqual({ status: "room-not-configured" });
  });
});
