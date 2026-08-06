import {
  ProcessMeetingSummary,
} from "@discord-meeting/meeting-core/post-call-workflow";
import {
  type FinalTranscriptionPort,
} from "@discord-meeting/meeting-core/transcription";
import {
  type SummaryGenerationPort,
} from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  type SummaryPublicationPort,
} from "@discord-meeting/meeting-core/publishing";
import type { Logger, PrometheusMetrics } from "@discord-meeting/observability-adapter";
import type { PostgresLiveMeetingRepository, PostgresMeetingRepository } from "@discord-meeting/postgres-adapter";

import {
  InstrumentedFinalTranscriptionPort,
  InstrumentedSummaryGenerationPort,
  InstrumentedSummaryPublicationPort,
} from "../adapters/outbound/instrumented-processing-ports.js";
import { LiveFencedSummaryPublicationPort } from "../application/live-fenced-summary-publication.js";
import type { PlatformLiveMeetingRuntime } from "../live-meeting-runtime.js";

export function createProcessingRuntime(input: {
  readonly live?: PlatformLiveMeetingRuntime;
  readonly liveMeetings: PostgresLiveMeetingRepository;
  readonly logger: Logger;
  readonly meetings: PostgresMeetingRepository;
  readonly metrics: PrometheusMetrics;
  readonly rawPublisher: SummaryPublicationPort;
  readonly rawSummarizer: SummaryGenerationPort;
  readonly rawTranscriber: FinalTranscriptionPort;
}): ProcessMeetingSummary {
  const transcriber = new InstrumentedFinalTranscriptionPort(
    input.rawTranscriber,
    input.metrics,
    input.logger,
    () => performance.now(),
  );
  const summarizer = new InstrumentedSummaryGenerationPort(
    input.rawSummarizer,
    input.metrics,
    input.logger,
    () => performance.now(),
  );
  const finalPublisher = input.live === undefined
    ? input.rawPublisher
    : new LiveFencedSummaryPublicationPort(
        input.rawPublisher,
        input.live,
        input.liveMeetings,
      );
  const publisher = new InstrumentedSummaryPublicationPort(
    finalPublisher,
    input.metrics,
    input.logger,
    () => performance.now(),
  );
  return new ProcessMeetingSummary({
    meetings: input.meetings,
    publisher,
    summarizer,
    transcriber,
  });
}
