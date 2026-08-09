import { requireNonEmpty, requireNonNegativeInteger } from "./errors.js";

const consensusWindowMs = 5_000;
const maximumRememberedTurns = 256;

export interface FarewellTurnObservation {
  readonly endMs: number;
  readonly presentParticipantCount: number;
  readonly speakerId: string;
  readonly text: string;
  readonly turnId: string;
}

export type FarewellLocale = "en" | "ru" | "unknown";

export type FarewellPolicyDecision =
  | {
      readonly evidenceTurnIds: readonly string[];
      readonly locale: "en" | "ru";
      readonly reason: "explicit-group" | "farewell-consensus" | "last-participant";
      readonly status: "trigger";
    }
  | {
      readonly locale: FarewellLocale;
      readonly reason: "ambiguous";
      readonly status: "review";
    }
  | { readonly reason: "already-attempted" | "duplicate" | "not-farewell" | "unsafe"; readonly status: "ignored" };

interface RecentFarewell {
  readonly endMs: number;
  readonly locale: "en" | "ru";
  readonly speakerId: string;
  readonly turnId: string;
}

/** Deterministic fast-path. Ambiguous language is delegated through `review`. */
export class MeetingFarewellPolicy {
  private attempted = false;
  private readonly observedTurnIds = new Set<string>();
  private readonly recentFarewells: RecentFarewell[] = [];

  public observe(input: FarewellTurnObservation): FarewellPolicyDecision {
    const turnId = requireNonEmpty(input.turnId, "farewell.turnId");
    const speakerId = requireNonEmpty(input.speakerId, "farewell.speakerId");
    const endMs = requireNonNegativeInteger(input.endMs, "farewell.endMs");
    requireNonNegativeInteger(
      input.presentParticipantCount,
      "farewell.presentParticipantCount",
    );
    if (this.attempted) {
      return Object.freeze({ reason: "already-attempted" as const, status: "ignored" as const });
    }
    if (this.observedTurnIds.has(turnId)) {
      return Object.freeze({ reason: "duplicate" as const, status: "ignored" as const });
    }
    this.rememberTurn(turnId);
    const normalized = normalize(input.text);
    const locale = farewellLocale(normalized);
    if (isUnsafe(normalized, input.text)) {
      this.recentFarewells.length = 0;
      return Object.freeze({ reason: "unsafe" as const, status: "ignored" as const });
    }
    if (locale !== "unknown" && isExplicitGroupFarewell(normalized, locale)) {
      return trigger(locale, "explicit-group", [turnId]);
    }
    if (locale !== "unknown" && isFarewellOnly(normalized, locale)) {
      const candidate = { endMs, locale, speakerId, turnId } as const;
      this.rememberFarewell(candidate);
      if (input.presentParticipantCount <= 1) {
        return trigger(locale, "last-participant", [turnId]);
      }
      const peer = this.recentFarewells.find((recent) =>
        recent.speakerId !== speakerId &&
        recent.endMs <= endMs &&
        recent.endMs >= endMs - consensusWindowMs
      );
      if (peer !== undefined) {
        return trigger(locale, "farewell-consensus", [peer.turnId, turnId]);
      }
      return Object.freeze({ locale, reason: "ambiguous" as const, status: "review" as const });
    }
    if (containsFarewellCandidate(normalized)) {
      this.recentFarewells.length = 0;
      return Object.freeze({ locale, reason: "ambiguous" as const, status: "review" as const });
    }
    this.recentFarewells.length = 0;
    return Object.freeze({ reason: "not-farewell" as const, status: "ignored" as const });
  }

  /** Reserves the sole voice attempt before any external classifier/playback effect. */
  public reserve(): boolean {
    if (this.attempted) {
      return false;
    }
    this.attempted = true;
    return true;
  }

  private rememberFarewell(candidate: RecentFarewell): void {
    const cutoff = candidate.endMs - consensusWindowMs;
    while (
      this.recentFarewells[0] !== undefined &&
      this.recentFarewells[0].endMs < cutoff
    ) {
      this.recentFarewells.shift();
    }
    this.recentFarewells.push(candidate);
  }

  private rememberTurn(turnId: string): void {
    if (this.observedTurnIds.size >= maximumRememberedTurns) {
      const oldest = this.observedTurnIds.values().next().value;
      if (oldest !== undefined) {
        this.observedTurnIds.delete(oldest);
      }
    }
    this.observedTurnIds.add(turnId);
  }
}

function containsFarewellCandidate(text: string): boolean {
  return /\b(?:bye|farewell|goodbye|good night|see you|see ya|catch you|talk to you|take care|have a good|wrap|call it a day|done for today|that'?s it)\b/u.test(text) ||
    /(?:пока|до встречи|до свидания|до связи|до завтра|увидимся|услышимся|созвонимся|всего доброго|хорошего (?:дня|вечера|выходных)|спокойной ночи|прощ|заканч|заверша|на сегодня|на этом все)/u.test(text);
}

function farewellLocale(text: string): FarewellLocale {
  if (/\p{Script=Cyrillic}/u.test(text)) {
    return "ru";
  }
  return /[a-z]/u.test(text) ? "en" : "unknown";
}

function isExplicitGroupFarewell(text: string, locale: "en" | "ru"): boolean {
  if (locale === "ru") {
    return /^(?:(?:ну|ладно|хорошо|все),?\s+)*(?:всем\s+(?:пока|до встречи|до свидания|до связи|до завтра|всего доброго|хорошего (?:дня|вечера|выходных))|(?:пока|до встречи|до свидания|до связи|до завтра|всего доброго)\s+(?:всем|коллеги|ребята))(?:\s+(?:завтра|на следующей неделе))?[.!]*$/u.test(text) ||
      /^(?:(?:ну|ладно|хорошо|все),?\s+)*(?:спасибо|благодарю)\s+(?:всех|всем).{0,40}(?:пока|до встречи|до завтра)(?:\s+(?:завтра|на следующей неделе))?[.!]*$/u.test(text) ||
      /^(?:(?:ну|ладно|хорошо|все),?\s+)*(?:на сегодня|на этом)\s+(?:все|закончили|заканчиваем|завершаем)[.!]*$/u.test(text) ||
      /^(?:(?:ну|ладно|хорошо|все),?\s+)*давайте\s+на\s+этом\s+(?:закончим|завершим)(?:\s+(?:встречу|созвон|звонок|на сегодня))?[.!]*$/u.test(text);
  }
  return /^(?:(?:okay|well|alright|so),?\s+)*(?:(?:bye|goodbye|farewell|see you|take care)\s+(?:everyone|everybody|all|team)|(?:good night|have a good (?:day|evening|weekend))\s+(?:everyone|everybody|all|team))(?:\s+(?:tomorrow|next week))?[.!]*$/u.test(text) ||
    /^(?:(?:okay|well|alright|so),?\s+)*(?:thanks?|thank you)\s+(?:everyone|everybody|all|team).{0,40}(?:bye|goodbye|see you)(?:\s+(?:tomorrow|next week))?[.!]*$/u.test(text) ||
    /^(?:(?:okay|well|alright|so),?\s+)*(?:(?:that is|that's) all for today|we(?:'re| are) done for today|let(?:'s| us) (?:wrap(?: up)?(?: here| for today| the (?:call|meeting)(?: here)?)|call it a day))[.!]*$/u.test(text);
}

function isFarewellOnly(text: string, locale: "en" | "ru"): boolean {
  return locale === "ru"
    ? /^(?:ну\s+)?(?:все\s+)?(?:пока|до встречи|до свидания|до связи|до завтра|увидимся|услышимся|созвонимся|всего доброго)[.!]*$/u.test(text)
    : /^(?:well\s+)?(?:bye|goodbye|farewell|see you|see ya|later|catch you later|talk to you later|take care)[.!]*$/u.test(text);
}

function isUnsafe(text: string, rawText: string): boolean {
  if (/[?？]/u.test(rawText)) {
    return true;
  }
  return [
    /\b(?:not|don't|do not|never)\b.{0,30}\b(?:done|finish|wrap|leave|goodbye|bye)\b/u,
    /\b(?:are|should|do) we (?:done|finish|wrap|leave)\b/u,
    /\b(?:he|she|they) (?:said|wrote|says).{0,40}\b(?:bye|goodbye|farewell)\b/u,
    /\bhow (?:do|would) you say (?:bye|goodbye|farewell)\b/u,
    /\b(?:if|when) we (?:finish|wrap|are done)\b/u,
    /\bif\b.{0,60}\b(?:bye|goodbye|farewell|see you|done|finish|wrap)\b/u,
    /\b(?:wrap|finish|end).{0,50}\b(?:and|then)\s+(?:continue|move on)\b/u,
    /\b(?:i have to go|i am leaving|i'm leaving).{0,50}\b(?:you|everyone) (?:continue|stay)\b/u,
    /пока не/u,
    /не (?:заканчиваем|завершаем|закончили|прощаемся)/u,
    /(?:он|она|они) (?:сказал|сказала|сказали|написал|написала|написали).{0,40}(?:пока|до встречи)/u,
    /как (?:сказать|говорят).{0,30}(?:пока|до встречи)/u,
    /(?:если|когда) (?:закончим|завершим|будем заканчивать)/u,
    /если.{0,60}(?:пока|до встречи|законч|заверш|прощ)/u,
    /(?:законч|заверш).{0,50}(?:и|а затем)\s+(?:продолж|перейд)/u,
    /(?:я пошел|я пошёл|я пойду|мне пора|я отключаюсь).{0,50}(?:вы продолжайте|оставайтесь)/u,
    /^(?:пока|до встречи|до свидания|до связи|до завтра)\s*,\s*(?!(?:всем|ребята|коллеги)\b)/u,
    /^(?:bye|goodbye|farewell|see you|take care)\s*,?\s+(?!(?:everyone|everybody|all|team)\b)[a-z]/u,
  ].some((pattern) => pattern.test(text));
}

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[“”«»"]/gu, " ")
    .replace(/ё/gu, "е")
    .replace(/\s+/gu, " ")
    .trim();
}

function trigger(
  locale: "en" | "ru",
  reason: Extract<FarewellPolicyDecision, { readonly status: "trigger" }>["reason"],
  evidenceTurnIds: readonly string[],
): FarewellPolicyDecision {
  return Object.freeze({
    evidenceTurnIds: Object.freeze([...evidenceTurnIds]),
    locale,
    reason,
    status: "trigger" as const,
  });
}
