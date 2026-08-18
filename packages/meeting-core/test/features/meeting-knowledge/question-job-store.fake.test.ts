import { expect, it } from "vitest";

import type {
  QuestionJobLease,
  QuestionJobStore,
  QuestionJobTerminalOutcome,
} from "../../../src/features/meeting-knowledge/index.js";

export class QuestionJobStoreFake implements QuestionJobStore {
  public activeLeaseResults: boolean[] = [];
  public plans: Parameters<QuestionJobStore["persistGroundingPlan"]>[0][] = [];
  public ready: Parameters<QuestionJobStore["markReady"]>[0][] = [];
  public retries: Parameters<QuestionJobStore["releaseForRetry"]>[0][] = [];
  public providerReservations:
    Parameters<QuestionJobStore["reserveProviderAttempt"]>[0][] = [];
  public providerOutcomes:
    Parameters<QuestionJobStore["recordProviderAttemptOutcome"]>[0][] = [];
  public providerReservationResult = true;
  public providerOutcomeResult = true;
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

  public recordProviderAttemptOutcome(
    input: Parameters<QuestionJobStore["recordProviderAttemptOutcome"]>[0],
  ): Promise<boolean> {
    this.providerOutcomes.push(input);
    return Promise.resolve(this.providerOutcomeResult);
  }

  public persistGroundingPlan(
    input: Parameters<QuestionJobStore["persistGroundingPlan"]>[0],
  ): Promise<boolean> {
    this.plans.push(input);
    return Promise.resolve(true);
  }

  public markReady(
    input: Parameters<QuestionJobStore["markReady"]>[0],
  ): Promise<boolean> {
    this.ready.push(input);
    return Promise.resolve(true);
  }

  public releaseForRetry(
    input: Parameters<QuestionJobStore["releaseForRetry"]>[0],
  ): Promise<boolean> {
    this.retries.push(input);
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
