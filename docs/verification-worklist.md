# Verification worklist — Chinese providers

Carried over 2026-09-07 from a Claude project note, reframed. The original recorded these as a
*seed*; under this repo's first rule — zero hardcoded rates, every row with `source_url` and
`verified_at` — none of it is seedable. It is a **list of models to verify**, and the figures
below are quarantined leads, not data.

## Do not seed from this file

Every number here is user-asserted with no source and no date. Two of the three column-shape
questions were never resolved, and the cache tiers are placeholders that were confirmed as
never researched. A figure enters the registry through `registry verify` — a fetch from the
provider's own domain, recorded with URL and retrieval date — or it does not enter.

## Scope: 21 model entries, 5 providers

| Provider | Models to verify | Tokenizer path | Notes |
|---|---|---|---|
| DeepSeek | V4-Flash, V4-Pro, R1 | HF local `tokenizer.json` | R1 drives reasoning overhead |
| Alibaba Cloud / DashScope | Qwen3.7-Max, Qwen3.7-Plus, qwen-max (legacy), Qwen-VL, Qwen-Max-Thinking | HF local `tokenizer.json` | Qwen-VL: patch-grid vision + video |
| Zhipu AI (Z.ai / BigModel) | GLM-5.2, GLM-5.1, GLM-4.5, GLM-V | local SentencePiece `.model` | GLM-V image rules; GLM-5.2 quoted in CNY |
| Moonshot AI | K3, K2.6, K2.7 Code, K2, Kimi Vision | local SentencePiece `.model` | |
| MiniMax | M1, M2.5, M2.7, M3 | — | video/audio token math |

**Verify the identifiers first.** Whether each name exists in the form written here is itself
unconfirmed. A name absent from the provider's own site is recorded as a finding, not left blank.

## Quarantined figures — leads only

Given as four positional numbers per row, `a/a/a/b`, with the column order never established.
Slot 4 reads as output on the ratio evidence. Slots 1–3 are identical in every row, which the
author confirmed are placeholders rather than a researched zero cache discount.

| Model | As given (per 1M) | Currency |
|---|---|---|
| DeepSeek V4-Flash | `0.14 / 0.14 / 0.14 / 0.28` | USD |
| DeepSeek V4-Pro | `0.435 / 0.435 / 0.435 / 0.87` | USD |
| Qwen3.7-Max | `2.50 / 2.50 / 2.50 / 7.50` | USD |
| Kimi K3 | `3.00 / 3.00 / 3.00 / 15.00` | USD |
| Kimi K2.6 | `0.95 / 0.95 / 0.95 / 4.00` | USD |
| MiniMax M3 | `0.30 / 0.30 / 0.30 / 1.20` | USD |
| GLM-5.2 | `¥8 / ¥28` — two values, different shape | CNY |

Implied output-to-input multiple, if slot 4 is output: 2.0× (DeepSeek), 3.0× (Qwen), 4.0×
(MiniMax M3), 4.21× (Kimi K2.6), 5.0× (Kimi K3). A 2×–5× spread is plausible, so this is a
weak sanity signal on the *shape* — it validates no individual figure.

14 of the 21 entries carry no figure at all.

## Per-provider checklist

For each provider, one pass over its own pricing and model documentation:

- [ ] DeepSeek
- [ ] Alibaba Cloud / DashScope
- [ ] Zhipu AI
- [ ] Moonshot AI
- [ ] MiniMax

Capture per model: the canonical id exactly as the provider writes it, context window, input /
output / cache rates with unit and currency, the page URL, the retrieval date. Anything not on
the page stays null. A name not found is recorded as such, with the URL checked and the date.

**GLM needs an FX decision.** It is quoted in CNY while everything else is USD. Store native,
convert at render with a dated rate, and show the rate and its date beside the converted
figure — a stale FX rate is otherwise invisible in a way a stale price is not.

**Hosted tiers may not match open weights.** Per `docs/verify-resolution.md` VERIFY #3, ERNIE
and Hunyuan publish open-weight tokenizers, but nothing establishes that their hosted closed
tiers use them. The same caution applies to any Chinese vendor here whose API tier differs from
its published weights: `tokenizer_availability: PROXY`, confidence `LOW`, with the exact
repository recorded as the proxy's source.
