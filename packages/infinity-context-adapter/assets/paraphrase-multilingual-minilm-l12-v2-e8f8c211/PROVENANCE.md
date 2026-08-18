# Pinned multilingual MiniLM tokenizer

- Model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
- Model revision: `e8f8c211226b894fcb81acc59f3b34ba3efd5f42`
- License declared by the exact Hugging Face revision: Apache-2.0
- Source: `https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/e8f8c211226b894fcb81acc59f3b34ba3efd5f42`
- `tokenizer.json` SHA-256: `2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8`
- `tokenizer_config.json` SHA-256: `5036ea374ffedd706e3bef33e2e0d6953cb868ef8a490e76e32ba0faa37a6b9b`
- Embedded maximum input length: 128 tokens
- Included license: `LICENSE.apache-2.0.txt`
- Local attribution notice: `NOTICE`

The exact upstream revision did not publish a separate NOTICE file. The local
notice records its declared license, source, revision, and artifact identity.

The local tokenizer runtime is also fail-closed pinned to official
`/tokenizers.1.3`: npm integrity
`sha512-8rF/RRT10u+kn7YuUbUg0OF30K8rjTc78aHpxT+qJ1uWSqxT1MHi8+9ltwYfkFYJzT/oS+qw3JVfHtNMGAdqyA==`,
tarball SHA-256 `0ef814be66cad9c1123859b2b46a7220a6215c4deb9752e1a345c470f06268cb`,
package manifest SHA-256 `2e5425540a964ccbc721566f0e066772c4be7339a4663d9f33c3b04be4d2daaf`,
and runtime SHA-256 `31a6ace9e7b9bab8e16e27b575308fe698546457fc0f78bd9b8729bd1139d7f2`.

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
