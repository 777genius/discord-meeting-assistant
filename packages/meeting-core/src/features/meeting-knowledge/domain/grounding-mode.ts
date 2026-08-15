export type HistoricalGroundingMode = "exhaustive_coverage" | "focused_retrieval";

export const MAXIMUM_HISTORICAL_QUESTION_UTF8_BYTES = 4_096 as const;

const exhaustivePatterns = [
  /^(?:was|were|is|are)\b[^?]{0,4096}\b(?:mentioned|discussed|raised|covered|addressed|recorded|present)\b/iu,
  /^(?:do|does|did|has|have|had)\b[^?]{0,4096}\b(?:mention|discuss|raise|cover|address|record)\b/iu,
  /\b(?:all|every|each|entire|exhaustive|complete\s+list|overall\s+history)\b/iu,
  /\b(?:how\s+many|count|number\s+of|no|none|any|anyone|anything|everyone|everything|nobody|nothing|ever|never|absence|absent|throughout|overall|across)\b/iu,
  /\b(?:list|enumerate|summari[sz]e|summary|overview|recap|timeline)\b/iu,
  /\bwhat\s+(?:decisions|actions|commitments|issues|risks|topics|themes)\b/iu,
  /(?:^|\s)(?:все|всех|всё|кажд\S*|никто|никогда|сколько|посчитай|отсутств\S*|был(?:а|о|и)?\s+ли|есть\s+ли|полный\s+список|всю\s+историю|перечисл\S*|резюмир\S*|обзор|итог\S*|хронологи\S*|какие\s+(?:решения|действия|обязательства|риски|темы))(?:\s|$)/iu,
] as const;

/** Top-k is never selected for a claim whose truth requires visiting all evidence. */
export function classifyHistoricalGroundingMode(question: string): HistoricalGroundingMode {
  const normalized = normalizeHistoricalQuestion(question);
  return exhaustivePatterns.some((pattern) => pattern.test(normalized))
    ? "exhaustive_coverage"
    : "focused_retrieval";
}

/** One canonical, bounded question representation is shared by both retrieval modes. */
export function normalizeHistoricalQuestion(question: string): string {
  const normalized = question.normalize("NFKC").trim();
  if (
    normalized.length === 0 ||
    new TextEncoder().encode(normalized).byteLength >
      MAXIMUM_HISTORICAL_QUESTION_UTF8_BYTES
  ) {
    throw new RangeError(
      `historical question must contain at most ${MAXIMUM_HISTORICAL_QUESTION_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  return normalized;
}
