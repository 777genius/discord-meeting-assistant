import {
  PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME,
  PinnedMultilingualMiniLmTokenizer,
} from "../../src/index.js";

const tokenizer = new PinnedMultilingualMiniLmTokenizer();
const samples = Object.freeze([
  "Hello, world!",
  "Привет, мир!",
  "你好，世界。",
  "👋🏽🚀",
  "é café",
  "email@example.com -- 42%",
]);

process.stdout.write(`${JSON.stringify({
  counts: samples.map((text) => tokenizer.countTokens(text)),
  profile: tokenizer.profile,
  runtime: PINNED_HUGGINGFACE_TOKENIZERS_RUNTIME,
})}\n`);
