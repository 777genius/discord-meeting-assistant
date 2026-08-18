export type HistoricalGroundingMode = "exhaustive_coverage" | "focused_retrieval";

export const MAXIMUM_HISTORICAL_QUESTION_UTF8_BYTES = 4_096 as const;

const quotedText = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/gu;
const aggregateNouns = String.raw`(?:decisions?|actions?|action\s+items?|commitments?|issues?|risks?|topics?|themes?|mentions?|meetings?|задач\S*|решени\S*|действи\S*|обязательств\S*|риск\S*|тем\S*|упоминани\S*|встреч\S*)`;

const exhaustivePatterns = [
  new RegExp(String.raw`\b(?:how\s+many|number\s+of|total(?:\s+number\s+of)?|count(?:\s+of)?)\s+${aggregateNouns}\b`, "iu"),
  new RegExp(String.raw`(?:^|[?!;.])\s*(?:total|count)\s+${aggregateNouns}\b`, "iu"),
  new RegExp(String.raw`(?:^|\s)(?:сколько|посчитай|подсчитай|общее\s+количество|итого)\s+${aggregateNouns}(?:\s|$)`, "iu"),
  /^(?:was|were|is|are)\b[^?]{0,4096}\b(?:mentioned|discussed|raised|covered|addressed|recorded|present|approved)\b/iu,
  /^(?:do|does|did|has|have|had)\b[^?]{0,4096}\b(?:mention|discuss|raise|cover|address|record|approve)\b/iu,
  /\b(?:all|every|each|entire|exhaustive|complete\s+list|overall\s+history|whole\s+(?:meeting|history)|across\s+(?:the\s+)?meetings?)\b/iu,
  /\b(?:none|anyone|anything|everyone|everything|nobody|nothing|ever|never|absence|absent|throughout|overall)\b/iu,
  /\b(?:list|enumerate)\s+(?:all\s+|every\s+|the\s+)?(?:decisions?|actions?|action\s+items?|commitments?|issues?|risks?|topics?|themes?)\b/iu,
  /\b(?:summari[sz]e|summary|overview|recap|timeline)\b/iu,
  /\bwhat\s+(?:decisions|actions|commitments|issues|risks|topics|themes)\b/iu,
  /(?:^|\s)(?:все|всех|всё|кажд\S*|никто|никогда|отсутств\S*|полный\s+список|всю\s+(?:встречу|историю)|перечисл\S*|резюмир\S*|обзор|итог\S*|хронологи\S*|какие\s+(?:решения|действия|обязательства|риски|темы))(?:\s|$)/iu,
  /^(?:был(?:а|о|и)?|есть|обсуждал(?:ся|ась|ось|ись)?|упоминал(?:ся|ась|ось|ись)?|одобрял(?:ся|ась|ось|ись)?)\b[^?]{0,4096}\bли\b/iu,
] as const;

const absenceQuestionPatterns = [
  /^(?:was|were|is|are|do|does|did|has|have|had)\b[^?]{0,4096}\b(?:mention|mentioned|discuss|discussed|raise|raised|cover|covered|address|addressed|record|recorded|approve|approved|present)\b/iu,
  /\b(?:no|none|nobody|nothing|never|ever|absence|absent|without)\b/iu,
  /(?:^|\s)(?:никто|ничто|никогда|нигде|отсутств\S*|не\s+(?:был\S*|упоминал\S*|обсуждал\S*|одобрял\S*))(?:\s|$)/iu,
  /^(?:был(?:а|о|и)?|есть|обсуждал(?:ся|ась|ось|ись)?|упоминал(?:ся|ась|ось|ись)?|одобрял(?:ся|ась|ось|ись)?)\b[^?]{0,4096}\bли\b/iu,
] as const;

const exhaustiveClaimPatterns = [
  /\b(?:all|every|entire|exhaustive|complete\s+(?:authorized\s+)?corpus|overall|in\s+total)\b/iu,
  /\b(?:there\s+(?:are|were|was)|total(?:led)?|exactly)\s+(?:exactly\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/iu,
  /\b(?:there\s+(?:are|were|was)\s+no|none|nobody|nothing|never|was\s+not\s+(?:mentioned|discussed|approved|recorded)|were\s+not\s+(?:mentioned|discussed|approved|recorded))\b/iu,
  /(?:^|\s)(?:все|кажд\S*|полный\S*|во\s+всей|всего\s+\d+|итого\s+\d+|не\s+(?:был\S*\s+)?(?:упомянут\S*|обсужден\S*|одобрен\S*)|никто|никогда)(?:\s|$)/iu,
] as const;

const absenceClaimPatterns = [
  /\b(?:there\s+(?:are|were|was)\s+no|none|nobody|nothing|never|was\s+not\s+(?:mentioned|discussed|approved|recorded)|were\s+not\s+(?:mentioned|discussed|approved|recorded))\b/iu,
  /(?:^|\s)(?:нет|никто|ничто|никогда|не\s+(?:был\S*\s+)?(?:упомянут\S*|обсужден\S*|одобрен\S*|зафиксирован\S*))(?:\s|$)/iu,
] as const;

function withoutQuotedText(value: string): string {
  return value.replace(quotedText, " ");
}

/** Top-k is never selected for a claim whose truth requires visiting all evidence. */
export function classifyHistoricalGroundingMode(question: string): HistoricalGroundingMode {
  const normalized = withoutQuotedText(normalizeHistoricalQuestion(question));
  return exhaustivePatterns.some((pattern) => pattern.test(normalized))
    ? "exhaustive_coverage"
    : "focused_retrieval";
}

export function permitsUncitedExhaustiveAbsence(question: string): boolean {
  const normalized = withoutQuotedText(normalizeHistoricalQuestion(question));
  return absenceQuestionPatterns.some((pattern) => pattern.test(normalized));
}

export function claimRequiresExhaustiveCoverage(claim: string): boolean {
  const normalized = withoutQuotedText(claim.normalize("NFKC").trim());
  return exhaustiveClaimPatterns.some((pattern) => pattern.test(normalized));
}

export function isExhaustiveAbsenceClaim(claim: string): boolean {
  const normalized = withoutQuotedText(claim.normalize("NFKC").trim());
  return absenceClaimPatterns.some((pattern) => pattern.test(normalized));
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
