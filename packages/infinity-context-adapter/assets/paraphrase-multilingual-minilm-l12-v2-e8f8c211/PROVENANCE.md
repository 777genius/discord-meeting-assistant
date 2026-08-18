# Pinned multilingual MiniLM tokenizer

- Model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
- Model revision: `e8f8c211226b894fcb81acc59f3b34ba3efd5f42`
- License declared by the exact Hugging Face revision: Apache-2.0
- Source: `https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/e8f8c211226b894fcb81acc59f3b34ba3efd5f42`
- `tokenizer.json` SHA-256: `2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8`
- `tokenizer_config.json` SHA-256: `5036ea374ffedd706e3bef33e2e0d6953cb868ef8a490e76e32ba0faa37a6b9b`
- Embedded maximum input length: 128 tokens

The conformance vectors were observed through `/tokenize` on the disposable,
isolated TEI runtime below and are verified again against the local tokenizer at
Meeting Platform startup. They include special tokens.

- TEI version: `1.8.3`
- TEI build revision: `78502d8e61223d2c73d4bb7aeaea46787e90d596`
- TEI image: `ghcr.io/huggingface/text-embeddings-inference@sha256:c466c97680cc9c2968108c4b1b44ca7729a091a44b61c840d9487f07d42e9099`
- Pooling: mean
- Auto-truncate: enabled by the serving runtime

Production startup performs no model or tokenizer download. It reads only these
vendored artifacts, verifies their raw SHA-256 digests, validates the embedded
maximum, and verifies every conformance token ID. Infinity capability evidence
must independently match the release-configured dense embedding profile ID and
digest before this tokenizer is admitted.
