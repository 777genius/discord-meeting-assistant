/**
 * Reviewed production trust root for the hosted Voicetext semantic canary.
 *
 * Deployment identity is deliberately absent: campaign, container, image and
 * source-revision bindings are supplied separately and proven by admission.
 */
const sourceText = "Meeting Platform сохраняет Craig recording. Затем запускает PostgreSQL pipeline. Решение - выпустить версию в пятницу. Повторяю решение - выпуск версии в пятницу. До седьмого августа две тысячи двадцать шестого года спикер Б проверит Discord thread. Повторяю - Discord thread будет проверен в две тысячи двадцать шестом году.";

export const HOSTED_VOICETEXT_CANARY_BINDING_V1 = Object.freeze({
  endpoint: Object.freeze({
    batch: Object.freeze({
      origin: "https://api.voicetext.site",
      path: "/api/v1/transcribe/batch",
    }),
    live: Object.freeze({
      origin: "wss://api.voicetext.site",
      path: "/api/v1/transcribe/stream",
    }),
  }),
  fixture: Object.freeze({
    audioPath: "/app/apps/discord-e2e-actors/test/fixtures/speaker-a.ru-en.ogg",
    audioSha256: "8e29a933ef95eaf1f149b150ff123f90a3276847fcd4941ccb6c55b24561b9d8",
    durationMs: 26_235,
    fixtureId: "speaker-a",
    sourcePath: "/app/apps/discord-e2e-actors/test/fixtures/speaker-a.ru-en.txt",
    sourceSha256: "5aa51fdfca1325cf5b78a35927f1a256989dffc5adcf50cd6d8e5c02b0493a44",
    sourceText,
  }),
  fixtureExpectation: Object.freeze({
    maximumCharacterErrorRate: 0.2,
    // Batch and live transports may split the same text into different segment
    // counts. WER, CER and required terms carry semantic acceptance; this
    // bounded ceiling prevents transport segmentation from becoming a false
    // negative while still rejecting impossible timestamps.
    maximumTimelineDeltaMs: 60_000,
    maximumWordErrorRate: 0.35,
  }),
  profiles: Object.freeze({
    batch: "deepgram-nova-3",
    live: "deepgram-nova-3",
  }),
  requiredTerms: Object.freeze([
    "Meeting Platform",
    "Craig recording",
    "PostgreSQL pipeline",
    "Discord thread",
    "пятницу",
  ]),
  schemaVersion: 1,
  transcriptExpectation: Object.freeze({
    segments: Object.freeze([
      Object.freeze({
        endMs: 26_235,
        startMs: 0,
        text: sourceText,
      }),
    ]),
    sha256: "4a486be40159fb00ce7209a146290b8fd2624328bcb0f93e8dafd4ad6ff73837",
  }),
} as const);
