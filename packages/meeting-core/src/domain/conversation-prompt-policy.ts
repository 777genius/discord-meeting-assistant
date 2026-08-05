export const CONVERSATION_ALIAS_ONLY_FALLBACK_PROMPT = "Ответь, что ты слушаешь.";

const ADDRESS_WORD = /[\p{L}\p{M}\p{N}_]+/gu;
const LEADING_ADDRESS_IGNORABLE = /^[\s\p{P}]*$/u;
const LEADING_ADDRESS_PUNCTUATION = /^[\s\p{P}]+/u;
const REPEATED_WHITESPACE = /\s+/gu;
const VOCATIVE_PREFIX_PUNCTUATION = /,\s*$/u;
const VOCATIVE_SUFFIX_PUNCTUATION = /^\s*[,!?….;:]+/u;
const FINAL_ADDRESS_IGNORABLE = /^[\s\p{P}]*$/u;
const TERMINAL_QUESTION_PUNCTUATION = /[!?…]+(?=\s*$)/u;
const DELIBERATION_MARKER = /(?:^|[^\p{L}\p{N}_])(?:почему|зачем|объясни|сравни|проанализируй|разбери|обоснуй|спроектируй|архитектур\p{L}*|вариант\p{L}*|как\s+лучше|why|explain|compare|analy[sz]e|reason|design|architecture|trade-?offs?)(?=$|[^\p{L}\p{N}_])/iu;
const PROMPT_WORD = /[\p{L}\p{M}\p{N}_]+/gu;

const ADDRESS_ALIASES = {
  botic: "Botic",
  botik: "Botik",
  botek: "Botik",
  botick: "Botik",
  botica: "Ботика",
  botika: "Ботика",
  botyk: "Botik",
  "ботик": "Ботик",
  "ботика": "Ботика",
  "ботек": "Ботик",
  "ботэк": "Ботик",
  "ботека": "Ботика",
  "ботэка": "Ботика",
  "ботык": "Ботик",
  "ботыка": "Ботика",
} as const;

export type ConversationAlias = (typeof ADDRESS_ALIASES)[keyof typeof ADDRESS_ALIASES];

const ADDRESS_ALIAS_BY_KEY: ReadonlyMap<string, ConversationAlias> = new Map(
  Object.entries(ADDRESS_ALIASES),
);

export interface AddressedConversation {
  readonly alias: ConversationAlias;
  readonly prompt: string;
  readonly usedFallbackPrompt: boolean;
}

function normalizedAlias(word: string): ConversationAlias | undefined {
  return ADDRESS_ALIAS_BY_KEY.get(word.toLowerCase());
}

function stripAddress(normalizedText: string, start: number, end: number): string {
  const rawBefore = normalizedText.slice(0, start);
  const before = LEADING_ADDRESS_IGNORABLE.test(rawBefore)
    ? ""
    : rawBefore.replace(VOCATIVE_PREFIX_PUNCTUATION, "");
  const rawAfter = normalizedText.slice(end);
  const after = rawAfter.replace(LEADING_ADDRESS_PUNCTUATION, "");
  const terminalQuestion = before.length > 0 && after.length === 0
    ? rawAfter.match(TERMINAL_QUESTION_PUNCTUATION)?.[0] ?? ""
    : "";
  return `${before}${terminalQuestion} ${after}`
    .replace(REPEATED_WHITESPACE, " ")
    .trim();
}

function isExplicitAddress(normalizedText: string, start: number, end: number): boolean {
  const before = normalizedText.slice(0, start);
  if (LEADING_ADDRESS_IGNORABLE.test(before)) {
    return true;
  }

  const after = normalizedText.slice(end);
  return (
    VOCATIVE_PREFIX_PUNCTUATION.test(before) &&
    (VOCATIVE_SUFFIX_PUNCTUATION.test(after) || FINAL_ADDRESS_IGNORABLE.test(after))
  );
}

/** Detects an explicit provider-neutral address and derives its prompt. */
export function detectAddressedConversation(text: string): AddressedConversation | null {
  const normalizedText = text.normalize("NFKC");

  for (const match of normalizedText.matchAll(ADDRESS_WORD)) {
    const word = match[0];
    const start = match.index;
    const alias = normalizedAlias(word);
    if (alias === undefined || !isExplicitAddress(normalizedText, start, start + word.length)) {
      continue;
    }

    const prompt = stripAddress(normalizedText, start, start + word.length);
    return Object.freeze({
      alias,
      prompt: prompt.length === 0 ? CONVERSATION_ALIAS_ONLY_FALLBACK_PROMPT : prompt,
      usedFallbackPrompt: prompt.length === 0,
    });
  }

  return null;
}

/** Keeps latency UX deterministic and independent from the text model. */
export function shouldUseConversationDeliberationCue(prompt: string): boolean {
  const normalized = prompt.normalize("NFKC").replace(REPEATED_WHITESPACE, " ").trim();
  if (normalized.length === 0) {
    return false;
  }
  const wordCount = [...normalized.matchAll(PROMPT_WORD)].length;
  return (
    normalized.length >= 96 ||
    wordCount >= 16 ||
    DELIBERATION_MARKER.test(normalized)
  );
}
