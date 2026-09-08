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

---

## VERIFY #4 — Claude vision geometry (raised 2026-09-07, closed 2026-09-07)

`docs/external-brief-review.md` §5 recorded a conflict between two readings of how Anthropic
bills images, and said plainly that it needed a vendor page rather than an adjudication:

| Source | Claimed geometry |
|---|---|
| The external Gemini brief | scale long edge ≤ 1568 px, then `⌈(w × h) / 750⌉` |
| `prototype/src/lib/images.js:36` | 28 px patch grid, `⌈w/28⌉ × ⌈h/28⌉`, binary-searched to a 1568-**token** cap |

**The patch-grid reading is correct.** From Anthropic's own documentation:

> Claude views images in patches, where each patch is a 28×28-pixel block. […]
> `⌈width / 28⌉ × ⌈height / 28⌉`

The brief was wrong twice over. `28² = 784`, not 750 — the divisor is the patch **area**, and
750 corresponds to no documented quantity. And **1568 is two different limits in two different
units**, which the brief collapsed into one:

| Tier | Max long edge | Max visual tokens |
|---|---|---|
| Standard | 1568 px | 1568 |
| High-resolution | 2576 px | 4784 |

Maximum accepted dimensions are 8000×8000 px. High-resolution is automatic on Claude 4.7 and
later. Images over either limit are downscaled to "the largest aspect-preserving size" that
satisfies **both**, found by binary search along the long edge — and the docs note that "the
token limit, not the edge limit, determines final size for most photos and screenshots."

**Only downscaling occurs.** There is no upscaling for small images; images already within the
limits are returned unchanged. That closes, *for Anthropic specifically*, one of the two gaps
recorded in the README: `VisionConstraints.shortest_edge_target_px` has no direction flag, and
§A5.2.1's warning that some providers upscale below a target still stands unverified for
everyone else.

After resizing, Claude pads to the next multiple of 28 on the bottom and right edges only. The
padding does not add tokens — `⌈w/28⌉` already accounts for the partial patch — but it matters
for coordinate mapping, and the docs are explicit that coordinates normalize by the **resized**
dimensions, not the padded ones.

### It found a defect

The published worked examples were run against `countVisionTokens` as a conformance check:

| Example | Documented | Ours, before |
|---|---|---|
| 1000×1000 | 36 × 36 = 1296 tokens, unresized | ✅ 1296 |
| 1075×1520 (A4 at 130 DPI), standard tier | resizes to **924×1307** | ❌ 924×**1306** |

The binary search compared patch rows against an *unrounded* short edge. Images have integer
dimensions, so the short edge must be rounded to a whole pixel before the grid is taken —
`⌈924.36/28⌉ = 34` but `⌈924/28⌉ = 33`, and that one row was enough to reject a size the
provider accepts. Same token count on this example, but the resized dimensions are what
coordinates normalize by, and on other aspect ratios the count itself moves. Fixed, with the
vendor's own examples now pinned in `packages/estimator/src/vision.conformance.test.ts`.

Worth noting what caught it: not a test we invented, but a number the vendor published. A
worked example is the vendor stating, for specific pixels, exactly what they bill — which is
why §A4.6.1 treats them as the only trustworthy points on a geometry.

### Still not established

- Whether the same 28 px patch grid applies to Qwen-VL and GLM-4.1V. A15 §3 records all three
  as 28 px, but with *different bound types* — this verification covers Anthropic only.
- The exact tie-break when two aspect-preserving sizes fit equally.
- Nothing here is a registry seed. These figures enter the registry through ingestion, recorded
  with `source_url` and `verified_at`, or not at all (rule 1).

Sources, both retrieved 2026-09-07; **neither page displays a publication or last-updated date**:
<https://platform.claude.com/docs/en/build-with-claude/vision>,
<https://platform.claude.com/docs/en/build-with-claude/vision-coordinates>
(reached via a 302 from `docs.claude.com/en/docs/build-with-claude/vision`).

---

## VERIFY #5 — does the 1.1× US-only inference multiplier apply to Claude Opus 5? (raised 2026-09-08, OPEN)

Building the first real registry row surfaced a question the documentation does not answer.

Anthropic's pricing page publishes the multiplier plainly:

> For Claude 4.6 and later models, specifying US-only inference through the
> `inference_geo` parameter incurs a 1.1x multiplier on all token pricing categories,
> including input tokens, output tokens, cache writes, and cache reads.

Source: <https://platform.claude.com/docs/en/about-claude/pricing> (retrieved 2026-09-08; the
page displays no publication date)

**The gap is the model set, not the figure.** "Claude 4.6 and later models" is not enumerated
anywhere reachable. The models overview lists Claude Fable 5.1, Claude Opus 5, Claude Sonnet 5 and
Claude Haiku 4.5 with no version-ordering statement, no release dates and no generational
classification — asked directly, the page states none. Whether "Opus 5" is "4.6 and later" is
therefore an inference about a naming scheme, not a fact on a page.

**What was recorded.** `compliance.residency_uplift_pct` on `claude-opus-5` is `UNAVAILABLE`, with
the reason in its provenance. The consequence is deliberate and tested: `residencyUplift()` refuses
the moment a region is requested, so the US-only route is quoted at neither the default price nor a
guessed one. Recording `1.1` would have been the version-ordering inference; recording `0` would
have priced compliance as free, which §A5.10 names as the specific way a residency-aware router
misleads.

**Two neighbouring statements carry the same scope and were handled differently**, because the
evidence differs:

| Statement | Scope | What was recorded | Why |
|---|---|---|---|
| 1.1× `inference_geo` multiplier | "Claude 4.6 and later models" | UNAVAILABLE | Both alternatives are claims; neither is supported. |
| Full 1M context at standard pricing | "Claude 4.6 and later models" | `context_tiers: null` | Null is *also* the correct value for "no tier is published anywhere", which is unambiguously true — no threshold and no second rate appear on any page. The membership question does not change the answer. |

**To close it:** one page that either enumerates the models in the "4.6 and later" set, or states
the `inference_geo` multiplier against a named model. Until then the compliant Gulf/US-residency
route cannot be priced for this row, which is the honest state rather than a defect.

### It also found a contract defect

`TextRateProfile.input_rate_by_modality` is a `z.record` over an enum key, which in Zod 4 is
**exhaustive**: a text-and-image model must write `audio: null, video: null` rather than omit them.
The first real row failed to parse against it.

The behaviour is right — an omitted key is indistinguishable from a modality nobody considered, and
a missing audio rate must not read as "no audio charge" — but it was undocumented, and nothing in
the repo had ever parsed a real row to discover it. Documented in `pricing.ts` rather than relaxed.

---

## VERIFY #6 — is Gemini's per-image token count `tiles × 258`, or `258 + tiles × 258`? (raised 2026-09-08, OPEN)

Building the second registry row hit the same class of question VERIFY #4 answered for Anthropic,
and this time the vendor does not publish what settles it.

Google states the geometry plainly:

> "Images ≤384 pixels in both dimensions count as 258 tokens."
> "Larger images are tiled into 768x768 pixel tiles, each counting as 258 tokens."

Source: <https://ai.google.dev/gemini-api/docs/tokens> (retrieved 2026-09-08; the page displays no
publication date)

**What is missing is the per-image base.** Anthropic's tile-grid analogue in this repo's tests
carries `base_tokens: 85` — a fixed cost added to the tiles. Google's page states only the per-tile
figure and says nothing either way about a base, and asked directly for worked examples it has
none.

So a 1000×1000 image is either:

| Reading | Tokens | At Gemini 2.5 Pro's $1.25/1M |
|---|---|---|
| `tiles × 258` (4 tiles) | 1032 | $1.29 per thousand images |
| `258 + tiles × 258` | 1290 | $1.61 per thousand images |

**A 25% difference on every image**, in one direction, invisible in the output. The 258-token flat
rate below 384px is consistent with a zero base — one tile's worth either way — but "consistent
with" is not "stated", and this is exactly the reasoning that produced the 750-vs-784 error the
external brief made about Anthropic.

**What was recorded.** `gemini-2.5-pro`'s vision geometry is `UNAVAILABLE` with this reason, and
`probe_candidate: true`. The row still declares `supports_vision: true` and `image` in
`modalities_in`, because the model **does** accept images — recording `supports_vision: false`
would have been a false statement about capability, where `UNAVAILABLE` geometry is the true one:
we know it does vision, we cannot count it. `rankingEligibility` consequently returns
`VISION_GEOMETRY_UNAVAILABLE`, which is the first time that reason has fired on real data.

**To close it:** a worked example from Google giving specific pixel dimensions and a resulting token
count — one line would do it — or a §A4.6.1 probe against the live `countTokens` endpoint, which is
free to call. The probe is the better answer: it is a measurement rather than a reading, and
`probe_candidate` is set for that reason.

**Carried forward:** vendor worked examples are the only trustworthy points on a geometry (§A4.6.1),
and their absence is itself a finding. Anthropic publishes them, which is why its geometry is HIGH
and why running them caught our off-by-one. Google does not, which is why its geometry blocks. The
difference between the two rows in this registry is not that one vendor is better documented in
general — it is that one publishes the specific artefact that makes a geometry checkable.
