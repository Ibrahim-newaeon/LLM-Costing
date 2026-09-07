# Prototype salvage — `llm-token-calculator`

Recovered 2026-09-07 from `~/llm-token-calculator`, which was not under version control and was
about to be deleted. Vite + React, ~3,200 lines of source. It is now `prototype/` in this repo.

**It is reference, not the build target.** `packages/contracts` plus `SPEC.md` remain canonical.
The prototype has no provenance layer at all — no `method`, no `confidence`, no `source_url` —
so nothing in it can be lifted without being wrapped in the contracts first.

But it is a working implementation of several things the spec only describes, and two of its
ideas are better than what the spec currently has.

## Worth keeping

### `prototype/scripts/refresh-rates.mjs` — the rate pipeline, already built

Curated manifest (`scripts/rates/rates.json`) → best-effort verification → generated overlay
(`src/data/rates.generated.js`), with:

- an `asOf` stamp on every snapshot
- a **price diff against the previous snapshot**, printed on each run
- `--offline` mode
- an explicit "manual overrides belong in the manifest; the generated file is derived output"
  rule, enforced by a do-not-edit banner

That is §A4.2's two-tier ingestion, working. The diff in particular is something the spec asks
for and no other code here provides.

### `prototype/src/lib/images.js` — three vision geometries, implemented

- `openAIVisionTokens` — tile grid with max-edge scaling, short-side target and a token cap
- `gpt5VisionTokens` — area ÷ 1024 under a budget ceiling
- `claudeVisionTokens` — 28px patch grid with a **binary search** for the largest long edge that
  fits under `maxVisualTokens`, returning `{ tokens, width, height, scaled }`

The Claude implementation is the `TOKEN_CAP` bound from `MIGRATION.md` written out, and the
`scaled` flag is exactly the signal §A5.2.1's disposition ladder needs. Port it behind the
contracts' geometry union rather than rewriting it.

### `prototype/src/lib/text.js` — tokenizer dispatch across four vocabularies

claude / llama / cl100k / o200k, lazily imported, with tiktoken-lite WASM init in the browser.
The lazy-import shape is worth copying.

## Must change before any of it is trusted

### 1. The Claude tokenizer path is a legacy proxy presented as exact

`text.js` counts Claude tokens from `@anthropic-ai/tokenizer`'s `claude.json` BPE. Per
`docs/verify-resolution.md` VERIFY #1, **Anthropic publishes no local tokenizer for current
models** — that JSON is the pre-Claude-3 vocabulary. A count from it is `EXACT_PROXY` at best
and `TOKENIZER_SCALED` in practice. It is never `EXACT_TOKENIZER`.

The prototype has no tagging, so a legacy-proxy Claude count is indistinguishable from a real
tiktoken count. That is the single most important thing to fix on port, and it is the exact
failure `Method` exists to prevent.

### 2. "Verified" in the refresh script means a string appeared on a page

`verifySource()` fetches the provider page and checks that literal markers — `"$10.00"`,
`"$0.40"` — appear somewhere in the body. All markers matching sets `verified: true`.

That proves the page contains those strings. It does not prove that *a given model* has *that
price*. The script's own comment is honest — "auditor, not oracle" — but the flag it writes is
stronger than its evidence, and a downstream reader will take it at face value.

Under this repo's vocabulary that is not `verified`. It is a **freshness check**: evidence that
the page still contains the figures the manifest was built from, which is genuinely useful as a
change detector and worth keeping under an honest name. Real verification still requires reading
the page and recording model → rate → URL → date.

### 3. The manifest contains hardcoded rates and unverified model ids

`rates.json` carries prices inline for ids including `gpt-6-astra`, `gpt-5.6-sol`,
`claude-fable-5`, `claude-mythos-5`, `claude-opus-4.8`. None has been checked against a provider
page in this repo, and rule 1 is *zero hardcoded rates — all rows with `source_url` and
`verified_at`*.

The manifest *design* is right: a curated file, a generated overlay, a diff. The manifest
*contents* are not seedable. Treat them the way `docs/verification-worklist.md` treats the
Chinese providers — a list of models to verify, not data.

### 4. No ranges

Everything is a point estimate. Rule 3 requires P50 and P90 for anything non-deterministic.

## Suggested use

1. Port `images.js` into `packages/estimator` behind the contracts' geometry union, keeping the
   binary-search fit and the `scaled` flag.
2. Port `refresh-rates.mjs` into the ingestion path, renaming its `verified` flag to what it
   actually measures and keeping the diff.
3. Rebuild `text.js`'s dispatch with `Method` tagging per adapter — and tag the Claude path
   honestly.
4. Read `App.jsx` for UI decisions already made, then leave it; the UI is last in the build order.
