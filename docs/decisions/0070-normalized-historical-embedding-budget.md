---
id: ADR-0070
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0070: Bound normalized historical embedding documents

## Context

Meeting Knowledge previously counted a raw body against a 96-token policy.
The pinned Infinity a917 retrieval surface normalizes and prefixes its opaque
document title. A synthetic 96-token body therefore produced 133 tokens against
the qualified TEI maximum of 128, with auto-truncation disabled.

## Decision

Meeting Knowledge owns the provider-neutral optional body-budget identity and
token-counting port. The existing infinity-context-adapter owns the exact pinned
projection, normalization, tokenizer proof, and pre-SDK document guard. Its new
source is classified in the existing closed adapters.infinity-context boundary;
no new package or cross-context dependency is introduced.

Keep the exact tokenizer's raw count and real maximum of 128. Its qualified
input-budget contract reserves 56 title tokens and exposes a separate maximum
body budget of 72, including existing special tokens. The title is exactly
mkevidence1 plus a dot plus 43 base64url HMAC characters. Lowercase ASCII title
characters and the Metaspace marker all have one-character Unigram pieces;
WhitespaceSplit separates title and body. Thus 55 characters plus one marker
cost at most 56 additional tokens. Validate these pinned tokenizer properties
at initialization and reject malformed titles or full normalized inputs above
128 before SDK ingestion. Never truncate text or change HMAC identity.

Both synchronous and cooperative planners use the same normalized body counter
and budget. Original source slices, offsets, and rehydration remain authoritative.
The input-budget identity participates in token profile, semantic index identity,
and prepared planning-profile digest. Worker receipt revision v2 rejects old
prepared v1 receipts even if their hashes are internally consistent.

Normalization mirrors pinned Python Unicode 15 whitespace and lowercase. The
exhaustive synthetic Unicode oracle proves the supported domain; lone surrogates,
newer incompatible lowercase mappings fail closed. Uppercase Sigma is supported;
only Unicode-version differences affecting its contextual lower rule are rejected
when Sigma occurs. Exhaustive contextual vectors bind this supported domain. These explicit unsupported inputs may block derived indexing but cannot
modify or invalidate original evidence. A future expanded Unicode contract must
advance the budget identity and conformance evidence.

## Validation and limits

Synthetic tests cover complete multi-window source coverage, normalized full
input limits, varied HMAC titles, multilingual and Unicode input, sync/async
identity, stale receipts, policy limits, and zero ingestion calls on overflow.
No private corpus or provider call is required.

Focused query limits still bound bytes rather than exact tokens. Oversized
Russian/mixed query failures remain measured failures; this decision does not
authorize silent query truncation or change query semantics.
