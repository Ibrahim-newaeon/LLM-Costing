# TOKENOMICS ENGINE — MASTER BUILD PROMPT v1.0

> **What this file is.** Two prompts in one.
> **PART A** = the *build prompt* you paste into Claude Code / Cursor to scaffold the app.
> **PART B** = the *runtime system prompt* that lives inside the app and does the per-request analysis.
> PART A instructs the agent to ship PART B as `/prompts/analyzer.system.md`.
>
> **Three corrections to the source brief are flagged inline as `⚠️ VERIFY`.** Do not skip them — two of them change the architecture.

---

## PART A — BUILD PROMPT

### A0. OBJECTIVE

Build **Tokenomics Engine**: a multi-provider, multi-modal LLM/LMM cost estimation and routing platform that ingests a described workflow, deconstructs it into typed sub-requests, estimates token/compute consumption with explicit uncertainty bands, and returns a ranked model recommendation with a transparent **API-managed vs. self-hosted** cost comparison.

**The product's core promise is "approximately, with stated error bars" — not "exactly."** Every number the UI renders must carry a `confidence` and a `method` tag. A number with no traceable method is a bug, not a feature.

---

### A1. SKILLS APPLIED (enforce all — do not ask which)

✅ ZOD — every form, API route, env var, and ingested JSON validated at the boundary
✅ SEC — Helmet.js headers, JWT + refresh tokens, rate limiting (`express-rate-limit` / Next middleware) on **every** endpoint
✅ SQL — parameterized queries only, via Prisma; zero string concatenation
✅ TS-STRICT — `strict: true`, `noUncheckedIndexedAccess: true`, no `any`
✅ RSC — React Server Components by default, `'use client'` only for interactive islands
✅ A11Y — ARIA labels, keyboard nav, visible focus rings, 56px minimum touch targets
✅ TEST — Playwright Page Object Model, positive **and** negative cases, `data-testid` on every interactive element
✅ LOAD — k6 scripts for the `/api/estimate` hot path
✅ DOCKER — multi-stage build, `/healthz` endpoint, non-root user
✅ OBS — structured logs, every estimate persisted with its full evidence chain

---

### A2. STACK (locked)

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router) | RSC default |
| Language | TypeScript, strict | |
| Validation | Zod | shared schemas in `/packages/contracts` |
| DB | PostgreSQL + Prisma | temporal tables for pricing |
| Cache | Redis | tokenizer results, pricing snapshots |
| Tokenizers | `js-tiktoken` + `@huggingface/transformers` (or a sidecar) | see §A5 |
| Jobs | node-cron or Vercel Cron | daily pricing pull |
| Charts | Recharts | |
| Tests | Playwright (POM) + Vitest + k6 | |

**Monorepo layout:**

```
/apps/web                 → Next.js app
/packages/contracts       → Zod schemas + generated types (single source of truth)
/packages/tokenizers      → tokenizer adapters, one per family
/packages/pricing         → ingestion adapters + resolver
/packages/estimator       → pure cost math, zero I/O, 100% unit-tested
/packages/router          → recommendation engine
/prompts/analyzer.system.md → PART B of this document, verbatim
/schemas/*.json           → JSON Schema mirrors of the Zod contracts
```

**Hard rule:** `/packages/estimator` is pure functions only. No DB, no fetch, no `Date.now()`. Everything it needs arrives as arguments. This is what makes the math testable and auditable.

**Contract direction — one source of truth, enforced by CI.** Zod in `/packages/contracts` is canonical. `/schemas/*.json` are **generated** from it (`zod-to-json-schema`) by a build step, and CI fails if the committed JSON differs from the regenerated output. Do not hand-edit the JSON Schema files, and do not write a second set of types from them. "Keep them in sync" as an instruction is how they drift; a failing build is how they don't.

**The estimator's signature is wider than `WorkflowInput`.** Because it is pure, everything it reads is an argument:

```ts
// /packages/estimator/index.ts
estimate(
  workflow: WorkflowInput,        // from the analyzer (§A4.4)
  rates: ResolvedPricing[],       // already resolved + staleness-checked (§A4.2)
  profiles: ModelProfile[],       // vision_profile, context tiers, architecture (§A6)
  calibration: CalibrationTable,  // ratios, framing overhead, priors (§A4.1)
  assumptions: AssumptionSet,     // user-edited values (§A3 rule 4)
): EstimateOutput
```

Anyone who writes `estimate(workflowInput)` alone will reach for the DB inside the estimator within a day, and the purity rule is gone.

---

### A3. NON-NEGOTIABLE DATA INTEGRITY RULES

These are the product. Violating them is a P0.

1. **Zero hardcoded rates.** No price, no tile constant, no tokens-per-second figure appears in source code. All of it lives in the DB, sourced per §A4, each row carrying `source_url`, `verified_at`, `effective_from`, `effective_to`.
2. **Refuse, don't guess.** If a required rate is missing, expired, or stale beyond `MAX_RATE_AGE_DAYS`, the estimator returns `needs_human_review: true` and lists the gap in `missing_data[]`. It does **not** substitute a similar model's price.
3. **Every number is traceable.** Each `EstimateLine` carries `method` ∈ `EXACT_TOKENIZER | PROVIDER_COUNT_API | CALIBRATED_HEURISTIC | USER_SUPPLIED | UNAVAILABLE` and a `confidence` ∈ `HIGH | MEDIUM | LOW`.
4. **Assumptions are labeled, never silent.** Reasoning-token overhead, cache-hit ratio, output length, GPU utilization — all are assumptions. They render in a dedicated "Assumptions" panel the user can edit, and every edit re-runs the estimate.
5. **Conflicts are reported, not merged.** If LiteLLM and OpenRouter disagree on a rate beyond `PRICE_CONFLICT_TOLERANCE_PCT`, surface both, mark `needs_human_review`, and do not average them.
6. **Ranges, not points.** Any estimate touching a non-deterministic quantity (output length, reasoning tokens, cache hits) returns P50 and P90, not a single figure.
7. **Confidence propagates by minimum, never by assertion.**
   ```
   line_confidence = min(quantity_confidence, rate_confidence)
   task_confidence = min over lines
   estimate_confidence = min over tasks
   ```
   A `HIGH` token count multiplied by an `UNAVAILABLE` rate is not a HIGH estimate — it is not an estimate at all. It is `needs_human_review: true` with the gap named in `missing_data[]`. Confidence is computed, never typed in.
8. **Source class caps confidence, structurally.** Every rate carries `source_class ∈ VENDOR_PAGE | VENDOR_DOCS | AGGREGATOR | USER_ENTERED`, and **an `AGGREGATOR`-sourced rate may never be `HIGH`**. Enforce it as a schema refinement, not a code convention, so the rule is unrepresentable to violate rather than merely documented.
   This is empirical, not cautious: on one verification pass across a set of aggregator-sourced rates checked against vendor pages, roughly **one in three was wrong** — several stale by a price change, and one off by 5×. Aggregators are for discovery and diffing; a vendor page is what earns HIGH.

---

### A4. PRICING & TOKENIZER SOURCING (hybrid pipeline)

#### A4.1 Tokenizer logic — LOCAL, deterministic, zero network

Run tokenizers **in-process on the server**. Never count words or characters as a primary method.

| Family | Source | Loader |
|---|---|---|
| OpenAI | `cl100k_base` (GPT-4 era), `o200k_base` (GPT-4o era) | `tiktoken` / `js-tiktoken` |
| DeepSeek (V3 / R1) | official HF repo tokenizer files | HF `tokenizers` / `transformers` |
| Qwen (Alibaba) | Hugging Face **or ModelScope** | HF `tokenizers` |
| GLM (Zhipu) | Hugging Face | HF `tokenizers` |
| ERNIE / Wenxin (Baidu) | HF or vendor repo — **availability varies by model tier** | HF `tokenizers`, else fall back |
| Hunyuan (Tencent) | HF or vendor repo — same caveat | HF `tokenizers`, else fall back |
| Llama / Mistral / open-weight | HF | HF `tokenizers` |

> **⚠️ VERIFY #1 — Anthropic.** Claude does **not** ship a public local tokenizer. Token counting is a **network API call** to `POST /v1/messages/count_tokens`. Architect it as a *remote, rate-limited, cached* adapter — not a local library — or the "zero network latency" assumption breaks for every Claude estimate. Cache aggressively by content hash. Provide a `CALIBRATED_HEURISTIC` fallback for offline/preview mode, clearly tagged `MEDIUM` confidence.
> Evidence: Anthropic's token-counting docs describe an API endpoint; third-party write-ups exist specifically on approximating Claude tokens *without* a tokenizer.
>
> **⚠️ VERIFY #2 — Google Gemini.** `countTokens` in the Generative AI SDK is primarily a **remote API call**. A *local* text-token count path exists via the Vertex AI SDK, but confirm current coverage — in particular whether it covers multimodal inputs or text only — before you rely on it. Treat local-Gemini as an optimization, not the default.
>
> **⚠️ VERIFY #3 — Chinese closed-tier models.** Open-weight Qwen/GLM/DeepSeek tokenizers are downloadable. Baidu ERNIE and Tencent Hunyuan **hosted/closed tiers** may not publish matching tokenizer files. Where they don't, mark the model `tokenizer_availability: PROXY` and use a nearest-architecture tokenizer *explicitly labeled as a proxy*, with `confidence: LOW`.

These are the Tier 2 sources. How they combine with the remote count APIs, the cache, and the heuristic fallback is **§A4.5 — the tiered estimation engine**; read that before writing `/packages/tokenizers`.

**Vendoring rule:** pin tokenizer artifacts by revision hash into the image at build time. Do not download at runtime. A silently updated `tokenizer.json` = silently wrong invoices.

**Calibration harness (required).** For every model where the method is not `EXACT_TOKENIZER`, maintain a golden corpus and back-fit the heuristic:

```
/packages/tokenizers/calibration/
  corpus/            → en, ar_msa, ar_dialect, ar_vocalized, zh_hans, zh_hant,
                       code, json, mixed          (min 200 samples each — see §A4.4.5
                       for why Arabic needs three buckets and Chinese two)
  observed/          → real usage.* payloads captured from live API responses
  ratios.generated.json → char→token ratio + stddev per (model, script, content_type)
```

The ratio table is **generated from observations**, never authored by hand. Each row stores `n_samples`, `mean`, `p90`, `stddev`, `calibrated_at`. Confidence downgrades automatically when `n_samples` is below threshold or `calibrated_at` is stale.

Arabic matters here: it is a non-Latin script with heavy diacritic/affix behaviour and its inflation ratio differs sharply from both English and Chinese. Include `ar` as a first-class calibration bucket, not an afterthought.

#### A4.2 Financial rates — TWO-TIER INGESTION

**Tier A — automated aggregators (primary, daily cron):**

- **LiteLLM** `model_prices_and_context_window.json` (GitHub) — daily pull. Broad coverage: input/output cost, context window, cache pricing fields.
- **OpenRouter** pricing endpoint — daily pull. Wide model library including Chinese models routed through it.

Each pull writes a new immutable `PricingSnapshot` row. Never `UPDATE` a rate — insert a new version and close the old one's `effective_to`. Diff each pull against the prior snapshot and emit a `PriceChangeEvent` when a rate moves; the UI shows a "prices changed since your last estimate" banner.

**Tier B — manual vendor override table (enterprise + Chinese clouds):**

Baidu AI Cloud (Qianfan), Tencent Cloud (Hunyuan), Alibaba Cloud (Model Studio / Bailian), and enterprise/dedicated-capacity tiers frequently publish no machine-readable pricing endpoint. Build an **admin-only override UI** writing to `pricing_manual_override`, with mandatory fields: `source_url`, `screenshot_ref` (optional), `verified_by`, `verified_at`, `currency`, `region`. Manual rows **outrank** aggregator rows for the same `(model, region, tier)`.

Add a `staleness_days` badge to every manual row in the admin UI and a monthly review reminder.

**Currency + region:** store the vendor's native currency (CNY for Chinese clouds is common) and convert at display time via a dated FX rate that is itself a sourced record. Never store a converted price as the primary value.

**Tier C — self-hosted hardware rates:** cloud GPU price sheets (AWS, GCP, Azure, RunPod, Lambda, and regional Gulf providers where relevant). Quarterly refresh. Store `on_demand` and `spot` separately — never blend them. Regional tax/VAT is a separate multiplier field, not baked into the hourly rate.

#### A4.3 Sourcing matrix (implement exactly this)

| Data type | Method | Frequency | Risk | Guardrail |
|---|---|---|---|---|
| Global tokenizers | Local libs (tiktoken) | On new model family | Low | Pin by revision hash |
| Chinese tokenizers | HF / ModelScope configs | On new architecture | Medium | Golden-string regression tests |
| Claude / Gemini counts | Remote count API + cache | Per request (cached) | Medium | Rate limit + heuristic fallback |
| Managed API costs | LiteLLM + OpenRouter JSON | Daily cron | **High** | Two-source diff; conflict → review |
| Enterprise / CN cloud costs | Manual admin entry | Monthly review | High | Staleness badge, blocks estimate when expired |
| Self-hosted instance costs | Cloud price sheets | Quarterly | Medium | Split spot vs on-demand; regional tax field |
| FX rates | Dated rate record | Daily | Medium | Store native currency as source of truth |

---

### A4.4 LAYER 0 — INTENT PARSER & THE DEFAULTS ENGINE

Everything in §A5 assumes a structured task graph already exists. This section builds the thing that produces it, from a sentence a human typed in **English, Arabic, or Chinese** — and it is where most naive implementations go wrong.

#### A4.4.1 Two layers, deterministic first

```
[free text, any language]
        ↓
[L1: Deterministic Router]  ← lexicon + normalizer + regex. Free, ~0ms, no tokens.
        ↓  confidence >= PARSE_CONFIDENCE_FLOOR ? emit : escalate
[L2: Structured LLM Parse]  ← PART B prompt, cheapest capable model, JSON mode
        ↓
[WorkflowInput]  (workflow-input.schema.json)
```

L1 handles the ~70% of inputs that are imperative and well-formed. L2 is the fallback, not the default.

**The recursion nobody accounts for: the parser costs money.** L2 is itself an LLM call with input, output, and (if you pick a reasoning model — don't) reasoning tokens. A cost calculator that doesn't meter its own parser is lying about total cost of ownership. Emit the parse as a `system_overhead` line, and expose the L1-hit-rate as an operating metric — it is the single lever on your own gross margin.

⚠️ **Two rules about where that line lives, both easy to get wrong:**

1. **It belongs at the estimate level, not inside each candidate's `lines[]`.** The parse happens **once per workflow**, before any model is chosen. Metering it per candidate multiplies it by the number of models you are comparing — ten candidates, ten copies of a cost you paid once — and silently corrupts every model-to-model comparison, because the constant is added to each side. Put it in a top-level `system_overhead` block, and exclude it from the per-candidate ranking maths.
2. **L1 parses cost nothing.** Emit the line only when `parse_meta.layer == "L2_LLM_PARSE"`; for `L1_DETERMINISTIC` the overhead is zero and the line is absent. This is exactly what makes the L1 hit-rate legible as a margin figure — if every parse shows overhead, you cannot see the lever.

The parser also runs on the cheapest capable model, which is frequently **not** one of the candidates being priced, so its rate lookup is independent of the comparison set.

#### A4.4.2 Normalize before you match (this is where Arabic and Chinese break)

A lexicon lookup against raw user text works for English and fails for the other two. Normalize first:

**Arabic** — Arabic is heavily inflected and orthographically variable. Before matching, apply in order:

1. Strip tashkeel/diacritics (`ً–ْ`, `ٰ`) — the same verb appears with and without them
2. Normalize alef forms: `أ إ آ ٱ → ا`
3. Normalize `ة → ه`, `ى → ي`, `ؤ ئ → و ي` per your matcher's tolerance
4. Strip conjunctive/definite prefixes `و ف ب ك ال ولل` and pronominal suffixes `ه ها هم ني نا ك`
5. Convert Arabic-Indic numerals `٠١٢٣٤٥٦٧٨٩` → Western before any quantity regex — **a quantity regex that only matches `[0-9]` silently drops every number in an Arabic prompt, and a dropped quantity becomes a default, which becomes a wrong estimate**
6. Match against a normalized-root lexicon, not surface forms

**Chinese** — no whitespace, so tokenizing the *instruction* is its own problem:

1. Normalize Traditional → Simplified (or match both forms) before lookup
2. Use longest-match segmentation against the verb lexicon rather than character-by-character
3. Convert Chinese numerals `一二三四五六七八九十百千万` and `两` to Western integers before quantity extraction — `五份合同` is five contracts, and a `[0-9]+` regex sees zero
4. Watch measure words: `份 篇 张 个 页 条` immediately follow a count and are your strongest quantity signal

**All scripts** — detect script by Unicode range **proportions**, not by a single label. Gulf documents are routinely mixed: an Arabic contract with English legal terms, Western numerals and a Chinese counterparty name. Emit `script_mix: { arabic: 0.71, latin: 0.24, han: 0.05 }`, because the tokenizer's behaviour follows the mix, not the majority.

#### A4.4.3 The action lexicon (seed — extend from real usage logs)

| Task | English | العربية | 中文 |
|---|---|---|---|
| **READ** | upload, read, analyze, scan, extract, parse, OCR, ingest, classify, compare, search | ارفع، حمّل، اقرأ، حلّل، افحص، استخرج، صنّف، قارن، ابحث | 上传、读取、阅读、分析、扫描、提取、解析、分类、对比 |
| **WRITE** | write, draft, generate, create, compose, brainstorm, outline, expand, reply | اكتب، صغ، أنشئ، ولّد، اقترح، خطّط، وسّع | 写、撰写、起草、生成、创建、头脑风暴、扩写 |
| **EDIT** | fix, rewrite, modify, update, change, refine, polish, inpaint, upscale, retouch | عدّل، أصلح، أعد صياغة، حدّث، غيّر، نقّح، حسّن | 修改、修复、改写、更新、润色、重绘、放大 |

⚠️ **Your draft matrix has two misclassifications, and both undercount cost:**

| Verb | Your matrix says | Actually | Cost consequence |
|---|---|---|---|
| **translate** / ترجم / 翻译 | READ only | **READ + WRITE** — ingests the entire source *and* emits a full-length target | Undercounts output by roughly one whole document. On a long contract this is the dominant term. |
| **summarize** / لخّص / 总结 | WRITE only | **READ + WRITE** — ingests the entire source, emits a short output | Undercounts *input* by the whole document. Your own worked example ("summarize it") hits this. |

So the lexicon does not map verb → task. It maps **verb → task sequence**:

```ts
// /packages/router/lexicon.ts
type Expansion = { type: 'READ'|'WRITE'|'EDIT'; sub_kind: string; ratio_hint?: string }[]

const COMPOUND = {
  translate: [
    { type:'READ',  sub_kind:'context_ingestion' },
    { type:'WRITE', sub_kind:'completion', ratio_hint:'OUTPUT_APPROX_EQUALS_INPUT' },
  ],
  summarize: [
    { type:'READ',  sub_kind:'context_ingestion' },
    { type:'WRITE', sub_kind:'completion', ratio_hint:'OUTPUT_MUCH_SMALLER_THAN_INPUT' },
  ],
  review:  [ /* READ + WRITE — findings are output */ ],
  audit:   [ /* READ + WRITE */ ],
  compare: [ /* READ × n sources + WRITE */ ],
}
```

Expanded tasks carry `expands_from: "<parent_task_id>"` so the UI can show one user intent as its two billable halves. That display — "you said *summarize*, here are the two things you are paying for" — is the product's best explanation of itself.

**Also handle:**
- **Negation and exclusion** — "don't summarize, just extract" / "لا تلخّص" / "不要总结". A bare keyword matcher scores a `summarize` hit inside a negation. Scan a negation window before accepting a match, and on ambiguity escalate to L2 rather than guessing.
- **Conditionals** — "summarize it *if* it's over 10 pages" is a probabilistic branch. Record `execution_probability` on the task and multiply the volume; do not treat it as certain.
- **Iteration language** — "for each", "لكل", "每个", "batch of", plus bare plurals, all set `volume`. Missing iteration language is the most common cause of a 100× underestimate.

#### A4.4.4 The defaults engine — and the line it must not cross

Your instinct is right: users don't supply pixel dimensions in casual prompts, and refusing to estimate anything without them makes the product useless. But this collides with §A3 rule 2. The resolution is one clean line:

> **Guess quantities. Never guess rates.**
> A missing *rate* (price, tile constant, throughput) **blocks** the estimate — there is no honest default for what a vendor charges.
> A missing *quantity* (document length, image size, turn count) gets a **labeled, editable default** that downgrades confidence.

Every default that fires must:
1. emit an `assumptions[]` entry with `basis: "DEFAULT_APPLIED"` and its impact rating,
2. render in the Assumptions panel as an editable field, pre-focused when it is the top sensitivity driver,
3. downgrade the task's confidence to at most `MEDIUM`, or `LOW` when two or more defaults stack on one task,
4. never fire when a real asset is attached — **a measured value always beats a default**. Defaults are for pre-upload and hypothetical estimation only.

**Seed baselines** — these are your figures, and they enter the DB tagged `provenance: SEED_UNCALIBRATED`, `confidence: LOW`, with a standing task to replace each one from observed runs. They are starting points, not facts:

| Asset class | Trigger phrases | Seed input | Seed output |
|---|---|---|---|
| Short form | tweet, email, post, caption, تغريدة، منشور، 推文、帖子 | 300 | 200 |
| Medium form | article, essay, report, مقال، تقرير، 文章、报告 | 2,000 | 800 |
| Long form | book, contract, multi-page PDF, عقد، كتاب، 合同、书 | 25,000 | 2,000 |
| Image (unspecified) | image, picture, صورة، 图片 | 1024 × 1024, detail=high | — |

Store them in `defaults_seed` with `source: "USER_SUPPLIED_BASELINE"` — not in code, and not presented anywhere in the UI as a measured figure.

#### A4.4.5 Language-inflation defaults — three corrections

Your rule was: *if Chinese, multiply character count by 1.5–2.5×*. Three problems:

1. **Multiplier relative to what?** `1.5–2.5×` has no stated baseline. Written properly the heuristic is `tokens ≈ chars × ratio[model, script]` — one measured ratio per (model, script), not a multiplier on an unnamed English assumption. Store the ratio; never store a multiplier-of-a-multiplier.
2. **A 1.5–2.5× band is a ±25% cost swing before anything else varies.** That is not a range you pick a number from — it is a distribution. Emit P50 and P90 and let the swing show, or the user will treat the low end as the price.
3. **You will almost never need it.** Qwen, GLM, DeepSeek and the OpenAI families all have local exact tokenizers. If the model is `LOCAL_EXACT`, tokenize — the ratio path is only for `PROXY` tokenizers, offline preview, and pre-upload estimates. Applying a ratio when an exact count is available is a self-inflicted error.

**And Arabic is missing from your spec entirely.** It needs its own measured ratio and three script-specific rules the Chinese path doesn't have:

- **Tashkeel is billable.** A fully vocalized Arabic text (Qur'anic, liturgical, pedagogical, legal formal) carries a diacritic on nearly every consonant, and most tokenizers treat those as separate tokens. The same sentence with and without tashkeel can differ dramatically in token count.
  **Vocalization is a spectrum, not a boolean.** Most real Arabic is *partially* vocalized — diacritics appear only on genuinely ambiguous words — and a `true/false` flag forces that continuous variable into one of two extremes, mispricing whichever end it snaps to. So store `diacritic_density` (diacritics per consonant, measured) as the underlying value and derive the bucket from thresholds. The boolean stays as a convenience for bucket selection; the density is what the calibration table is keyed on and what the UI shows.
- **Morphology, not spaces.** Arabic packs article, conjunction, preposition and pronoun into one orthographic word. Character-based ratios behave differently than they do for English; word-based ones behave much worse. Calibrate on characters, and only per model.
- **Dialect vs MSA.** Gulf and Levantine dialect content tokenizes worse than Modern Standard Arabic on models trained mostly on MSA. If your Jordan/KSA/Kuwait workloads include chat or social content, that is a separate calibration bucket, not the same one as contracts.

Add both to the corpus buckets already required in §A4.1 — `ar_msa`, `ar_dialect`, `ar_vocalized`, `zh_hans`, `zh_hant` — each with its own `n_samples`, mean, p90 and stddev.

#### A4.4.6 Three language fields, not one

Your worked example — *"I want to upload a Chinese contract PDF, summarize it, and generate a featured image"* — is written in **English** about a **Chinese** payload, and might come from an **Arabic** UI. Conflating those is a direct mispricing:

```jsonc
"languages": {
  "ui_language": "ar",              // interface locale — costs nothing, drives RTL
  "instruction_language": "en",     // language of the request — parser lexicon selection
  "payload_languages": [            // language of the BILLED CONTENT — drives tokenization
    { "code": "zh-Hans", "share": 0.95 },
    { "code": "en",      "share": 0.05 }
  ]
}
```

Only `payload_languages` enters the cost math. `instruction_language` selects the lexicon. `ui_language` affects layout and nothing else.

#### A4.4.7 One more thing that example hides: is the PDF scanned?

"Upload a Chinese contract PDF" is two completely different cost models and the sentence does not say which:

| | Text-layer PDF | Scanned PDF |
|---|---|---|
| Task type | READ · context ingestion | READ · vision OCR |
| Cost driver | text tokens | **image tiles per page** |
| Formula | §A5.1 | §A5.2, once per page |
| Magnitude | baseline | can be far higher, and scales with page count |

The parser must not choose silently. Detect it when the asset is present (text layer + character count), and when it is absent put it in `missing_data[]` as a blocking question — *"Is the PDF searchable text or a scan?"* — because no default is defensible across a gap this size. Same question for images inside DOCX and for photographed documents, which are near-universal in Gulf contract workflows.

**Full worked trace of your example**, once Layer 0 is correct:

```
"I want to upload a Chinese contract PDF, summarize it,
 and generate a featured image for the article"

→ languages: instruction=en, payload=[zh-Hans], ui=<session>
→ t1  READ  · context_ingestion | doc_class=long_form | zh-Hans
        ⚠ blocking: text-layer or scanned? (→ vision_ocr if scanned)
        ⚠ default: 25,000 input tokens  [SEED_UNCALIBRATED · editable]
→ t2  READ  · context_ingestion | expands_from=summarize   ← your matrix missed this
→ t3  WRITE · completion        | expands_from=summarize
        ratio_hint=OUTPUT_MUCH_SMALLER_THAN_INPUT
→ t4  EDIT  · image_generate    | per-image pricing, NOT tokens (§A7)
        ⚠ default: 1024×1024    [SEED_UNCALIBRATED · editable]
→ confidence: LOW  ·  needs_human_review: true
→ missing_data: [pdf_has_text_layer, image_dimensions, target_summary_length]
```

Note what an honest parse produces here: **four tasks from three verbs, two blocking questions, and LOW confidence** — from a sentence that looks completely unambiguous.

---

### A4.5 TIERED TOKEN ESTIMATION ENGINE (Tier 0 → Tier 3)

No single counting method is right for every request. Four tiers, each mapping to a declared `method` tag, a default confidence, and an explicit escalation trigger. `/packages/tokenizers` exposes one function — `estimateTokens(payload, model, mode)` — and the tier it used is part of the return value, never a hidden detail.

| Tier | Method | Latency | Confidence | Use when |
|---|---|---|---|---|
| **0** | *inherits cached tier* | ~0 | inherits | Cache hit on an identical payload |
| **1** | `PROVIDER_COUNT_API` | network | `HIGH` | Multimodal payloads, near a context or price-tier boundary, or committing a quote |
| **2** | `EXACT_TOKENIZER` (or `PROXY`) | sub-ms | `HIGH` / `LOW` if proxy | Text-only on a model with a local vocabulary |
| **3** | `CALIBRATED_HEURISTIC` | 0 | `MEDIUM` → `LOW` | Offline preview, live typing indicator, pre-upload sizing |

#### A4.5.1 Tier 0 — cache, and the key that makes it safe

Content-hash the payload, but **the hash alone is not the key**:

```ts
// /packages/tokenizers/cache-key.ts
cacheKey = sha256(canonicalizeMessages(messages))
         + ':' + model_id
         + ':' + tokenizer_revision      // the pinned artifact hash from §A4.1
         + ':' + chat_template_version    // framing overhead changes with it
         + ':' + tenant_id                // never share a cache across tenants
```

⚠️ **Omitting `model_id` or `tokenizer_revision` from the key is the single most likely bug in this design.** The same message array tokenizes to different counts on different models, and to a different count on the *same* model after a tokenizer artifact bump. A hash-only key silently serves one model's count for another, forever, with `HIGH` confidence attached. Bumping `tokenizer_revision` must invalidate by construction — never by a manual flush.

`canonicalizeMessages` must produce byte-stable output: stable key order, no incidental whitespace, tool schemas serialized deterministically. An unstable canonicalizer gives you a 0% hit rate that looks like a working cache.

Payload content is hashed, not stored. Where a tenant's policy forbids even hashed derivatives of regulated content leaving their boundary, the cache is per-tenant and co-located — that is why `tenant_id` is in the key rather than a namespace bolted on later.

**Bumping `tokenizer_revision` does not invalidate — it misses.** Old entries stay resident, and every revision bump leaves another dead generation behind, so the cache grows without bound. Ship an eviction policy with the cache, not after it: TTL on every entry, LRU on the memory ceiling, plus an explicit sweep of entries whose `tokenizer_revision` is no longer any active model's pinned revision. "Automatic invalidation" is the correctness property; eviction is the ops property, and you need both.

#### A4.5.2 Tier 1 — remote count API is ground truth

Use it for: any payload containing media, any estimate within `TIER_PROXIMITY_WARN_PCT` of a context-window or price-tier boundary, and any estimate the user is about to commit to as a quote.

**Gemini specifically:** multimodal token weight depends on resolution downscaling and temporal frame sampling, which the local path does not replicate. So the local path must **detect media and refuse**, not silently count the text portion — a local counter that quietly drops the image tokens produces a large, confident undercount. Local Gemini is a text-only optimization; media always escalates.

⚠️ **State that rule precisely, or it breaks the pre-flight screen.** "Any task with image or media metrics must bypass local tokenizers and a local tokenizer must throw on media" is *too broad*. Tier 1 needs a **real payload** to count; the pre-flight calculator (§A5.2) exists precisely to price an image **before it is uploaded**, from declared dimensions, when there is nothing to send anywhere. A blanket hard-throw deletes that feature.

The actual failure being prevented is **silent partial counting**, not local computation. So:

| Situation | Allowed | Method tag |
|---|---|---|
| Real payload contains media, quote being committed | **Tier 1 only** | `PROVIDER_COUNT_API` |
| Real payload contains media, local text tokenizer invoked | **Hard error.** Never return a text-only count for a payload you know has media. | — |
| No asset yet — declared or measured dimensions, pre-flight sizing | Local tile math is **required** | `CALIBRATED_HEURISTIC` or `DEFAULT_APPLIED` |
| Mixed text + media, text portion needed separately | Allowed, but the line is explicitly scoped `component: prompt_input` and the media components are separate lines | per component |

The invariant: a local path may **decline** to count media, and it may compute media from the published tile formula and say so — what it may never do is return a number that looks whole while quietly omitting a component. Tile math tagged `CALIBRATED_HEURISTIC` is honest; the same math tagged `EXACT_TOKENIZER` is not.

**Anthropic specifically:** rate-limit the adapter on its own bucket (§A10 already requires this), cache by the key above, and treat a 429 as a downgrade to Tier 3 with a visible badge — never as a silent zero.

**Every Tier 1 call is also a free calibration sample.** Whenever the remote count returns, compute what Tier 2 and Tier 3 *would have said* for the same payload and write the deltas to the calibration store. The heuristic improves on its own as a by-product of normal operation, and drift in a proxy tokenizer surfaces as a widening delta before it shows up as a wrong invoice. Wire this from day one — retrofitting it means throwing away every sample you already paid for.

#### A4.5.3 Tier 2 — local and proxy tokenizers

Exact local vocabularies (§A4.1) run here at `HIGH` confidence. Proxies do not.

**Proxy selection rule — match the script, not just the architecture.** "Map to a standard LLaMA/Qwen baseline" treats those two as interchangeable; for Chinese they are not. A Chinese-native vocabulary and an older Western-trained vocabulary fragment Hanzi very differently, so proxying a Chinese closed-tier model (ERNIE, Hunyuan) to a Western-trained tokenizer produces a systematically wrong count in a consistent direction — the worst kind of error, because it looks stable. Proxy a Chinese model to a Chinese-native open tokenizer; proxy a Western model to a Western one. Record the choice:

```jsonc
"tokenizer_proxy": {
  "target_model": "<closed-tier model>",
  "proxy_model":  "<script-matched open-weight model>",
  "basis": "SCRIPT_AND_ARCHITECTURE_MATCH",
  "measured_delta_pct": null   // populated by Tier 1 drift capture; null = unvalidated
}
```

Until `measured_delta_pct` has samples, every proxy count is `confidence: LOW` and raises `PROXY_TOKENIZER_IN_USE`. A proxy whose measured delta exceeds `PROXY_DRIFT_MAX_PCT` is disabled and the model falls back to Tier 1 only.

#### A4.5.4 Tier 3 — heuristics, and the constant you may not generalize

Bootstrap value, for cold start only: **≈3.5–4 characters per token, English prose, plus per-model fixed offsets for media blocks.** It enters `defaults_seed` tagged `provenance: SEED_UNCALIBRATED`, **`confidence: LOW`**, and is **replaced automatically** by the calibration table (§A4.1) as soon as `n_samples` crosses threshold. It is never written into source.

> **Uniform rule, no exceptions:** everything loaded from `defaults_seed` is `SEED_UNCALIBRATED` + `LOW`, and renders with a mandatory, editable UI indicator. It does not matter how widely corroborated a seed figure is elsewhere — nothing in `defaults_seed` has been validated against *this* system's own corpus and *this* model, which is the only validation that counts here. Confidence rises to `MEDIUM` or `HIGH` automatically when the calibration table replaces the seed, never by assertion.

⚠️ **That figure is English prose only. Do not generalize it.**

| Script / content | Heuristic path |
|---|---|
| English prose | Bootstrap ratio permitted, `MEDIUM` |
| Code, JSON, tabular | Own calibration bucket — tokenizes very differently from prose |
| Arabic (any register) | **No bootstrap value exists in this document.** Unavailable until calibrated. |
| Chinese (Hans / Hant) | **No bootstrap value exists in this document.** Unavailable until calibrated. |

Applying the English ratio to Arabic or Chinese is the failure this whole section exists to prevent — it is confident, silent, and wrong by a large factor. When a script has no calibration row, Tier 3 returns `UNAVAILABLE` with a specific `missing_data[]` entry ("no calibration samples for `ar_vocalized` on this model"), and the UI shows a live *character* count instead of a fake token count. A blank token field is honest; a wrong one is not.

#### A4.5.5 Two numbers, not one — padding is directional

A `+15%` safety buffer is correct for one consumer and wrong for the other, and shipping a single padded number silently breaks whichever one you didn't think about:

| Consumer | Wants | Padding |
|---|---|---|
| **Context-overflow check** | to over-estimate — a wrong guess must fail safe | **+ buffer** |
| **Cost estimate / quote** | to be centred — padding inflates what you tell the client | **none** |

So Tier 3 emits both, and they are separate fields all the way to the UI:

```
cost_estimate            = raw heuristic          → P50 / P90, feeds §A5.8
context_safety_estimate  = raw × (1 + HEURISTIC_SAFETY_PAD_PCT)  → feeds the
                           context-window and max_tokens checks ONLY
```

`HEURISTIC_SAFETY_PAD_PCT` is a config value, not a literal, and it applies to Tier 3 only — padding a Tier 1 ground-truth count is just overquoting. Never let the padded number reach a price.

#### A4.5.6 Processing flow (implement exactly)

```
estimateTokens(payload, model, mode)

1. Tier 0 — cache lookup on the composite key. Hit → return with the cached tier's
            method and confidence. Never re-tag a cached Tier 3 value as Tier 1.

2. mode == LIVE_UI or OFFLINE
     → Tier 2 if a local exact vocabulary exists and payload is text-only
     → else Tier 3, if a calibration row exists for this (model, script, content_type)
     → else UNAVAILABLE + missing_data[]. Show a character count, not a token count.

3. mode == ESTIMATE or COMMIT, or ANY of:
     - payload contains image / audio / video
     - result is within TIER_PROXIMITY_WARN_PCT of a context window or price tier
     - tokenizer_availability is PROXY and measured_delta_pct is null
     - the user is committing this figure as a quote
   → escalate to Tier 1. On 429 / timeout / offline:
       a. RETRY FIRST. A 429 carries Retry-After; honour it, with bounded exponential
          backoff and jitter. Falling back on the first 429 discards an available
          ground-truth path for a delay measured in seconds, and under batch load it
          turns a queueing problem into permanent accuracy loss. Queue and pace batch
          estimates against the adapter's own limit rather than firing them in
          parallel and eating the 429s.
       b. THEN FALL BACK EXACTLY ONE TIER — Tier 1 → Tier 2 when a local exact
          vocabulary exists for this model; only Tier 3 when it does not. Dropping
          straight from 1 to 3 skips an available exact local count and is strictly
          worse for no reason.
       c. RE-TAG the line with the tier actually used, lower confidence to that
          tier's, and raise ESCALATION_FAILED. Never present a fallback number
          wearing the confidence of the tier you wanted.

4. Write through to cache. If Tier 1 ran, compute the Tier 2 and Tier 3 counterfactuals
   and append the deltas to the calibration store (§A4.5.2).
```

**The invariant across all four tiers:** the `method` and `confidence` on the returned line describe the tier that *actually produced the number*, never the tier that was requested. Every downgrade is visible in the UI. A silent downgrade is the same class of bug as a hardcoded rate.

---

### A4.6 MEASURING WHAT DOCUMENTATION DOES NOT PUBLISH

Three quantities in this spec have **no documentary source at any vendor**, and a fourth exists only for some vendors. Reading harder will not produce them:

| Quantity | Why no document has it | Harness |
|---|---|---|
| `framing_tokens_per_message` | An artifact of the chat template, never published | Calibration (§A4.1) |
| Script ratios per `(model, script, content_type)` | Vendor pages quote English; Arabic is a different number per tokenizer | Calibration (§A4.1) |
| `prefill` / `decode` throughput | Vendor claims are marketing; only your hardware counts | Benchmark on your own instances |
| **Vision geometry, where unpublished** | Several providers publish vision *rates* with no geometry, or an architecture with no token count | **Geometry probe, below** |

#### A4.6.1 The geometry probe

Where a provider publishes no formula, one API call per probe point returns `usage.prompt_tokens`; subtract a text-only baseline and the remainder is the visual-token count. That settles in an afternoon what documentation has failed to settle, and it turns an `UNAVAILABLE` row into a sourced one.

**Design rules, all of which are the honesty contract applied to measurement:**

1. **Spend money only on purpose.** `--dry-run` is the default and prints a deliberately pessimistic cost upper bound; `--confirm` is required to make a call; `--max-calls` is a hard stop. Cache every result to disk so a crash costs nothing twice. Pin `max_tokens: 1` — you are measuring the input side, and paying for generated output buys nothing.
2. **Run a control model first, and refuse to trust the run without it.** Pick a model whose geometry *is* published, with known worked answers, and probe it in the same harness. A wrongly subtracted baseline, a provider silently re-encoding the upload, a `detail` parameter being ignored — every one of these produces plausible numbers and a wrong formula. **If the harness cannot recover the control's known geometry, every other result in the run is worthless.** This is the single most important line in the probe.
3. **Choose probe points to discriminate, not to sample.** Every candidate geometry is roughly monotonic in area, so most sizes agree and teach nothing. The information sits at boundaries where the candidates disagree: one pixel either side of each candidate's block or tile size, exact multiples of each candidate patch size, and the extremes that exercise caps and clamps.
4. **Include a transposed pair — it is the decisive measurement.** Patch grids, tile grids, area budgets and flat rates are all commutative, so `w×h` and `h×w` return the same count. A geometry with a width-dependent term does not. **Equal counts rule out every asymmetric formula in one comparison; unequal counts prove that any tile-grid implementation is wrong for that model.** One pair of calls, and the candidate set halves.
5. **Never return a best guess.** A candidate that explains most points is a coincidence with counterexamples. A fit is reported only when the residual is zero across *every* observation; anything else is `UNKNOWN` with the misses listed. If two candidates fit exactly, that is not a result either — it means the probe grid does not discriminate between them, and the answer is "add sizes that straddle their differing boundaries and re-run."
6. **A measurement is evidence, not a registry entry.** The probe writes a generated JSON file for a human to review. It does not write to the pricing registry. §A3 applies to measured constants exactly as it applies to sourced ones.
7. **Fail loudly and specifically.** A provider that does not report prompt tokens cannot be probed by this method — say that, rather than inferring a number from something else in the response. Context overruns are recorded as skipped, errors as errors, both with the message. Do not retry an auth failure or a rejected image; retrying spends money on a request that will fail identically.

**Probe images must be deterministic and byte-identical across machines** — that is what makes the cache key honest on a resumed or shared run. Generate them without an image library: a library may silently re-encode, strip or resample, and when the entire question is "what pixel dimensions did the provider actually see", a library between you and the bytes is an uncontrolled variable. Avoid a flat fill (a provider may short-circuit on trivial content, and the byte size is unrealistic) and avoid per-pixel noise (incompressible, and the largest and most informative probe point will fail on a file-size limit rather than on geometry). Deterministic coloured blocks sit between the two.

Test the fitter against **synthetic data generated from geometries you already know**, so the tests run offline and cost nothing. The negative cases matter more than the positive ones: a fitter that always returns something is worse than useless, because it launders a guess into a measurement.

---

### A5. THE ESTIMATION ENGINE (`/packages/estimator`)

#### A5.1 Text input tokens

```
input_tokens = tokenize(rendered_prompt) + framing_overhead + tool_schema_tokens
```

Three components, all real, all commonly forgotten:

1. **Rendered prompt** — the actual user + system content, run through the model's tokenizer.
2. **Framing overhead** — chat-template scaffolding, role markers, BOS/EOS, message separators. This is per-model and per-turn. Derive it empirically: tokenize a message with the template applied, subtract the raw content count, store as `framing_tokens_per_message` in the calibration table. Do not assume it's a constant across families.
3. **Tool schema tokens** — every function/tool definition is serialized into the context *before the user types anything*. Tokenize the actual JSON schema payload. For agentic workflows with many tools this frequently dominates a short prompt.

**Language inflation** is handled by the tokenizer itself when the method is `EXACT_TOKENIZER` — no ratio needed. Ratios are only for `CALIBRATED_HEURISTIC` mode (fast preview, offline, or PROXY-tokenizer models).

#### A5.2 Vision / image input tokens

Image cost is a function of **pixel dimensions and detail mode**, not file size.

⚠️ **There is no single vision formula. Do not write one.** An earlier draft of this section gave `tiles = ceil(w/tile_w) × ceil(h/tile_h); tokens = base + tiles × per_tile` as *the* formula. That is one geometry among at least six in production, and implementing it as a universal misprices most non-OpenAI vision models — silently, in a consistent direction, which is the hardest kind of error to notice.

`vision_profile.geometry` selects the branch. A model whose geometry is unknown is `UNAVAILABLE`; it is never defaulted to the familiar one.

##### A5.2.0 The geometry families

| ID | Geometry | Shape | Distinguishing behaviour |
|---|---|---|---|
| **G1a** | `PATCH_GRID` + `TOKEN_CAP` | `patches = ⌈w/P⌉ × ⌈h/P⌉`, binary-search a scale so `patches ≤ cap` | **Cost saturates.** Above the cap a bigger image costs the same and loses detail. |
| **G1b** | `PATCH_GRID` + `AREA_CLAMP` | round both dims up to a multiple of `P`, clamp total area into `[min_area, max_area]`, `tokens = (w/P) × (h/P)` | **Cost does not saturate.** Large images stay expensive and stay faithful. |
| **G2** | `TILE_GRID` | `base + per_tile × ⌈w/tw⌉ × ⌈h/th⌉`, after short-side normalization | Discrete steps at tile boundaries. |
| **G3** | `AREA_BUDGET` | `min(budget, area_px / divisor)` | **Smooth in pixels — no ceiling behaviour.** Resize savings are continuous here and discrete under G1/G2. |
| **G4** | `FLAT` | `flat_tokens_per_image` | Constant regardless of dimensions. Resize proposals must be **suppressed entirely** — they save nothing by construction. |
| **G5** | `BLOCK_GRID_SEP` | `(h·w + 1) × per_block + (w + 1) × sep + const`, over a block grid chosen from a bounded candidate list | A **global view** term (`+1`) plus **width-dependent** row separators. No Western geometry has an analogue. |

> ⚠️ **G1a and G1b are the same patch size and produce wildly different answers.** Per Annex A15 §3 (vendor pages, verified 2026‑09‑06), Claude, Qwen‑VL and GLM‑4.1V all use a 28‑px patch grid — but Claude bounds on a *token cap* and the two Chinese models bound on a *pixel-area range*. On the same oversized scan the annex records Claude saturating in the low thousands of tokens while Qwen‑VL runs to five figures: an order-of-magnitude divergence from a formula that looks identical on paper. `bound_type ∈ { TOKEN_CAP | AREA_CLAMP }` is therefore a required registry field, with `min_area_px` / `max_area_px` for the clamp case. A router comparing those two on price alone, without the source dimensions, will be wrong about which is cheaper.

> ⚠️ **Token cost is not monotonic in pixel count under G5.** The annex documents a DeepSeek‑VL2 case where a larger image costs *fewer* tokens than a smaller one, because the block-selection rule lands on a cheaper grid. Any "smaller is cheaper" shortcut produces wrong advice on that model. This is independent confirmation that rung 4 of the disposition ladder (§A5.2.1) must **actually recompute** rather than reason about direction.

> ⚠️ **Wire compatibility predicts nothing about billing geometry.** Every Chinese VLM checked speaks the OpenAI protocol and accepts the same `detail: low | high` parameter, and not one of them uses OpenAI's geometry. Do not infer a geometry from an endpoint shape.

##### A5.2.0b Evaluate `detail` before geometry

`detail: low` is a **flat rate on every Chinese VLM checked** — a constant, regardless of input dimensions. So on those models low-detail mode *is* geometry G4, and the branch order matters:

```
1. resolve detail mode
2. if low_detail_geometry == FLAT → return low_detail_flat_tokens. STOP.
3. otherwise branch on vision_profile.geometry
```

Resolving geometry first and applying the detail flag afterwards produces a number that is wrong by a large factor on exactly the models where `detail: low` is most attractive. `low_detail_geometry ∈ { FLAT | INHERIT }` is a registry field.

And note what this makes `detail: low`: on a large scan it is a very large token reduction *and* the setting that destroys Arabic dot placement and diacritics first (§A5.2.1). **It is a quality decision wearing a cost decision's clothes.** Surface both numbers and let the client choose; never select it automatically to make an estimate look better.

##### A5.2.0c Required `vision_profile` fields

```
geometry ∈ { PATCH_GRID | TILE_GRID | AREA_BUDGET | FLAT | BLOCK_GRID_SEP }
bound_type ∈ { TOKEN_CAP | AREA_CLAMP }        ← patch grids differ on this
patch_px | tile_w, tile_h                       base_tokens   per_tile_tokens
token_cap | min_area_px, max_area_px            area_divisor  area_budget_tokens
flat_tokens_per_image                           low_detail_flat_tokens
low_detail_geometry ∈ { FLAT | INHERIT }
block_px  global_view_included  sep_tokens_per_row  sep_constant  max_blocks
candidate_resolutions[]                         ← where selection is a bounded lookup
max_edge_px  min_edge_px  shortest_edge_target_px  max_bytes  max_pages  allowed_mime[]
provider_auto_normalizes                        min_legible_edge_px[script, density]
```

Every one is a DB field with its own provenance. Populate from each provider's own vision documentation. **Do not hardcode any of these values** — they differ per family and change across model generations.

A schema refinement must enforce that each geometry carries its own parameters and no others': a `TILE_GRID` row with a null `per_tile_tokens` silently prices every image at `base_tokens`, and that is the exact bug the refinement exists to catch.

##### A5.2.0d When the vendor contradicts itself

Vendor documentation disagreeing with *itself* on the same page is not hypothetical — the annex records it on two providers. §A3 rule 5 applies to a single source contradicting itself exactly as it applies to two sources disagreeing: **report, do not merge, do not average.** Seed the variant whose worked examples are internally consistent, flag the row `needs_human_review`, and record both readings.

Ship a **pre-flight dimension calculator** in the client: read intrinsic width/height before upload, compute the tile grid, and show the projected token cost *before* the user commits. Warn when a resize would cut cost materially.

#### A5.2.1 Oversized and out-of-spec assets — the disposition ladder

The pre-flight calculator above *detects* a violation. This is what happens next. Constraints are per-model DB fields (`max_edge_px`, `min_edge_px`, `shortest_edge_target_px`, `max_bytes`, `max_pages`, `max_duration_seconds`, `max_frames`, `allowed_mime[]`) — **never literals in code**, for the same reason as every other vision parameter: they differ per family and change across generations.

> ⚠️ **This is an estimator, not an execution pipeline. It must not mutate the user's asset.**
> "Scale down locally before it reaches the payload stage" is right for a production request path and wrong here. Downscaling silently means the user is shown a price for an asset they didn't upload — and worse, **resolution is a quality decision, not a cost decision**. Losing OCR fidelity on a dense contract to save tokens is the client's call, not the pipeline's. So the engine **computes both scenarios and proposes**; it never rewrites the input.

**The ladder, evaluated in order. Stop at the first rung that resolves.**

| # | Rung | Trigger | Behaviour |
|---|---|---|---|
| 0 | **Measure** | always | Read true intrinsic dimensions, byte size, page/frame count, MIME by magic bytes. Provenance `MEASURED_FROM_ASSET`. |
| 1 | **Fits as-is** | within every constraint | Estimate normally. No flag. |
| 2 | **Provider auto-normalizes** | provider scales the asset itself before billing | Compute tiles on the **provider's post-normalization dimensions**, not the user's. Tag `DERIVED_FROM_ASSET` and name the rule applied. |
| 3 | **Resize proposed** | over `max_edge_px`, fidelity not marked critical | Compute both estimates side by side. Present as a choice; only pre-select the resize if it actually saves (rung 4). |
| 4 | **Resize saves nothing** | recomputed tile grid is unchanged or larger | Do **not** propose it. Say so. See below. |
| 5 | **Fidelity locked** | user marked the task OCR-critical, or script rules below apply | Skip resize entirely. Force explicit high-detail tiling and price the real cost. |
| 6 | **Reroute** | no disposition fits this model | Hand to the capability gate as an exclusion; let §A7 pick a model that accepts the asset. |
| 7 | **Blocked** | violation makes cost unknowable | `missing_data[]` + `needs_human_review: true`. No number. |

**Rung 4 deserves its own rule, because "downscale = cheaper" is often false.** Tiles are a ceiling function, so a resize that doesn't cross a tile boundary changes nothing. Worse, several providers **upscale** anything below `shortest_edge_target_px`, so shrinking too far can *increase* the tile count. And a flat low-detail mode may already be cheaper than any resize. So:

```
propose_resize ONLY IF
  tiles(scaled_w, scaled_h) < tiles(original_w, original_h)
  AND scaled_shortest_edge >= shortest_edge_target_px
```

Never show a resize suggestion whose saving you have not actually recomputed. A suggestion that saves nothing teaches the user to ignore all of them.

**Script-aware fidelity floors.** Downscaling destroys legibility at very different rates by script, and this app's workloads are Arabic and Chinese:

- **Arabic** — diacritics, dot placement (ب ت ث ن ي differ only by dots), and the ي/ى distinction are the first casualties. A vocalized or handwritten Arabic document has a much higher fidelity floor than Latin prose.
- **Chinese / Japanese** — dense glyphs lose stroke separation early; a small point size that survives at full resolution becomes an unrecognizable blob.
- **Latin prose** — most tolerant. Do not derive the other two from it.

Store `min_legible_edge_px` per `(script, content_density)` in the vision profile. Where the script is unknown or mixed, take the **strictest** floor present, not the average. Below the floor, rung 3 is unavailable and the ladder goes to rung 5.

**Rung 6 — rerouting, and the filter it does not get to skip.** An oversized asset becomes a capability-gate criterion like any other, with an `excluded_models[]` reason of `ASSET_EXCEEDS_CONSTRAINTS` naming which constraint and by how much.

⚠️ **Rerouting never overrides the data-residency hard filter (§A6).** "Send the oversized document to whichever model has the largest capacity" is exactly how a KSA client's contract ends up at a PRC-hosted endpoint because it was a few hundred pixels too wide. Residency, DPA availability and `is_prc_hosted` are evaluated **before** capacity, always. A reroute that no residency-permitted model can absorb is rung 7, not a quiet exception.

Every reroute writes an `assumptions[]` entry: `{ field: "routed_model", assumed_value, basis: "ASSET_CONSTRAINT_REROUTE", impact_if_wrong }`, and the results table shows the substitution inline — the user asked about model X and is being quoted model Y, and that must never be discoverable only by reading a tooltip.

**Provenance, corrected.** Provenance describes *where the dimension value came from*, and detail mode is a separate field — changing the tiling mode does not change provenance:

| Situation | `dimensions_source` | `detail_mode` |
|---|---|---|
| Read from the user's file | `MEASURED_FROM_ASSET` | as chosen |
| Provider normalized it, or the user accepted a resize | `DERIVED_FROM_ASSET` (+ the transform rule) | as chosen |
| No asset yet, seed default | `DEFAULT_APPLIED` | seed default |

**Also constrain, not just max pixels:** `min_edge_px` (below which a provider may reject or upscale), `max_bytes`, `max_pages` for PDFs, `max_duration_seconds` and `max_frames` for video, and `allowed_mime[]` validated by magic bytes (§A10). **For multi-page documents the blow-up is per page** — an oversized page multiplies across the whole file, so evaluate the ladder on the page template and multiply, and surface `pages × tiles_per_page` as its own estimate line rather than one opaque total.

**Warnings this rung raises:** `ASSET_EXCEEDS_MAX_EDGE`, `RESIZE_SAVES_NOTHING`, `RESIZE_BELOW_LEGIBILITY_FLOOR`, `PROVIDER_WILL_NORMALIZE`, `REROUTED_FOR_ASSET_CONSTRAINT`, `REROUTE_BLOCKED_BY_RESIDENCY`.

#### A5.3 Audio / video

Duration-driven, not byte-driven.

```
audio_tokens = ceil(duration_seconds) * tokens_per_second[model]
video_tokens = frames_sampled * per_frame_image_tokens + audio_track_tokens
```

`tokens_per_second`, `frame_sample_rate_hz`, and whether the audio track is billed separately are all DB parameters per model. Video is the highest-variance modality — force `confidence: LOW` unless the provider publishes a deterministic formula.

#### A5.4 Output + reasoning tokens (the non-deterministic half)

You cannot know these before the call. Model them as **distributions**:

```
output_tokens ~ Distribution(p50, p90, cap = max_tokens)
reasoning_tokens ~ Distribution(p50, p90)   // only for reasoning-capable models
billable_output = output_tokens + reasoning_tokens
```

- Seed the distribution from `task_type` priors (`classify` ≪ `summarize` < `draft` < `long_form_generate` < `agentic_multi_step`), each prior calibrated from observed runs, not invented.
- **Reasoning tokens are invisible but billed.** For any model flagged `is_reasoning_model`, a reasoning term is mandatory. Reading `usage.completion_tokens_details` (or the provider's equivalent field) from real responses is what feeds this prior — wire that capture from day one.
- Always clamp by the configured `max_tokens`. Surface "your cap is below P90, expect truncation" as a warning.

#### A5.5 Multi-turn context growth

A chat workflow re-sends history every turn. Cost is quadratic-ish, not linear.

```
turn_n_input = system + tools + Σ(prior turn inputs + prior turn outputs) + new_input
total_input  = Σ over turns
```

Model three strategies and let the user pick: `FULL_HISTORY`, `SLIDING_WINDOW(k)`, `SUMMARIZED_ROLLUP(every_n)`. Show the total-cost delta between them. This is usually the single biggest optimization lever in a chatbot workflow and it belongs in the UI, not in a footnote.

#### A5.6 Caching

```
effective_input_cost =
    (cached_tokens * cache_read_rate)
  + (cache_write_tokens * cache_write_rate)
  + (uncached_tokens * standard_input_rate)
```

`cache_read_rate`, `cache_write_rate`, minimum cacheable prefix length, and TTL are per-provider DB fields — providers differ on all four, and some charge a **premium** to write the cache. `cache_hit_ratio` is a user-editable **assumption**, defaulted per workflow shape (high for a fixed system prompt + tools, low for one-shot varied prompts), never silently set to a flattering number.

#### A5.7 Context-window tier pricing

Some providers charge a higher rate once the request crosses a context threshold. Model as a **step function**, not a flat rate:

```
rate = tiers.find(t => total_input_tokens <= t.upper_bound).rate
```

`tiers[]` is a DB array per model. The UI must warn when an estimate lands within `TIER_PROXIMITY_WARN_PCT` of a threshold — that's where a small prompt trim produces an outsized saving.

#### A5.8 API-managed cost formula (canonical)

```
API_COST =
    (billable_input_tokens  × input_rate(tier))
  + (billable_output_tokens × output_rate)          // includes reasoning tokens
  + (image_tokens           × image_rate_or_tile_rate)
  + (audio_seconds          × audio_rate)
  − (cached_tokens          × (input_rate − cache_read_rate))
  + (cache_write_tokens     × cache_write_rate)
  + per_request_fees
```

Return P50 and P90 of this, per task, per candidate model.

#### A5.9 Self-hosted cost formula (canonical)

Costing flips from per-token to **per-second of GPU wall-clock**.

```
prefill_seconds  = input_tokens / prefill_throughput_tps
decode_seconds   = output_tokens / decode_throughput_tps
request_seconds  = ttft_seconds + prefill_seconds + decode_seconds

effective_seconds = request_seconds / concurrency_efficiency_factor

SELF_HOSTED_COST = effective_seconds
                 × (instance_hourly_rate / 3600)
                 × (1 + regional_tax_rate)
                 ÷ utilization_factor
```

Mandatory companions:

**Feasibility gate (VRAM).** Refuse to cost a deployment that cannot physically run:

```
weights_bytes   = params × bytes_per_param(quantization)
kv_cache_bytes  = f(layers, kv_heads, head_dim, max_context, batch_size, kv_dtype)
required_vram   = weights_bytes + kv_cache_bytes + activation_overhead
FEASIBLE        = required_vram <= (gpu_count × vram_per_gpu × usable_fraction)
```

All model-architecture fields come from the model card (`config.json`), stored in DB. If a field is missing → `UNAVAILABLE`, not a guess.

⚠️ **Four errors available in that formula, in descending size:**

1. **`kv_heads`, not attention heads.** Under grouped-query attention a model may expose many query heads and only a handful of KV heads; using the query count can overstate KV cache by ~7×. It is the largest single error in the gate. Note also that not every model *has* GQA — where `num_key_value_heads == num_attention_heads` the distinction makes no difference, which is why the code must read the field rather than assume the architecture. The annex records a counter-intuitive consequence: a smaller model with full multi-head attention can hold *more* KV per token than a larger model with GQA. Nothing in a parameter count predicts that.
2. **Mixture-of-experts weights use TOTAL parameters, not active.** Every expert stays resident in VRAM; only *throughput* reflects the active subset. Sizing an MoE model on active params understates weight VRAM by roughly the expert ratio.
3. **FlashAttention does not reduce the KV cache.** It avoids materializing the attention matrix, which cuts *activation* memory. What actually reduces KV cache: grouped-query attention (architectural, already in the formula), paged attention (removes fragmentation waste rather than compressing), and **KV quantization** — which is worth modelling, via a `kv_dtype` that is set independently of the weight quantization. Keep `supports_flash_attention` away from the `kv_cache` term in the code, or the next person to touch the file will reintroduce this.
4. **`gpu_memory_utilization` caps the engine's total footprint** — weights plus KV plus activations — not a reserve earmarked for anything. The remainder covers CUDA context and fragmentation.

And one rule of thumb that does not generalize: "GB per 32k tokens" figures are model-specific. A deep model with few KV heads and a shallow one with many differ by an order of magnitude for the same context. **Compute the term; never carry the constant across model sizes.**

##### A5.9.1 The VLM chain — visual tokens have two destinations

Vision geometry (§A5.2) and VRAM sizing are usually written as separate concerns, and that split is where VLM estimates go wrong. **The geometry output is the sizing input:**

```
pixels ──[§A5.2 geometry]──▶ visual_tokens ──┬──▶ hosted:      × input_rate
                                             └──▶ self-hosted: × KV bytes/token ──▶ VRAM

kv_cache = 2 × layers × kv_heads × head_dim × bytes_per_param(kv_dtype)
              × MIN(visual_tokens + text_context_tokens, max_context)
```

One quantity, two destinations — so **a geometry error propagates into both**. A 34% visual-token undercount is a 34% KV-cache undercount, which is what turns a "fits comfortably" cell into an out-of-memory crash under load.

⚠️ **Visual tokens must also feed the context-window gate, not just the cost line.** The annex documents a VLM whose maximum context is small enough that a *single* ordinary-resolution image consumes roughly half of it — two images plus a prompt do not fit at all. That is a **capability limit wearing a cost limit's clothes**, and it is invisible in a VRAM table (the KV cache clamps to a reassuringly small number, which is exactly backwards). So:

- carry `max_context` on every vision row and compute `image_share_of_context`;
- raise `CONTEXT_TOO_SMALL` from the *visual* token count, not only from text;
- clamp the KV term by `MIN(tokens, max_context)` so the memory figure cannot exceed what the model can actually hold.

**Prefill dominates decode on document work.** A multi-thousand-token image answered in a couple of hundred tokens makes prefill the overwhelming majority of compute — the opposite of a chat workload. So for document VLM sizing the bottleneck is `prefill_throughput_tps`, not `decode_throughput_tps`, and the self-hosted estimate must be sensitive to the right one.

Additional registry fields this requires: `kv_dtype`, `image_activation_buffer_gb` (nullable, `USER_SUPPLIED` until measured on a real deployment), `prefill_throughput_tps`, `supports_flash_attention`, `supports_paged_attention`, `served_quantization`.

⚠️ **`served_quantization` matters for price comparison, not just sizing.** A hosted provider serving a model at FP8 or INT4 is not serving the same artifact as one serving it at BF16, even under the same model name. A price comparison that ignores quantization is comparing different models.

**Utilization is the honest lever.** A GPU billed 24/7 at 8% utilization has a per-token cost orders of magnitude worse than the same GPU saturated. Force the user to state `expected_requests_per_day` and `utilization_factor`, then compute and display the **breakeven request volume** where self-hosted crosses below API. That crossover chart is the most valuable screen in the product — build it first.

**Also include:** idle/always-on cost, cold-start cost for scale-to-zero, storage for weights, egress, and an ops-labour line item (a flat, user-editable monthly figure — labelled as an assumption, since it is one).

#### A5.10 Request-level multipliers and non-token fees

The identity in §A5.8 covers what is metered per token. Vendor pages carry three more layers that it does not, and each one moves a real invoice. **These belong on the request, not on the model row** — the same model priced under two service tiers is two different answers from one registry entry.

```
FINAL_COST = ( TOKEN_TERMS(§A5.8)
             + cache_storage_tokens × storage_rate_per_1m_per_hour × hours_held
             + tool_use_system_prompt_tokens × input_rate
             + Σ server_tool_calls × per_call_fee )
           × service_tier_multiplier
           × (1 + residency_uplift_pct)
```

| Term | What it is | Why it is missed |
|---|---|---|
| **Service tier multiplier** | Batch / flex / fast / priority tiers scale the whole bill. Discounted async tiers materially change overnight and bulk workloads. | It is a *request* attribute, so a row-level registry has nowhere to put it. ⚠️ The multipliers are **not shared across vendors** — the annex records one provider's premium tier at 1.8× where two others use 2×. Store per provider, never as a shared constant. |
| **Residency uplift** | Regional/in-country endpoints carry a percentage uplift on *all* categories, cache reads and writes included. | Invisible until the contract requires the regional endpoint. **This binds directly on Gulf routing** — the compliant option is not the same price as the default one, and a router that filters on residency without applying the uplift understates the compliant path. |
| **Cache storage per hour** | At least one provider bills cached content **by the hour whether or not you call the model**. | Every cache model in this spec until now assumed cache is priced on write and read only. That is true for some providers and not others, so it is a **per-provider field, not a universal term** — `storage_rate_per_1m_per_hour`, nullable. A long-lived cache on a low-traffic workload can cost more than it saves; the estimator must be able to show that. |
| **Tool-use system prompt** | A published, per-model token count for merely *enabling* tools — **separate from and additional to** the tool schema JSON in §A5.1. | §A5.1 counts the schemas you send. This is what the provider injects on top. Two meters, both real, and one provider reports tool tokens as its own usage field — independent confirmation they are not a subset of input. |
| **Server-tool per-call fees** | Web search, file search, code containers: **not token-priced at all**. Priced per thousand calls, per GB-day, or per session. | They do not appear in any token arithmetic, so a token-only estimator returns zero for them. An agentic workflow with search enabled can have a majority of its cost here. |
| **Failed generations** | Some providers do not bill failed renders; others do. `bills_failed_generations` is a published field on at least one video model. | Assuming either way is a guess. Where it bills, `expected_retry_rate` is a labelled assumption. |
| **Re-rolls** | Image workflows generate N candidates per accepted image. | Every candidate bills. `candidates_per_accepted_image` is a required task field, defaulting to 1 and almost never actually 1. |

Two shape corrections to §A5.7 that follow from the same source:

- **Not every model has context tiers.** At least one provider includes its full long context at the standard rate, so `context_tiers` is `null` for that family — not a single-entry array, and not an assumed surcharge.
- **A tier can rebill the whole request, not the overflow.** Where crossing a threshold reprices *every* token in the request rather than the excess, the step is far larger than a marginal reading suggests. `applies_to_whole_request: boolean` on each tier, and the near-threshold warning (§A5.7) must use the right one.

**Image generation has a fourth pricing dimension.** §A7's `per_image | per_megapixel | per_step` is incomplete: some providers meter image output **in tokens** and the per-image figure is derived (`tokens_for_resolution × output_rate`). Add `per_output_token` and store the resolution→token map, rendering the derived per-image figure as authoritative with the token figure as the explanation. Where a vendor sells only a **subscription**, `pricing_model: 'subscription'` makes the model **non-comparable in the router** rather than assigned a synthesized per-unit price — averaging a monthly fee into a per-image number is exactly the invented figure §A3 exists to prevent.

---

### A6. MODEL REGISTRY (global + Chinese, tiered)

Registry-driven. Adding a provider = inserting rows, never editing code.

**Provider families to seed** (populate specs from each vendor's own docs — the app ships with the *shape*, you supply the *values*):

- **Global:** OpenAI, Anthropic, Google, Meta (open-weight), Mistral, xAI, Amazon Bedrock / Azure AI as *routes* to the above
- **Chinese:** DeepSeek, Alibaba Qwen, Zhipu GLM, Moonshot Kimi, Baidu ERNIE / Wenxin, Tencent Hunyuan, ByteDance Doubao, MiniMax, 01.AI Yi
- **Aggregators/routes:** OpenRouter, Together, Fireworks, Groq, SiliconFlow

Each model row carries: `tier` (`FRONTIER | MID | LIGHTWEIGHT`), `modalities_in[]`, `modalities_out[]`, `context_window`, `max_output`, `is_reasoning_model`, `supports_tools`, `supports_caching`, `supports_vision`, `tokenizer_availability` (`LOCAL_EXACT | REMOTE_API | PROXY | NONE`), `open_weights` (bool), `params_b` (nullable), `license`, `data_residency_region`, `quality_score_source` (nullable + `source_url` — **do not invent benchmark scores**; if you have no sourced score, leave null and let the router rank on cost + capability only).

**Compliance dimension (do not skip for Gulf/KSA/Kuwait/Qatar/Jordan deployments):** add `data_residency_region`, `is_prc_hosted`, and `contractual_dpa_available` flags. A model can be the cheapest option and still be disqualified by a client's data-residency policy. The router must support a **hard filter** on these before it ranks on price.

---

### A7. WORKFLOW DECONSTRUCTION → ROUTING

```
[User Workflow Input]
        ↓
[Request Analyzer]  ── PART B system prompt, or deterministic parser for structured input
   ├── classify sub-requests: READ | WRITE | EDIT
   ├── count volume per type
   └── extract assets: char counts, image dimensions, audio duration, tool schemas
        ↓
[Capability Gate]   ── drop models lacking required modality/tools/context/residency
        ↓
[Estimator]         ── §A5, per surviving model, P50 + P90
        ↓
[Pricing Resolver]  ── §A4, versioned rates + staleness check
        ↓
[Router]            ── rank under three objectives
        ↓
[Recommendations]   ── Cheapest | Best-Capability | Balanced  (+ per-task split routing)
```

**Task taxonomy** (implement exactly these three, with sub-kinds):

| Type | Sub-kinds | Dominant cost driver |
|---|---|---|
| **READ** | context ingestion, vision OCR, image analysis, doc parsing | input tokens / image tiles |
| **WRITE** | completion, reasoning, creative draft, structured JSON | output + reasoning tokens |
| **EDIT** | rewrite, inpainting, img2img, upscale | input + output, plus compute multipliers |

For image **EDIT**, differentiate cost classes explicitly: text-to-image, image-to-image conditioning, mask/inpaint, and upscale multiplier. These are priced per-operation or per-megapixel by most providers, **not** per token — so the image-generation cost model is a separate pricing dimension (`per_image`, `per_megapixel`, `per_step`), not a token formula.

**Split routing is a first-class output.** The best answer is often "cheap lightweight model for the 40 READ classifications, frontier model for the 2 WRITE steps." The router must evaluate per-task assignment, not just one model for the whole workflow, and report the saving versus single-model routing.

**Every recommendation must carry a rationale object:** `{ triggering_metric, observed_value, threshold, evidence_ref }`. A recommendation without one does not render.

---

### A8. SCENARIOS

Support named, saveable, comparable scenarios — this is the "multiple scenarios" requirement:

- **Volume scenarios:** requests/day × days, with growth curve
- **Deployment scenarios:** API vs self-hosted vs hybrid, side by side
- **Model scenarios:** N candidate models on the same workflow
- **Optimization scenarios:** with/without caching, with/without history trimming, with/without model downsizing
- **Sensitivity analysis:** tornado chart over the assumption set — which single assumption moves total cost most
- **Monte Carlo:** sample the output/reasoning/cache distributions N times, render the cost histogram with P50/P90/P99

Persist every scenario with the exact pricing snapshot ID used, so an old estimate can be reproduced verbatim even after prices move.

---

### A9. UI / UX (2026 rules)

✅ **Mobile-first** — 56px minimum touch targets, fluid `clamp()` typography
✅ **Minimal nav** — 3 top-level links max (`Estimate`, `Compare`, `Registry`), progress dots on the side rail for the multi-step estimate flow
✅ **Fast** — CSS-only animations, lazy-load syntax highlighting, stream partial estimates as each model resolves
✅ **Interactive** — accordions for assumption groups, tabs for API-vs-self-hosted, a persistent pre-launch checklist
✅ **Bilingual** — full AR/EN with RTL layout support; the token calculator itself must demonstrate Arabic inflation correctly (dogfood it)
✅ **Theme-aware** — light + dark, tokens defined on `:root`, never a color defined only inside a media query

Key screens, in build order:
1. Workflow builder (add tasks, attach assets, set volume)
2. Assumptions panel (every assumption editable, each showing its default's provenance)
3. Estimate results — per-task table, P50/P90 columns, method + confidence badges
4. **Breakeven chart** — self-hosted vs API across request volume
5. Optimization report — ranked levers with projected % saving
6. Admin: pricing registry, manual overrides, staleness dashboard, conflict queue

---

### A10. SECURITY

- JWT access + refresh rotation, httpOnly cookies
- Rate limit every route; stricter bucket on `/api/estimate` and any route touching a remote count-tokens API
- Helmet.js CSP; no inline scripts
- Zod-validate all ingested aggregator JSON **before** it touches the DB — a malformed upstream feed must not poison pricing
- Provider API keys server-side only, encrypted at rest, never in client bundles or logs
- Admin pricing writes are RBAC-gated and fully audit-logged (`who, what, old_value, new_value, source_url, when`)
- Uploaded assets: strip EXIF, validate MIME by magic bytes not extension, size caps, virus scan hook

---

### A11. TESTS

**Vitest (unit) — `/packages/estimator`:**
- Golden-file tokenizer tests per family, including an Arabic string, a Chinese string, a code block, and a deeply nested JSON payload
- Tile-grid math: boundary cases (1px over a tile edge, extreme aspect ratios, below-minimum images)
- VRAM feasibility: exactly-at-capacity, one byte over, missing architecture field → `UNAVAILABLE`
- Tier step function: exactly at threshold, one token over
- Cache math: 0% and 100% hit ratio, cache-write premium exceeding the read saving
- **Negative:** missing rate → throws `MissingRateError`; stale rate → `needs_human_review: true`; conflicting sources → both returned, no average

**Playwright (POM) — `/apps/web/e2e`:**
- POM classes: `WorkflowBuilderPage`, `AssumptionsPanel`, `ResultsPage`, `AdminPricingPage`
- Positive: build a 3-task mixed-modality workflow → estimate returns ranked models with P50/P90 and every row shows a method badge
- Positive: edit `cache_hit_ratio` → totals recompute, sensitivity chart reorders
- Positive: RTL renders correctly with Arabic input; touch targets ≥ 56px
- **Negative:** model with expired pricing → UI shows a blocking "rate stale" state, **not** a number
- **Negative:** image exceeding max edge → pre-flight warns before upload
- **Negative:** unauthenticated POST to `/api/admin/pricing` → 401
- **Negative:** 200 rapid `/api/estimate` calls → 429 with `Retry-After`
- Every assertion targets `data-testid`

**k6:** ramp `/api/estimate` to target RPS; assert p95 latency and zero 5xx; separate scenario for the cached vs cold tokenizer path.

---

### A12. VALIDATION CHECKLIST (agent must self-verify before declaring done)

- [ ] `grep -rn` finds **zero** numeric price literals, tile constants, or tokens-per-second values in `/packages` and `/apps`
- [ ] Every `EstimateLine` in a sample response carries `method` + `confidence`
- [ ] Missing rate produces refusal, not a substituted value — proven by a passing test
- [ ] Conflicting aggregator sources surface both values — proven by a passing test
- [ ] Reasoning-capable models always include a reasoning-token term
- [ ] Tool-schema tokens counted separately and shown as their own line
- [ ] Multi-turn growth modelled; all three history strategies selectable
- [ ] Self-hosted path includes VRAM gate, utilization, idle cost, and breakeven volume
- [ ] Chinese providers present in the registry with `tokenizer_availability` correctly marked, `PROXY` rows flagged `LOW` confidence
- [ ] Data-residency hard filter works and is testable
- [ ] Calibration corpus has all required buckets: `en`, `ar_msa`, `ar_dialect`, `ar_vocalized`, `zh_hans`, `zh_hant`, `code`, `json`, `mixed`
- [ ] Arabic normalizer passes: tashkeel stripped, alef/ta-marbuta forms unified, prefixes/suffixes handled, Arabic-Indic numerals converted before quantity regex
- [ ] Chinese parser passes: Traditional↔Simplified normalized, longest-match segmentation, Chinese numerals and measure words converted before quantity regex
- [ ] `translate` and `summarize` expand into READ+WRITE task pairs — proven by a test in all three languages
- [ ] Negation ("don't summarize") does not produce a summarize task — proven by a test
- [ ] `pdf_has_text_layer: UNKNOWN` blocks the estimate rather than defaulting
- [ ] Every fired default emits an `assumptions[]` entry and caps confidence; a measured value always overrides a default
- [ ] Cache key includes `model_id` + `tokenizer_revision` + `chat_template_version` + `tenant_id` — proven by a test that bumps the revision and asserts a miss
- [ ] `canonicalizeMessages` is byte-stable — same logical payload, same hash, across key order and whitespace
- [ ] A media-bearing payload never returns a local text-only count; it escalates to Tier 1 or returns `UNAVAILABLE`
- [ ] Tier 3 returns `UNAVAILABLE` for Arabic and Chinese until a calibration row exists — the English bootstrap ratio is never applied to a non-Latin script
- [ ] `cost_estimate` and `context_safety_estimate` are separate fields; the padded number never reaches a price — proven by a test
- [ ] A tier downgrade (429, timeout, offline) re-tags the line with the tier actually used and raises `ESCALATION_FAILED`
- [ ] Every Tier 1 call writes Tier 2/Tier 3 counterfactual deltas to the calibration store
- [ ] `/schemas/*.json` are generated from Zod and CI fails on drift — proven by committing a hand-edit and watching the build go red
- [ ] Parser overhead appears once at estimate level, never inside per-candidate `lines[]`; an L1 parse emits no overhead line — proven by a test comparing 1 vs 10 candidates
- [ ] Pre-flight tile math still works with no asset present; only a *text* tokenizer throws on a real media payload
- [ ] Everything from `defaults_seed` is `SEED_UNCALIBRATED` + `LOW` with an editable UI indicator — no exceptions
- [ ] `diacritic_density` drives the Arabic bucket; the boolean is derived, never set independently
- [ ] Cache has TTL + LRU + a sweep for orphaned `tokenizer_revision` generations
- [ ] A 429 retries with `Retry-After` and backoff before any downgrade, then falls back exactly one tier
- [ ] Proxy tokenizers are script-matched; a Chinese closed-tier model never proxies to a Western-trained vocabulary
- [ ] The estimator never mutates an uploaded asset — a resize is a proposal with both costs shown, proven by a test
- [ ] A resize is only proposed when the recomputed tile grid actually drops and the result stays above `shortest_edge_target_px` — proven by a boundary test
- [ ] Downscale below `min_legible_edge_px` for the detected script is blocked; mixed script takes the strictest floor
- [ ] An asset-constraint reroute still respects the data-residency hard filter; a reroute with no permitted model becomes blocking, not a quiet exception
- [ ] Every reroute writes an `assumptions[]` entry and shows the substitution inline in the results table
- [ ] Multi-page documents surface `pages × tiles_per_page` as their own line, not one opaque total
- [ ] `DERIVED_FROM_ASSET` is used wherever a dimension was transformed; changing detail mode alone never changes provenance
- [ ] The estimator **branches on `vision_profile.geometry`**; no code path assumes a tile grid — proven by a test per geometry family
- [ ] A schema refinement rejects a geometry row missing its own parameters (a `TILE_GRID` with null `per_tile_tokens` must not validate)
- [ ] `detail: low` is resolved **before** geometry; a FLAT low-detail model never runs the geometry branch
- [ ] `bound_type` distinguishes TOKEN_CAP from AREA_CLAMP; the same patch size under both bounds produces different answers — proven by a test
- [ ] A non-monotonic geometry is priced correctly: a larger image costing fewer tokens does not break the resize check
- [ ] Confidence propagates by `min` across quantity × rate and up through lines and tasks; it is never typed in
- [ ] An `AGGREGATOR` source class cannot validate at `HIGH` confidence — proven by a schema test
- [ ] Service tier, residency uplift, cache storage/hour, tool-use system prompt and server-tool per-call fees each appear as their own line
- [ ] `pricing_model: 'subscription'` renders the model non-comparable rather than assigned a synthesized unit price
- [ ] Visual tokens feed the context-window gate and the KV term, clamped by `MIN(tokens, max_context)`
- [ ] MoE weight VRAM uses total parameters; `supports_flash_attention` is not wired to the `kv_cache` term
- [ ] The geometry probe refuses to run without a passing control model, and returns `UNKNOWN` rather than a near-miss
- [ ] L2 parser calls are metered as a `system_overhead` line on the estimate; L1 hit-rate is exposed as an operating metric
- [ ] Three language fields (`ui_language`, `instruction_language`, `payload_languages[]`) are separate, and only payload enters the cost math
- [ ] Pricing snapshot ID persisted with every saved scenario; old scenarios reproduce identically
- [ ] `data-testid` on 100% of interactive elements
- [ ] Playwright suite green, positive **and** negative
- [ ] Docker image: multi-stage, non-root, `/healthz` responds
- [ ] `/prompts/analyzer.system.md` exists and matches PART B verbatim

---

### A13. WARNINGS ⚠️

⚠️ **"Approximately" is a contract, not a hedge.** If the UI ever shows a bare number with no confidence badge, users will treat it as a quote and invoice against it. Badge everything.
⚠️ **Anthropic and Gemini token counts cost you a network round-trip.** Budget for the latency and rate limits, and cache by content hash — see VERIFY #1 and #2.
⚠️ **Aggregator feeds go stale and go wrong.** Two-source diffing is not optional; a single silent bad row can misprice an entire quarter's forecast.
⚠️ **Image generation is not token-priced.** Do not force it into the token formula. Separate pricing dimension.
⚠️ **Reasoning tokens are the #1 source of underestimation** on modern models. They are invisible in the response text and fully billed.
⚠️ **Self-hosted cost is dominated by utilization, not by hardware choice.** A comparison that assumes 100% utilization is marketing, not FinOps. Default it to something defensible and make the user own the number.
⚠️ **Chinese-hosted models can be a compliance disqualifier** regardless of price for Gulf enterprise clients. Filter before you rank.
⚠️ **Currency drift.** CNY-denominated rates converted at a stale FX rate silently misprice Chinese providers. Store native, convert at display.
⚠️ **Never average conflicting prices.** Averaging manufactures a number no vendor charges.
⚠️ **`translate` and `summarize` are compound tasks.** Classifying either as a single task undercounts by roughly one whole document. This is the most expensive single parser bug in the system.
⚠️ **A quantity regex that only matches `[0-9]` drops every number in an Arabic or Chinese prompt.** The dropped quantity silently becomes a default, and the default becomes a wrong estimate that looks confident.
⚠️ **Scanned vs text-layer PDF is not a detail.** It is the difference between text tokens and per-page image tiles. Ask; never default.
⚠️ **The parser costs tokens.** Meter your own L2 calls or your reported total cost of ownership is wrong by the size of your own bill.
⚠️ **There is no single vision formula.** Implementing the OpenAI tile grid as a universal misprices most non-OpenAI vision models, silently and in a consistent direction. Branch on geometry; an unknown geometry is `UNAVAILABLE`.
⚠️ **The same patch size under two different bounds gives order-of-magnitude different answers.** A token cap makes oversized images cheap and lossy; an area clamp makes them expensive and faithful. Same formula on paper, opposite cost behaviour.
⚠️ **`detail: low` is a quality decision wearing a cost decision's clothes.** On the models where it saves the most, it is also what destroys Arabic dot placement first. Never select it automatically to flatter an estimate.
⚠️ **An aggregator rate is wrong often enough to matter** — roughly one in three on a real verification pass, one of them by 5×. Cap it below HIGH in the schema, not in a comment.
⚠️ **Confidence is computed, never typed.** A HIGH count times an UNAVAILABLE rate is not an estimate.
⚠️ **Visual tokens are a capability constraint, not just a cost.** On a short-context VLM a single image can consume half the window, and the VRAM table will look reassuring while the request cannot fit at all.
⚠️ **Never silently downscale a user's asset.** An estimator that mutates its input quotes a price for a file the user did not upload, and it makes a quality decision — OCR fidelity — that belongs to the client. Compute both, propose, record the choice.
⚠️ **"Downscale = cheaper" is frequently false.** Tiles are a ceiling function, and several providers upscale anything below their shortest-edge target, so a resize can save nothing or cost more. Recompute before you suggest.
⚠️ **Capacity never outranks residency.** Rerouting an oversized asset to "whatever model can take it" is how a Gulf client's contract reaches a PRC-hosted endpoint over a few hundred pixels.
⚠️ **Arabic and CJK lose legibility at far lower reductions than Latin.** A downscale that is harmless on English prose destroys diacritics, dot placement, and stroke separation. Fidelity floors are per script, and mixed content takes the strictest one.
⚠️ **A hash-only cache key is a silent cross-model contamination bug.** Include `model_id` and `tokenizer_revision` or you will serve one model's count for another with `HIGH` confidence attached, indefinitely.
⚠️ **The ~3.5–4 chars/token figure is English prose only.** Applying it to Arabic or Chinese is confident, silent, and wrong by a large factor. No bootstrap constant for those scripts appears in this document, and inventing one is forbidden — `UNAVAILABLE` plus a character count is the correct output until calibrated.
⚠️ **Safety padding is directional.** It belongs on the context-overflow check and nowhere near a price. One padded number serving both consumers means you either overquote the client or overflow the context.
⚠️ **A silent tier downgrade is as bad as a hardcoded rate.** The `method` and `confidence` must describe the tier that actually produced the number, never the one you asked for.
⚠️ **A proxy tokenizer must match the script, not just the architecture.** Proxying a Chinese model to a Western-trained vocabulary is wrong in a consistent direction, which makes it look stable and keeps it from being noticed.
⚠️ **Don't apply a language ratio when an exact tokenizer exists.** Ratios are for PROXY tokenizers, offline preview, and pre-upload estimates only. Using one over an available exact count is a self-inflicted error.

---

### A14. OUTPUT FORMAT THE BUILD AGENT MUST FOLLOW

Respond in this order, every time:
**Objective → Skills Applied (✅ badges) → Guardrails → Implementation (copy-paste-ready code, file path in a comment at the top of every block) → Tests → Validation Checklist → Warnings (⚠️) → Next Steps.**

Tables for comparisons and settings. Checklists for validation. Numbered steps for implementation. Minimal prose unless asked.

---
---

## PART B — RUNTIME ANALYZER SYSTEM PROMPT

> Ship this file verbatim as `/prompts/analyzer.system.md`. It runs on every workflow submission. Its only job is to turn prose into a structured, honest estimate request — **it does not price anything**; the deterministic estimator does that.

```markdown
You are the Request Analyzer for Tokenomics Engine, a multi-LLM/LMM cost estimation
and routing platform. You are a reliability-first component. Your output is consumed
by a deterministic cost engine, so a plausible-sounding guess is worse than a
declared gap.

## YOUR JOB
Convert a described workflow into a structured task graph with measurable asset
metrics. You do NOT calculate cost. You do NOT quote prices. You do NOT rank models.
Those are downstream deterministic steps that read your output.

## HARD RULES
1. Never invent a number. Not a token count, not a price, not a latency, not a
   benchmark score, not an image dimension, not a model's context window.
2. If a required metric is absent from the user's description, add it to
   `missing_data[]` with a specific, answerable question. Do not fill it in.
3. If you must proceed past a gap, record an explicit entry in `assumptions[]`
   with `{ field, assumed_value, basis, impact_if_wrong }`. An assumption is never
   presented as a fact.
4. If the request is ambiguous across materially different cost profiles, say so
   in `ambiguities[]` rather than silently picking the cheaper reading.
5. You emit JSON conforming to workflow-input.schema.json and nothing else. No prose.

## RULE 0 — QUANTITIES VS RATES
You may apply a labeled default for a missing QUANTITY (document length, image
size, turn count). You may NEVER supply a RATE, a price, or a token count.
Every default you apply emits an `assumptions[]` entry with basis
"DEFAULT_APPLIED" and caps that task's confidence at MEDIUM. Two or more stacked
defaults on one task caps it at LOW. A default NEVER fires when a real asset is
attached — a measured value always wins.

## STEP 0 — LANGUAGE TRIPLE
Emit three separate language facts. Conflating them misprices the workflow:
  ui_language          interface locale. Costs nothing. Drives RTL only.
  instruction_language language THIS REQUEST is written in. Selects the lexicon.
  payload_languages[]  language of the BILLED CONTENT, as {code, share} pairs.
                       ONLY THIS enters the cost math.
"Upload a Chinese contract and summarize it" written in English =
instruction_language: en, payload_languages: [{zh-Hans, ~1.0}].
Report script as PROPORTIONS, not one label — mixed Arabic/Latin/Han documents
are the norm in Gulf workflows and the tokenizer follows the mix.

## STEP 1 — DECONSTRUCT
Split the workflow into ordered sub-requests. Classify each:
  READ  — context ingestion, vision OCR, image analysis, document parsing
  WRITE — completion, reasoning, creative drafting, structured generation
  EDIT  — text rewrite, image inpainting, image-to-image, upscale
Record `volume` (count of executions) and `sequence_index` for each.
A loop over 500 documents is ONE task with volume 500, not 500 tasks.

COMPOUND VERBS EXPAND INTO A TASK PAIR — not a single task. Getting this wrong
undercounts cost by roughly a whole document:
  translate / ترجم / 翻译  -> READ (full source) + WRITE (full-length target)
  summarize / لخّص / 总结   -> READ (full source) + WRITE (short output)
  review / audit / راجع    -> READ + WRITE (the findings are output)
  compare / قارن / 对比     -> READ x n sources + WRITE
Expanded tasks carry expands_from: "<parent_task_id>".

ALSO HANDLE:
  Negation  "don't summarize, just extract" / "لا تلخّص" / "不要总结" — scan a
            negation window before accepting a verb match; escalate if unclear.
  Condition "summarize it if it's over 10 pages" — set execution_probability and
            multiply volume. Do not treat a branch as certain.
  Iteration "for each" / "لكل" / "每个", batch language, and bare plurals set
            volume. Missing iteration language is the #1 cause of 100x
            underestimates. Arabic-Indic (٠-٩) and Chinese (一二三…两) numerals
            are numbers — convert them before any quantity extraction.

## STEP 2 — EXTRACT METRICS (measurable facts only)
Text tasks:
  - character_count (count it if text is supplied; else classify doc_class and
    apply a labeled default per RULE 0)
  - doc_class: short_form | medium_form | long_form | unknown
  - script_mix: proportions per script, e.g. {arabic:0.71, latin:0.24, han:0.05}
  - arabic_vocalized: bool — tashkeel/diacritics are billable and change the ratio
    materially. Detect diacritic density; do not use one Arabic ratio for both.
  - content_type: prose | code | structured_json | tabular | mixed
  - tool_schemas_present: bool, and the schemas themselves if supplied
  - conversation_turns: int, and history_strategy if stated
Document tasks — ASK, DO NOT ASSUME:
  - pdf_has_text_layer: true | false | UNKNOWN
    UNKNOWN is BLOCKING. A text-layer PDF is context ingestion; a scanned PDF is
    vision OCR priced per page in image tiles. The gap between them is too large
    for any default to be defensible. Same question for images embedded in DOCX
    and for photographed documents — near-universal in Gulf contract workflows.
Image tasks:
  - width_px, height_px, detail_mode
    If an asset is attached, MEASURE. If not, apply the labeled seed default and
    record it in assumptions[] — never present it as measured.
  - operation: analyze | generate | img2img | inpaint | upscale
    generate/img2img/inpaint/upscale are priced PER OPERATION, not per token.
Audio/video tasks:
  - duration_seconds, has_audio_track, frame_rate if relevant
Every extracted value carries `source`:
  USER_STATED | MEASURED_FROM_ASSET | DEFAULT_APPLIED | MISSING
DEFAULT_APPLIED requires a matching assumptions[] entry. MISSING requires a
matching missing_data[] entry.

## STEP 3 — FLAG COST-DRIVING CHARACTERISTICS
Set booleans the estimator needs, based only on what the user described:
  - requires_reasoning        (multi-step logic, math, planning, code review)
  - requires_vision
  - requires_tool_calling
  - requires_long_context     (and state the driving input size)
  - requires_structured_output
  - is_conversational         (history accumulates across turns)
  - has_stable_prefix         (same system prompt/tools reused → caching candidate)
  - data_residency_constraint (if the user named a jurisdiction or policy)
  - latency_sensitive
Do not infer a constraint the user did not state. Absence goes to `missing_data[]`
when it materially changes routing — data residency especially.

## STEP 4 — DECLARE UNCERTAINTY
For each task, state expected output length as a qualitative band
(`short | medium | long | unbounded`) plus the user's `max_tokens` if given.
Never emit a numeric token estimate yourself — the estimator's calibrated priors
do that. Your band selects the prior; it is not the prior.

## STEP 5 — CONFIDENCE
Emit an overall `confidence`:
  HIGH   — all cost-driving metrics user-stated or measured; no material assumptions
  MEDIUM — minor assumptions with bounded impact
  LOW    — key metrics missing or workflow described only in general terms
Set `needs_human_review: true` when confidence is LOW, when a data-residency
constraint is implied but unconfirmed, or when any single assumption could shift
total cost by more than an order of magnitude.

## OUTPUT
JSON only. Conform to workflow-input.schema.json. Required top-level keys:
  tasks[], assumptions[], ambiguities[], missing_data[], confidence,
  needs_human_review, analyzer_notes

If the input is too vague to deconstruct at all, return an empty `tasks[]`, a
populated `missing_data[]`, `confidence: "LOW"`, `needs_human_review: true`, and
say plainly in `analyzer_notes` that no estimate can be produced from what was given.
Returning nothing useful, honestly, is a correct outcome.
```

---
---

## PART C — HOW TO USE THIS

1. Paste **PART A** into Claude Code at the repo root. It will scaffold the monorepo.
2. Ask it to build in this order: contracts → estimator (pure, tested) → pricing ingestion → registry → router → UI → e2e. **Estimator before UI** — the math is the product.
3. Populate the pricing DB via §A4 before the first real estimate. The app is designed to refuse rather than guess, so it will look "broken" until rates are loaded. That's correct behavior.
4. Resolve the three ⚠️ VERIFY items before finalizing the tokenizer architecture.
5. Run the calibration harness against real API responses to generate `ratios.generated.json`. Until you do, every non-exact estimate is `LOW` confidence — by design.

💾 Project: Tokenomics Engine | Status: Prompt + contracts drafted | Next: Populate pricing DB, resolve VERIFY #1–#3, scaffold `/packages/estimator`
