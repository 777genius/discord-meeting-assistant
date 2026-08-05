import type { StageFailure } from "../../domain/meeting.js";

export type PortResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly failure: StageFailure; readonly ok: false };
