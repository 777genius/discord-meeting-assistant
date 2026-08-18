import { expect, it } from "vitest";

import type {
  QuestionJobLease,
  QuestionJobStore,
  QuestionJobTerminalOutcome,
} from "../../../src/features/meeting-knowledge/index.js";

export class QuestionJobStoreFake implements QuestionJobStore {
  public activeLeaseResults: boolean[] = [];
  public plans: Parameters<QuestionJobStore["persistGroundingPlan"]>[0][] = [];
  public providerReservations:
    Parameters<QuestionJobStore["reserveProviderAttempt"]>[0][] = [];
  public providerCompletions:
    Parameters<QuestionJobStore["completeProviderAttempt"]>[0][] = [];
  public providerFailures:
    Parameters<QuestionJobStore["failProviderAttempt"]>[0][] = [];
  public providerReservationResult = true;
  public providerCompletionResult = true;
  public settlements: QuestionJobTerminalOutcome[] = [];

  public constructor(public lease: QuestionJobLease | null) {}

  public hasActiveQuestion(): Promise<boolean> {
    return Promise.resolve(this.lease !== null);
  }

  public confirmActiveLease(): Promise<boolean> {
    return Promise.resolve(this.activeLeaseResults.shift() ?? true);
  }

  public leaseNext(): Promise<QuestionJobLease | null> {
    const selected = this.lease;
    this.lease = null;
    return Promise.resolve(selected);
  }

  public reserveProviderAttempt(
    input: Parameters<QuestionJobStore["reserveProviderAttempt"]>[0],
  ): Promise<boolean> {
    this.providerReservations.push(input);
    return Promise.resolve(this.providerReservationResult);
  }

  public completeProviderAttempt(
    input: Parameters<QuestionJobStore["completeProviderAttempt"]>[0],
  ): Promise<boolean> {
    this.providerCompletions.push(input);
    return Promise.resolve(this.providerCompletionResult);
  }

  public failProviderAttempt(
    input: Parameters<QuestionJobStore["failProviderAttempt"]>[0],
  ): Promise<"deferred" | "settled" | "stale"> {
    this.providerFailures.push(input);
    return Promise.resolve(input.retryable ? "deferred" : "settled");
  }

  public persistGroundingPlan(
    input: Parameters<QuestionJobStore["persistGroundingPlan"]>[0],
  ): Promise<boolean> {
    this.plans.push(input);
    return Promise.resolve(true);
  }

  public settle(input: Parameters<QuestionJobStore["settle"]>[0]): Promise<boolean> {
    this.settlements.push(input.outcome);
    return Promise.resolve(true);
  }

  public cancelQuestion(): Promise<void> {
    return Promise.resolve();
  }
}


it("keeps an empty fake idle", async () => {
  const jobs = new QuestionJobStoreFake(null);
  await expect(jobs.leaseNext()).resolves.toBeNull();
});
