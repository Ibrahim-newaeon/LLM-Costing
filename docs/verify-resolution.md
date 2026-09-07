# VERIFY #1–#3 — resolution

Researched 2026-09-07. Primary sources only; URLs and retrieval date on every claim.
Paste-ready replacements for the three `⚠️ VERIFY` blocks in §A4.1.

---

## VERIFY #1 — Anthropic — **RESOLVED, your read was right**

Claude ships no public local tokenizer. Counting is `POST /v1/messages/count_tokens`.

Two details your note does not carry, and both change the design:

- **Counting is free.** It is not billed as inference.
- **It is rate-limited separately from inference** — 5,000 / 10,000 / 20,000 requests per
  minute at the Start / Build / Scale tiers, and using one does not consume the other's limit.

So the binding constraint on the Anthropic adapter is **request rate, not dollars**. That
inverts the usual caching goal: you are not caching to avoid spend, you are caching to stay
under an RPM ceiling. Dedupe and batch within a single estimate run — an agent-loop scenario
that counts the same system prompt once per round will burn the ceiling on identical content.
Content-hash caching as you specified is right; add per-run dedupe in front of it.

Source: <https://platform.claude.com/docs/en/build-with-claude/token-counting> (retrieved 2026-09-07)

**Method tagging:** `PROVIDER_COUNT_API` when online; `CALIBRATED_HEURISTIC` / `MEDIUM` offline,
exactly as drafted.

---

## VERIFY #2 — Google Gemini — **RESOLVED, and narrower than hoped**

A local tokenizer does exist: `LocalTokenizer` in `google.genai.local_tokenizer`, offered
because "counting tokens using the Count Tokens API may be fairly memory-intensive" for large
prompts.

**It is text-only.** The documentation is explicit: "The prompt must contain only text.
Multimodal prompts are not supported." The remote CountTokens API does handle multimodal.

**And it is not available in your language.** The local path is documented for Python; a Go
package (`cloud.google.com/go/vertexai/genai/tokenizer`) also exists. No JavaScript or
TypeScript local tokenizer is evidenced. For a TS codebase, a local Gemini path therefore
costs you either a Python/Go sidecar process or a JS reimplementation over the SentencePiece
model — neither of which is free, and both of which need their own drift story when Google
updates the vocab.

Source: <https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/list-token> (retrieved 2026-09-07)

**Method tagging:**

| Input | Path | Method |
|---|---|---|
| Text, sidecar present | local | `EXACT_TOKENIZER` |
| Text, no sidecar | remote | `PROVIDER_COUNT_API` |
| Any multimodal | remote, always | `PROVIDER_COUNT_API` |

Your instinct — "treat local-Gemini as an optimization, not the default" — holds, and is
stronger than you wrote it: for TS it is an optimization that requires a second runtime.

---

## VERIFY #3 — ERNIE / Hunyuan — **PARTIALLY resolved; PROXY stands, but nameable**

Both vendors publish open-weight repositories carrying tokenizer artifacts:

- Baidu: `baidu/ERNIE-4.5-21B-A3B-Thinking` ships a `tokenizer.model`; further ERNIE-4.5
  variants (0.3B, 21B-A3B-PT, VL-28B-A3B-Thinking) are published under the `baidu` org.
- Tencent: `tencent/Hunyuan-0.5B-Instruct`, `tencent/Hunyuan-1.8B-Instruct` and related repos
  are published under the `tencent` org.

**What this does not establish.** That a *hosted, closed-tier* ERNIE or Hunyuan endpoint uses
the same tokenizer as its open-weight sibling. Nothing found asserts that, and the assumption
is exactly the kind that produces a confident wrong number.

**So the treatment you drafted stands** — `tokenizer_availability: PROXY`, `confidence: LOW`
— with one upgrade: the proxy is now a *named artifact*, not a hand-wave. Record the exact
repository as the proxy's `source_url` on the row, so a reviewer can see which vocabulary
produced the count and re-check it when the vendor ships a new generation.

Sources: <https://huggingface.co/baidu/ERNIE-4.5-21B-A3B-Thinking/blob/main/tokenizer.model>,
<https://huggingface.co/tencent/Hunyuan-0.5B-Instruct> (both retrieved 2026-09-07)

---

## The structural consequence

Two of the three resolve to **remote-first**. Anthropic has no local path at all; Gemini's is
text-only and absent from the TS ecosystem. Only the open-weight families (Qwen, DeepSeek,
GLM, Kimi) and OpenAI's published BPE vocabularies give a genuine offline exact count.

Worth checking against §A4.5: if the tier ladder is ordered local-first with remote as
fallback, it is describing the minority case as the default. The honest ordering for the
providers that matter most is **remote-first with a local fast path where one exists** — which
also changes what "offline/preview mode" means in the UI. Offline is not a degraded version of
the same answer; for two major vendors it is a different method with a different confidence,
and the report already has the vocabulary to say so.

---

## Not verified here

- Whether the Go tokenizer package is genuinely local or a thin client.
- Whether hosted ERNIE / Hunyuan tiers match their open-weight tokenizers.
- Current Gemini local-tokenizer vocab coverage per model generation.
