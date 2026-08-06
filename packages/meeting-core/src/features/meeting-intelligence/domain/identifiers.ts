import { requireNonEmpty } from "./errors.js";

declare const intelligenceIdentifierBrand: unique symbol;

export type SummaryId = string & {
  readonly [intelligenceIdentifierBrand]: "SummaryId";
};

export const createSummaryId = (value: string): SummaryId =>
  requireNonEmpty(value, "summaryId") as SummaryId;
