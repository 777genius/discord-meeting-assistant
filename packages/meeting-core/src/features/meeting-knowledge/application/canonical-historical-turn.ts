import type { HistoricalReleaseBindingV1 } from "../domain/historical-evidence.js";
import type { HistoricalOpaqueIdPort } from "./ports/historical-memory.js";
import type { HistoricalTurnProjection } from "./historical-embedding-windows.js";

function opaque(prefix: string, value: string): string {
  return `${prefix}.${value}`;
}

export function canonicalHistoricalTurn(
  ids: HistoricalOpaqueIdPort,
  binding: HistoricalReleaseBindingV1,
  projection: HistoricalTurnProjection,
): string {
  const { turn } = projection;
  const turnRef = opaque(
    "turn1",
    ids.keyedId("historical-turn", [
      binding.scopeId,
      binding.roomId,
      binding.meetingId,
      binding.transcriptId,
      String(binding.transcriptVersion),
      turn.turnId,
    ]),
  );
  const speakerRef = opaque(
    "actor1",
    ids.keyedId("historical-actor", [
      binding.scopeId,
      binding.roomId,
      binding.meetingId,
      turn.speakerId,
    ]),
  );
  return [
    `turn=${turnRef}`,
    `speaker=${speakerRef}`,
    `start_ms=${turn.startMs}`,
    `end_ms=${turn.endMs}`,
    `source_code_points=${projection.sourceStartCodePoint}:${projection.sourceEndCodePoint}`,
    "text:",
    projection.text,
  ].join("\n");
}
