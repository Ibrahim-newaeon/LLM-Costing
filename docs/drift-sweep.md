# Prose ↔ contracts drift sweep

Ran 2026-09-07 against `@tokenomics/contracts` as the canonical source. Scanned
`TOKENOMICS_MEGA_PROMPT_PART_A.md` and `LLM_COST_ENGINE_PROMPT.md`.

`MIGRATION.md` hunted duplicate **Zod** definitions. This sweep looks for the same defect in
**prose** — sentences that restate a contract shape and have since fallen behind it. Nothing in
CI can see these: `check:schemas` guards generated JSON against Zod, and guards nothing else.

---

## Clean

**Zero Zod blocks in either document.** The A15 §11 deletion landed. The worst category of
duplication is gone.

---

## The structural finding — read this first

Every drift site below appears in **both** documents, at a constant offset of six lines.

The README says Part A "is generated from" the engine document. There is no generator: the only
script in the repo is `generate-schemas.ts`. The constant offset is what copy-paste looks like,
not what generation looks like.

So the repo has **two documents that must agree, no generator, and no gate** — the same defect
`MIGRATION.md` was written to eliminate, one level up. Fixing line 97 in Part A leaves line 91
of the engine document stale, and nothing will say so.

Two ways out, both cheap:

1. **Make it real.** Part A is a mechanical slice of the engine document (§A0 → §A14). Write
   the extractor, add `--check`, run it in CI beside `check:schemas`. Same pattern, same gate.
2. **Delete Part A.** Generate it on demand when someone needs the paste. One document, nothing
   to drift.

Until one of those lands, every fix below must be applied twice, by hand.

---

## Real drift

### 1. §A3 — `Method` and `Confidence` restated, both stale
`PART_A:97` · `ENGINE:91`

> Each `EstimateLine` carries `method ∈ EXACT_TOKENIZER | PROVIDER_COUNT_API |
> CALIBRATED_HEURISTIC | USER_SUPPLIED | UNAVAILABLE` and a `confidence ∈ HIGH | MEDIUM | LOW`.

Contracts: `Method` has **11** values, `Confidence` has **4**.

Missing from the prose: `PROVIDER_FORMULA`, `TOKENIZER_SCALED`, `EXACT_PROXY`, `DERIVED`,
`MEASURED_BENCHMARK`, `MEASURED_PROBE` — and `NONE`.

`NONE` is the one that bites. `blocksEstimate(c) === 'NONE'` **is** the refusal mechanism, so
the section that states "every number is traceable" currently describes a confidence scale with
no way to express *there is no number*. `MEASURED_PROBE` matters too: it exists so a measured
constant is distinguishable from a documented one, and the non-negotiables section doesn't
mention it.

**Fix:** replace both inline enums with a pointer to `@tokenomics/contracts`, exactly as A15 §11
was replaced.

### 2. §A3.8 — `SourceClass` restated, missing the two newest members
`PART_A:108` · `ENGINE:102`

> Every rate carries `source_class ∈ VENDOR_PAGE | VENDOR_DOCS | AGGREGATOR | USER_ENTERED`

`MIGRATION.md` records the enum being extended with **`VENDOR_CONFIG`** (model cards — "a
different reliability class from a pricing page") and **`MEASURED`** (this repo's own harnesses).
Neither appears here.

This is not cosmetic. `confidenceCeiling()` caps confidence *by source class*. An implementer
reading only this line does not know a ceiling applies to a model-card figure or to the repo's
own measurements, and will seed them uncapped.

**Fix:** pointer, as above.

### 3. §A7 — image pricing dimensions, and a sentence the contracts now contradict
`PART_A:909` · `ENGINE:903`

> These are priced per-operation or per-megapixel by most providers, **not** per token — so the
> image-generation cost model is a separate pricing dimension (`per_image`, `per_megapixel`,
> `per_step`), not a token formula.

`ImagePricingDimension` has a fourth member, **`per_output_token`**, which `MIGRATION.md` lists
as a §A7 addition alongside `output_tokens_by_resolution[]`.

The prose does not merely omit it — it asserts the opposite ("**not** per token"). The contract
was extended *because* some image models bill output tokens. Whichever is right, they cannot
both stand.

**Fix:** name the fourth dimension and soften the claim to "most providers", which is what the
contract shape now assumes.

### 4. §A14 checklist — calibration buckets don't map to any enum
`PART_A:1000` · `ENGINE:994`

> Calibration corpus has all required buckets: `en`, `ar_msa`, `ar_dialect`, `ar_vocalized`,
> `zh_hans`, `zh_hant`, `code`, `json`, `mixed`

`Script` is `latin | ar_msa | ar_dialect | ar_vocalized | zh_hans | zh_hant | mixed`.

Two mismatches: the checklist says **`en`** where the contract says **`latin`**, and it adds
**`code`** and **`json`**, which are not scripts and are not members of `Script`. §A4.5.3 keys
calibration on `(model, script, content_type)` — so the checklist is silently flattening two
dimensions into one list, under names that match neither.

**Fix:** rename `en` → `latin`, and split the content types out as their own axis, matching the
key §A4.5.3 already uses.

---

## Not drift — partial mentions in context, no change needed

| Site | Why it's fine |
|---|---|
| `PART_A:144`, `320` | Arabic/Chinese discussion; omitting `latin` and `mixed` is contextual |
| `PART_A:451` | Prose about seed confidence, not an enum listing |
| `PART_A:497` | A payload condition ("image / audio / video"), not a `Modality` restatement |
| `PART_A:847` | Discusses which service tiers carry multipliers; not a definition |

---

## Method

Canonical enums parsed from `provenance.ts`, `registry.ts`, `pricing.ts`, `vision.ts`. Every
line of both documents scanned for three or more members of any enum; each hit read by hand and
classified above. Threshold of three will miss a restatement of only two members — the sweep is
not exhaustive, and a listing split across several lines would also be missed.

## Not checked

`prompts/analyzer.system.md`, the three `/schemas/*.json`, and `reference/tokenomics-reference.html`
— the last of which is a published artifact and may carry its own copy of these enums.

---

# Sweep 2 — the three files not covered above

Same method, comments now stripped before parsing the contracts (the first pass mis-read
`Method` and `SourceClass` because their members carry trailing `//` comments).

**Correction to sweep 1:** `SourceClass` has **6** members, not 7 —
`VENDOR_PAGE | VENDOR_CONFIG | VENDOR_DOCS | AGGREGATOR | MEASURED | USER_ENTERED`. The finding
stands unchanged: §A3.8 lists four, omitting `VENDOR_CONFIG` and `MEASURED`.

## Clean

`prompts/analyzer.system.md` — **zero sites**. It refers to contract concepts without restating
their members, which is exactly right.

## 5. `/schemas/*.json` — stale enums, and shapes the contracts do not model

`MIGRATION.md` marks these three files "**Regenerate.** They are now build output, gated in CI."
That has not happened yet.

### 5a. Stale enums — real

| File | Line | Enum | Delta vs contracts |
|---|---|---|---|
| `estimate-output.schema.json` | 179 | `confidence` | `HIGH \| MEDIUM \| LOW` — missing `NONE` |
| `pricing-record.schema.json` | 124 | `confidence` | missing `NONE` |
| `workflow-input.schema.json` | 54 | `confidence` | missing `NONE` |
| `estimate-output.schema.json` | — | `method` | 6 of 11 — missing `PROVIDER_FORMULA`, `TOKENIZER_SCALED`, `EXACT_PROXY`, `DERIVED`, `MEASURED_PROBE` |

Ordinary staleness. Regeneration fixes all of it.

### 5b. CORRECTION — `ORDER_OF_MAGNITUDE` is not a confidence value

An earlier version of this section claimed the schemas carried an orphan `Confidence` member
called `ORDER_OF_MAGNITUDE`, and recommended resolving it before enabling the gate. **That was
wrong, and the recommendation is withdrawn.**

`ORDER_OF_MAGNITUDE` belongs to two *different* enums:

```jsonc
"impact":          ["COSMETIC", "MATERIAL", "ORDER_OF_MAGNITUDE"]        // workflow-input:31
"impact_if_wrong": ["LOW", "MEDIUM", "HIGH", "ORDER_OF_MAGNITUDE"]       // workflow-input:265,
                                                                          // estimate-output:326
```

It is a **severity scale on an assumption** — how far wrong the estimate goes if the assumption
is wrong — not a degree of confidence in a number. The scanner matched it against `Confidence`
because `LOW`/`MEDIUM`/`HIGH` overlap by three, which was enough to trip a threshold built for
finding stale lists. Nothing to decide; nothing at risk.

### 5c. The real finding — regeneration would delete concepts that have no contract

Checked against `packages/contracts/src`:

| Concept in `/schemas` | In contracts? |
|---|---|
| `assumption` object | **no** |
| `impact_if_wrong` (4-level severity) | **no** |
| `sensitivity_rank` ("1 = moves total cost most. Drives the tornado chart.") | **no** |
| `impact` (`COSMETIC \| MATERIAL \| ORDER_OF_MAGNITUDE`) | **no** |
| `deployment_mode` (`API_MANAGED \| SELF_HOSTED \| DEDICATED_CAPACITY`) | **no** |

These are real domain concepts, and two of them carry the product's own reasoning: the
assumption-severity scale is how §A4.4.4's "guess quantities, never guess rates" becomes visible
to a user, and `sensitivity_rank` drives the tornado chart.

The contracts package models **provenance** — where a number came from and how much to trust it.
It does not model **assumptions** — what was guessed, and how much the answer moves if the guess
is wrong. That is a second axis, and the schemas already have it while the Zod does not.

**So the ordering in `MIGRATION.md` needs one step inserted.** Before regenerating: add the
assumption axis to contracts, or those five concepts disappear the first time the generator
runs. The gate would be working exactly as designed while deleting the thing that makes an
estimate arguable.

Suggested shape, to sit alongside `Provenance`:

```ts
export const Impact = z.enum(['COSMETIC', 'MATERIAL', 'ORDER_OF_MAGNITUDE']);
export const ImpactIfWrong = z.enum(['LOW', 'MEDIUM', 'HIGH', 'ORDER_OF_MAGNITUDE']);

export const Assumption = z.object({
  id: z.string().optional(),
  task_id: z.string().nullable(),
  field: z.string(),
  value: z.unknown(),
  basis: z.string(),
  impact_if_wrong: ImpactIfWrong,
  user_editable: z.boolean(),
  sensitivity_rank: z.number().int().min(1).nullable(),
});
```

Reconcile the two impact scales while you are there — three levels in one place and four in
another, sharing a member, is the same two-definitions problem one level down.

### 5d. CORRECTIONS to 5c, 2026-09-07 — recorded after the layer was built

Two of §5c's recommendations were wrong. Both are withdrawn.

**1. Do not reconcile the two impact scales.** They are not two versions of one thing. Checked
against where each actually attaches:

| | attaches to | answers |
|---|---|---|
| `impact` — COSMETIC / MATERIAL / ORDER_OF_MAGNITUDE | `ambiguities[]` | the input admits more than one reading; how much does picking wrong cost? |
| `impact_if_wrong` — LOW / MEDIUM / HIGH / ORDER_OF_MAGNITUDE | `assumption` | the input was silent and we supplied a value; how far does the total move if it is wrong? |

They share `ORDER_OF_MAGNITUDE` and nothing else. An ambiguity is a question for the user; an
assumption is an answer we gave ourselves. One gets asked, the other gets rendered with an edit
control. Merging the scales merges those. `assumption.ts` keeps both, and four tests fail if a
later cleanup collapses them.

**2. The suggested Zod drops `seed_provenance`.** The sketch above uses `value` +
`sensitivity_rank`, which is the `estimate-output` shape. `workflow-input`'s shape also carried
`seed_provenance` (`SEED_UNCALIBRATED` | `CALIBRATED_FROM_OBSERVED` | `USER_SUPPLIED_BASELINE`),
and `SEED_UNCALIBRATED` is what forces LOW and carries the standing task to replace a baseline
from observed runs. Taking the sketch literally would have deleted the seed-calibration ladder
while closing a drift ticket. The shipped `Assumption` is the **superset**: keyed on `value`,
carrying both `seed_provenance` and `sensitivity_rank`.

**Status of the three files this section is about.** `workflow-input.schema.json` and
`estimate-output.schema.json` are now generated from Zod and gated. `pricing-record.schema.json`
was **deleted rather than regenerated**: its payload duplicated `TextRateProfile`, `ContextTier`,
`CacheProfile`, `VisionProfile` and `HardwareProfile`, and the three things it had that the
contracts lacked — `DeploymentMode`, `RateConflict`, `max_age_days` — now live on `Rate`. So the
stale-enum row for it in §5a above is historical; the file is gone.

## 6. `reference/tokenomics-reference.html` — 8 sites, and it is published

The reference page carries the stalest lists in the repo, including `Method` at **4 of 11**
(line 628) and `Confidence` at 3 of 4 (line 629). Two sites list image pricing dimensions
without `per_output_token` (lines 1261, 1377), matching the §A7 drift in sweep 1.

Per the README this page is also published as a private artifact on claude.ai. So the most
outdated statement of the contracts is the one with an audience. Whatever regeneration story
covers Part A should cover this page too, or it should carry a visible "generated from commit
`<sha>`" line so a reader can tell how far behind it is.

## Running total

| Surface | Sites | State |
|---|---|---|
| `TOKENOMICS_MEGA_PROMPT_PART_A.md` | 4 | real drift |
| `LLM_COST_ENGINE_PROMPT.md` | 4 | same four, copy-paste duplicates |
| `/schemas/*.json` | 4 rows | stale + 1 orphan value |
| `reference/tokenomics-reference.html` | 8 | real drift, published |
| `prompts/analyzer.system.md` | 0 | clean |
| Zod blocks in docs | 0 | clean — A15 §11 deletion landed |

One canonical source, five downstream copies, one gate — and the gate covers the copy that is
already correct.

---

# Sweep 3 — the generator (found 2026-09-07, after the repo split)

Reading `generate-schemas.ts` overturns the premise of §5.

`TARGETS` emits four files:

```
registry.schema.json   model-row.schema.json   vision-profile.schema.json   provenance.schema.json
```

`/schemas` holds three, none of them in that list:

```
estimate-output.schema.json   pricing-record.schema.json   workflow-input.schema.json
```

**The generated set and the authored set are disjoint.**

Consequences:

1. `pnpm check:schemas` today reports all four targets as `missing — never generated`. It exits 1
   on absence, not on drift, and it never opens the three files that exist.
2. `MIGRATION.md`'s "**Regenerate.** They are now build output, gated in CI" **cannot be carried
   out for those three files.** The Zod shapes behind them — `EstimateOutput`, `WorkflowInput`,
   a pricing record — do not exist in `packages/contracts`.
3. So §5's stale enums (`Method` 6 of 11, `Confidence` missing `NONE`) will *not* be fixed by
   regeneration. Nothing regenerates them. They stay stale until the shapes are modelled in Zod
   and added to `TARGETS`.

**§5c stands and widens.** It is not only the assumption axis that is missing. The contracts
model *provenance* — where a number came from, how far to trust it. They do not model the
*estimate*: its inputs, its output, or its assumptions. Three JSON Schemas describe that layer
today with no typed source behind them.

**Revised order for `MIGRATION.md`:**

1. Model the estimate layer in Zod — `WorkflowInput`, `EstimateOutput`, the pricing record, and
   the assumption axis from §5c.
2. Add all of it to `TARGETS`.
3. *Then* regenerate. The three authored files become real build output, and their stale enums
   resolve as a side effect rather than as a separate chore.
4. Prove the gate by hand-editing one generated file and watching `check:schemas` go red.

Until step 2, the drift gate protects four files nobody consumes and ignores the three that the
app actually reads.

---

### 5e. CORRECTION to PR #3's deletion note, 2026-09-08 — recorded after §A5.9 was built

§5c and §5d are corrections to this document's own findings. This one corrects a claim made *in
the commit that acted on them*, which is worse, because it shipped.

PR #3 deleted `/schemas/pricing-record.schema.json`. The note said its payload

> duplicated `TextRateProfile`, `ContextTier`, `CacheProfile`, `VisionProfile` and
> `HardwareProfile`

and README.md said "exactly three things were missing" — `DeploymentMode`, `RateConflict` and the
staleness gate. Both statements were repeated in `packages/contracts/src/pricing.ts`.

**It was four.** The record's `self_hosted_profile` block had two halves and only one of them was a
duplicate:

| Field | Counterpart |
|---|---|
| `measured_ttft_seconds`, `measured_prefill_tps`, `measured_decode_tps`, `benchmark_source_url`, `benchmark_batch_size` | `HardwareProfile` — genuine duplicates |
| `instance_type`, `cloud_provider`, `gpu_model`, `gpu_count`, `vram_per_gpu_gb`, `hourly_rate_on_demand`, `hourly_rate_spot`, `regional_tax_rate`, `storage_monthly`, `egress_per_gb`, `concurrency_efficiency_factor` | **none** |

The second half was lost, not superseded, and §A5.9 could not be implemented without it:
`HardwareProfile` answers *how fast does this model run and how much memory does it need*, and
nothing answered *on what, for how much*.

**How the wrong claim got made.** The completeness check behind "exactly three things were missing"
was run against `ModelRow`. `ModelRow` has no deployment-economics fields to compare against, so
the self-hosting half of the record had nothing to be found missing *from* — and the check reported
clean. The note then presented a check of one path as a check of the record. The sentence was not
a guess; it was a true statement about a narrower question than the one it appeared to answer,
which is the harder failure to catch on review.

**Fixed by** `packages/contracts/src/instance.ts` — `InstanceProfile` and `DeploymentPlan`, a
separate row rather than a revived pricing record, plus a `schemas/instance-profile.schema.json`
generator target so the drift gate covers it. The corrections are written into `pricing.ts`,
`README.md` and here rather than applied silently.

**Carried forward:** a deletion note that asserts nothing was lost must name the thing it compared
against, and the comparison has to cover every consumer of the deleted shape — not the one that
happened to be open in the editor.
