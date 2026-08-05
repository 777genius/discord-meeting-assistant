import { describe, expect, it } from "vitest";

import { PrometheusMetrics } from "../src/index.js";

describe("PrometheusMetrics", () => {
  it("exposes counters, gauges, and cumulative stage histograms", () => {
    const metrics = new PrometheusMetrics();
    metrics.recordIngress("accepted", "accepted");
    metrics.recordIngress("dropped", "over-capacity");
    metrics.recordDerivedLiveFailure("lifecycle");
    metrics.setQueueState("waiting", 4);
    metrics.recordQueueRetry("timeout");
    metrics.recordDeadLetter("attempts-exhausted");
    metrics.observeStage("transcription", "succeeded", 2);
    metrics.observeStage("transcription", "succeeded", 7);
    metrics.recordDiscordPublication("reconciled");
    metrics.setProviderHealth("stt", "healthy");

    const exposition = metrics.render();
    expect(exposition).toContain(
      'discord_meeting_ingress_total{outcome="accepted",reason="accepted"} 1',
    );
    expect(exposition).toContain(
      'discord_meeting_derived_live_failures_total{phase="lifecycle"} 1',
    );
    expect(exposition).toContain(
      'discord_meeting_queue_jobs{state="waiting"} 4',
    );
    expect(exposition).toContain(
      'discord_meeting_queue_retries_total{cause="timeout"} 1',
    );
    expect(exposition).toContain(
      'discord_meeting_queue_dead_letters_total{cause="attempts-exhausted"} 1',
    );
    expect(exposition).toContain(
      'discord_meeting_stage_duration_seconds_bucket{le="2.5",outcome="succeeded",stage="transcription"} 1',
    );
    expect(exposition).toContain(
      'discord_meeting_stage_duration_seconds_bucket{le="10",outcome="succeeded",stage="transcription"} 2',
    );
    expect(exposition).toContain(
      'discord_meeting_stage_duration_seconds_sum{outcome="succeeded",stage="transcription"} 9',
    );
    expect(exposition).toContain(
      'discord_meeting_stage_outcomes_total{outcome="succeeded",stage="transcription"} 2',
    );
    expect(exposition).toContain(
      'discord_meeting_discord_publications_total{outcome="reconciled"} 1',
    );
    expect(exposition).toContain(
      'discord_meeting_provider_health{dependency="stt"} 1',
    );
  });

  it("renders valid OpenMetrics termination", () => {
    const metrics = new PrometheusMetrics();
    metrics.recordIngress("accepted", "accepted");

    expect(metrics.render("openmetrics")).toMatch(/# EOF\n$/u);
  });

  it("rejects unbounded labels and invalid measurements at runtime", () => {
    const metrics = new PrometheusMetrics();

    expect(() => {
      metrics.observeStage("meeting-42" as never, "succeeded", 1);
    }).toThrow(/bounded label/u);
    expect(() => {
      metrics.setQueueState("speaker-7" as never, 1);
    }).toThrow(/bounded label/u);
    expect(() => {
      metrics.setProviderHealth("tenant-123" as never, "healthy");
    }).toThrow(/bounded label/u);
    expect(() => {
      metrics.recordIngress("accepted", "invalid");
    }).toThrow(/inconsistent/u);
    expect(() => {
      metrics.recordDerivedLiveFailure("recording-42" as never);
    }).toThrow(/bounded label/u);
    expect(() => {
      metrics.observeStage("summary", "succeeded", Number.NaN);
    }).toThrow(/finite non-negative/u);

    expect(metrics.render()).not.toContain("meeting-42");
    expect(metrics.render()).not.toContain("speaker-7");
    expect(metrics.render()).not.toContain("tenant-123");
  });
});
