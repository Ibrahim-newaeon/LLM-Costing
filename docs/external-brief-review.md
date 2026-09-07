# Review — "Multi-Model Token Counter Verification" (external Gemini transcript)

Reviewed 2026-09-07 against `1bb44f6`. The document is a Gemini conversation
(`gemini.google.com/app/818774a462782097`) supplied as a markdown export. It ends by producing
two files that present themselves as successors to this repo's spec: **MASTER BUILD PROMPT
v1.1** and **ULTIMATE MASTER BUILD PROMPT v2.0**.

**Verdict: it is a compression of `SPEC.md`, not an update to it.** `SPEC.md` is 1,242 lines;
v2.0 is roughly 200. The philosophy survives the compression intact. The enforcement does not —
and the parts that fell out are, with near-perfect selectivity, the parts this repo has already
built or already argued about.

Do not adopt either version as canonical, and do not merge it with `SPEC.md`. A second pass
(§9, correction) found **no net-new material** in it at all.

---

## 1. It copies the stale enums, not the contracts

v1.1 and v2.0 both state, in §A3.3:

> `method` ∈ `EXACT_TOKENIZER | PROVIDER_COUNT_API | CALIBRATED_HEURISTIC | USER_SUPPLIED | UNAVAILABLE`
> and a `confidence` ∈ `HIGH | MEDIUM | LOW`

`packages/contracts/src/provenance.ts` defines **11 methods and 4 confidences**. Missing from the
document: `PROVIDER_FORMULA`, `MEASURED_PROBE`, `MEASURED_BENCHMARK`, `TOKENIZER_SCALED`,
`EXACT_PROXY`, `DERIVED`, and `NONE`.

That five-value list is not the document's invention — it is `SPEC.md:91`, which is README open
queue item 2, a *known* drift site awaiting correction. The document read the prose, not the
Zod, and has now minted two more copies of the defect. This is the failure mode the project
prohibits by name: never restate a contract shape in prose.

## 2. The two rules that are actually enforced in code are the two it dropped

`SPEC.md` §A3 carries eight non-negotiable rules. The document carries six. Absent:

| Dropped | What it is | Where it lives in code |
|---|---|---|
| §A3.7 | Confidence propagates by minimum, never by assertion | `minConfidence()`, `provenance.ts` |
| §A3.8 | Source class caps confidence, structurally | the `AGGREGATOR ≠ HIGH` refinement |

`SourceClass` does not appear anywhere in the document. Neither does the empirical basis for
§A3.8 (roughly one aggregator rate in three wrong on one verification pass, one off by 5×).
Six of the eight rules are aspirational statements; the two that were dropped are the two that
this repo has made *unrepresentable to violate*.

## 3. RULE 0 is missing from the analyzer prompt

The document ships a replacement for `prompts/analyzer.system.md`. Compared with the real one:

- **`RULE 0 — QUANTITIES VS RATES` is gone entirely.** That is project rule 2. It carries the
  default-caps-confidence-at-MEDIUM ladder, the two-stacked-defaults-caps-at-LOW rule, and
  "a default NEVER fires when a real asset is attached."
- HARD RULES: 4 items instead of 5 — `ambiguities[]` ("rather than silently picking the cheaper
  reading") dropped, though the schema still requires the key.
- STEP 3 (cost-driving flags) and STEP 4 (output band, *"never emit a numeric token estimate
  yourself"*) collapsed into one confidence step.
- The closing instruction — return empty `tasks[]`, `LOW`, `needs_human_review` and say plainly
  no estimate is possible, because *"returning nothing useful, honestly, is a correct outcome"* —
  is gone.

`docs/drift-sweep.md` records `prompts/analyzer.system.md` as the one downstream surface with
**0 drift sites**. Replacing it with this version would end that.

## 4. It re-proposes a rule §A4.5.2 already narrowed

The document's "update these files" pass recommends:

> any task containing `imageMetrics` or `mediaMetrics` **must** bypass local exact/proxy
> tokenizers and route directly to Tier 1. Local tokenizers must throw a hard validation error
> if invoked on media payloads.

`SPEC.md` §A4.5.2 flags exactly this wording as **too broad**: Tier 1 needs a real payload, and
the §A5.2 pre-flight calculator exists to price an image *before upload* from declared
dimensions, when there is nothing to send anywhere. A blanket hard-throw deletes that feature.
The invariant is *no silent partial counting*, expressed as a four-row disposition table.

## 5. The vision constants are sourced to calculator sites

The document supplies concrete geometry — `85 + 170 × tiles`, `⌈(w×h)/750⌉`, `258` per
768² tile, the 384px flat case, 2048² and 1568px bounds, "3.5 to 4 characters per token",
"+15% safety padding" — cited to `spoold.com`, a Heroku-hosted calculator, and `calcxi.com`.

Under this repo's vocabulary those are `AGGREGATOR`, which `provenance.ts` structurally caps
below HIGH, and under rule 1 a tile constant or resolution limit does not enter source at all
without `source_url` + `verified_at` from the vendor's own domain.

**And one of them conflicts with what is already implemented here.** Reported, not merged:

| Source | Claude vision geometry |
|---|---|
| The document | scale long edge ≤ 1568 px, then `⌈(w × h) / 750⌉` |
| `prototype/src/lib/images.js:36` | 28 px patch grid, `⌈w/28⌉ × ⌈h/28⌉`, binary-searched down to a 1568-token cap (standard tier) |

28² = 784, not 750, and 1568 is a *pixel* bound in one and a *token* bound in the other. Neither
has been checked against an Anthropic page in this repo. This needs a vendor-page verification,
not a choice.

## 6. Three claims that are not true of this repo

1. **"All three ⚠️ VERIFY items are fully resolved and built into the core architecture."**
   Resolved, yes — `docs/verify-resolution.md`, 2026-09-07, primary sources with retrieval dates.
   *Built in*, no: there is no `packages/tokenizers`. `packages/contracts` is the only first-party
   code and nothing consumes it. The resolutions have also not yet been pasted into §A4.1
   (README queue item 4).
2. **The wireframe's numbers are fabricated** — `$0.0428`, 10,706 input tokens, `gpt-4o-mini`
   at 412/128, `~5,356` for four images. Fine as an illustration inside a chat; they are exactly
   the shape of number this engine exists to refuse, and must not travel into a spec unlabelled.
3. **The schema it analysed is one of the three orphans.** The JSON pasted into the conversation
   is `schemas/workflow-input.schema.json` verbatim (same `$id`, `required`, `$defs`). It has no
   Zod behind it, the generator emits four *different* files, and its `confidence` enum is missing
   `NONE` (`drift-sweep.md` §5a). Every UI stage the document derives from it therefore sits on
   the un-gated side of the split — and per §5c, regenerating it before the assumption axis lands
   would delete `Assumption`, `impact_if_wrong`, `sensitivity_rank`, `impact` and
   `deployment_mode`.

## 7. Where the repo's own research is stronger

| Topic | The document | `docs/verify-resolution.md` |
|---|---|---|
| Anthropic `count_tokens` | tradeoff is "network latency", mitigate by caching | counting is **free**, and rate-limited on its own bucket (5k/10k/20k RPM by tier). You cache for the RPM ceiling, not for dollars — and you need per-run dedupe in front of the cache |
| Gemini local path | "available via Hugging Face-compatible models for pure text" | it is `google.genai.local_tokenizer`, documented for **Python** (plus a Go package). No JS/TS local tokenizer is evidenced — in this TS codebase it costs a sidecar runtime |
| ERNIE / Hunyuan | vendors "may not publish exact matching tokenizer files" | both **do** publish open-weight tokenizer artifacts. PROXY/LOW still stands, but the proxy is a *named repository* recorded as `source_url`, not a hand-wave |

Two further findings have no counterpart in the document at all:

- **Every Tier 1 call is a free calibration sample** (§A4.5.2) — compute what Tiers 2 and 3
  would have said and store the deltas. Retrofitting it throws away every sample already paid for.
- **The ladder should read remote-first with a local fast path.** Two of the three VERIFY items
  resolve to remote-only. The document's recommended flow ("if offline or rendering a real-time
  counter, rely on the local tokenizer... invoke the remote API only when approaching limits")
  describes the minority case as the default. Offline is a different method at a different
  confidence, not a degraded version of the same answer.

## 8. The Reference / costing tab request

The final exchange specifies five tables for a `ReferenceTab`. That component already exists —
`prototype/src/App.jsx:1698` — and the five tables are close to what it already renders
(`LEGEND` at :1654, `FORMULAS` at :1665).

Two things to know before building it:

- Its `FORMULAS` entries carry `source: 'src/lib/images.js → claudeVisionTokens'`. The request
  asks for "each with its **source file**". A file path is provenance of *location*, not of
  *fact*; this repo requires `source_url` + `verified_at`. Same for the `×1.30` factor
  (`models.js:330`, `CLAUDE_TOKENIZER_MULTIPLIER = 1.3`), described in-app as
  "provider-published ~1.30×" with no URL anywhere in the repo.
- The published page it would replace, `reference/tokenomics-reference.html`, is the stalest
  artifact here: `Method` at 4 of 11, `Confidence` at 3 of 4 (`drift-sweep.md` §6). And per
  `prototype-salvage.md` §3 the rate manifest behind these tables contains unverified ids
  (`gpt-6-astra`, `claude-fable-5`, `claude-opus-4.8`). It is a verification worklist, not data.

Notably, the prototype's own `LEGEND` uses the **11-method vocabulary** — richer and more correct
than the five-value list the document canonised in §1.

## 9. What genuinely holds up

Worth harvesting, all consistent with `SPEC.md`:

- The Tier 0→3 ladder with a declared method tag per tier, and Tier 0 inheriting its cache entry's tier.
- Composite cache key: `sha256(canonical) : model_id : tokenizer_revision : chat_template_version : tenant_id`.
- Directional safety padding — pad the context-window check, never the price. Stated cleanly.
- 429 → fall back **and re-tag** to the tier actually used, so a fallback cannot masquerade as ground truth.
- Refuse rather than substitute; conflicts surfaced rather than averaged; P50/P90.
- Arabic-Indic and Chinese numeral conversion *before* volume regexes; vocalized Arabic as its own
  calibration bucket; `script_mix` as proportions rather than one label.
- Compound-verb expansion with `expands_from`; `pdf_has_text_layer: UNKNOWN` as blocking.
- `parse_meta` metered as `system_overhead` — the L2 parse is itself a billable call.
### Correction, 2026-09-07 (second pass)

An earlier version of this section listed the document's oversize-asset fallback routing as
**new and worth keeping**. That was wrong, and the recommendation is withdrawn.

`SPEC.md` §A5.2.1 already carries a **seven-rung disposition ladder** for exactly this case, and
it is stricter than the document on every rung the document touches:

| The document proposes | §A5.2.1 |
|---|---|
| "Automatic client-side pre-flight downscaling ... scale down the asset locally in memory using `sharp` or `canvas` before it reaches the payload stage" | ⚠️ block, verbatim on that phrasing: right for a production request path, **wrong here**. "This is an estimator, not an execution pipeline. It must not mutate the user's asset." Resolution is a quality decision, not a cost decision. Compute both, propose, record the choice |
| "Dynamic tile budget recalculation" | rungs 3–5, plus the rule the document lacks: **a resize is proposed only if the recomputed grid is actually smaller** and stays above `shortest_edge_target_px`. Tiles are a ceiling function, and several providers *upscale* below that target, so shrinking can raise the count |
| "Reroute to a more permissive alternative model (such as ... Gemini Flash)" | rung 6 — and ⚠️ **rerouting never overrides the data-residency hard filter.** "Send the oversized document to whichever model has the largest capacity" is named in the spec as how a KSA client's contract reaches a PRC-hosted endpoint over a few hundred pixels |
| "Transition task confidence down to LOW" | rung 7 — `missing_data[]` + `needs_human_review`, **no number**. Not a lowered confidence |

Also absent from the document: the script-aware fidelity floors (`min_legible_edge_px` per
`(script, content_density)`, strictest floor when the script is mixed) — the rung that protects
Arabic dot placement and the ي/ى distinction, which is this app's actual workload.

**So the net-new content in the external brief is zero.** Every idea in it is either already in
`SPEC.md` in a stricter form, a stale copy of `SPEC.md`, or contradicted by it.

Note that §A1 (skills), §A2 (stack), and the monorepo layout are reproduced from `SPEC.md`
essentially verbatim; they are not new material and carry no new decisions.

---

## Recommended disposition

1. **Do not** replace `SPEC.md` or `prompts/analyzer.system.md`. Both v1.1 and v2.0 are lossy.
2. Harvest nothing. The second pass found no net-new material — see the correction in §9.
   Two of the document's four fallback options are prohibited by §A5.2.1 as written.
3. Add the Claude vision-geometry conflict (§5) to the verification queue — it needs an
   Anthropic page, a URL and a date, not an adjudication.
4. The `×1.30` factor needs the same treatment before the reference tab ships, or it renders as
   `TOKENIZER_SCALED` / MEDIUM with `source_url: null`, which `Provenance` will reject.
5. §1 is one more argument for README queue item 1: while the enums live only in prose, every
   external tool that reads the prose will keep manufacturing stale copies.
