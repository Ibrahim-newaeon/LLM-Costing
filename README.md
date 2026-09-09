# Tokenomics Engine

Multi-provider LLM/LMM token and compute cost estimator. Approximate by design, with stated
error bars — and a refusal where a number would be a guess.

## The rules that make it worth building

1. **Zero hardcoded rates.** No price, tile constant, resolution limit or throughput figure in
   source. All DB rows with `source_url` + `verified_at`.
2. **Guess quantities, never guess rates.** A missing rate blocks the estimate. A missing
   quantity gets a labelled, editable default that downgrades confidence.
3. **Ranges, not points.** Anything non-deterministic returns P50 and P90.
4. **Every number is traceable.** `method` + `confidence` on every line, describing the tier
   that *actually* produced it — never the tier that was requested.
5. **Conflicts are reported, not merged.** Two sources disagreeing are both shown. Never averaged.

## Layout

| Path | What it is |
|---|---|
| `SPEC.md` | The single spec document (formerly `LLM_COST_ENGINE_PROMPT.md`) — Part A, Part B, usage notes |
| `packages/contracts/` | Zod contracts — the canonical shapes |
| `packages/estimator/` | Pure functions over the contracts. Visual token counting so far (§A5.2) |
| `packages/parser/` | §A4.4 Layer 0 — deterministic L1 request parse. No model, no network, no clock |
| `packages/router/` | §A7 — capability gate, three objectives, split routing |
| `packages/e2e/` | §A11 — the chain, and the ledger of every unraised `WarningCode` |
| `packages/ingest/` | §A4.2 / §A6 — pricing ingestion: snapshot, observations, two-source comparison, conflict queue. The second package allowed I/O |
| `packages/calibrate/` | §A5.4 — output-prior capture: provider usage → `OutputSample`, samples → `OutputPrior`. Pure and keyless |
| `registry/sources/` | Per-feed config with reasons (`litellm.json`) and the last saved observation set the next pull is diffed against |
| `scripts/` | Workspace-wide gates. `check-literals.mjs` enforces rule 1 in CI |
| `schemas/` | Fifteen JSON Schemas, all **generated** from the contracts and gated in CI |
| `prompts/analyzer.system.md` | Runtime analyzer system prompt; ships at `/prompts/` in the built app |
| `prototype/` | Working Vite/React prototype recovered from `~/llm-token-calculator`. Reference only — see `docs/prototype-salvage.md` |
| `reference/` | The published reference page. **Stale** — 8 drift sites, no generator. Kept so it is not lost, not because it is current |
| `docs/` | Findings from the 2026-09-07 review pass |

### Dropped

**`TOKENOMICS_MEGA_PROMPT_PART_A.md`** was not carried over. Checked line by line against
`SPEC.md` before the old folder was deleted: of its 1,106 lines, 20 were unique, and all 20 were
the preamble describing what Part A is. No spec content was lost. Regenerate the single-paste
version from `SPEC.md` when it is needed.

## State, honestly

As of 2026-09-09 (`main` after #25): **667 tests across 32 files**, typecheck clean, fifteen
generated schemas in sync, 75 allowlisted literals each with a written reason. The chain runs
end to end — prose → parser → estimator → router → `EstimateOutput` — for two registry rows
whose every figure was read from the vendor's own page. Ingestion checks those rows against
LiteLLM's feed and never writes a rate. The output side has a capture path and no samples.
**No live API call has ever been made from this repo**; one live feed pull has. What is not
built: tier 2, the probe, L2, scenarios, UI, the MCP surface, and every provider beyond the
two. The sections below are in the order they were built, and each says what it found.

The paragraph that follows is how the toolchain was stood up on 2026-09-07, kept because the
failure it records — a gate that went green while guarding nothing — is the reason every gate
here is proven to fail before it is trusted.

The toolchain was stood up on 2026-09-07, and everything here has actually been run rather than
merely read. The authority is a clean-checkout CI run, not a local one —
[run 34133800389](https://github.com/Ibrahim-newaeon/LLM-Costing/actions/runs/34133800389),
ubuntu-latest, 12s:

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | lockfile up to date, 46 packages, esbuild postinstall ran |
| `pnpm typecheck` | passed — TypeScript 7.0.2, `strict` |
| `pnpm test` | 29 passed, 1 file (`src/registry.test.ts`) |
| `pnpm check:schemas` | `schemas in sync with Zod ✓` |

The gate was separately proven to **fail**, which is the half that matters: injecting
`PRETTY_SURE` into the generated `Confidence` enum turned `check:schemas` red and named the
offending file; regenerating restored green. That was a local run, not a CI one.

Resolved versions live in `pnpm-lock.yaml`. Run **`corepack enable`** first, then `pnpm install` —
not `corepack pnpm install`. Some root scripts shell out to a bare `pnpm` (`pnpm -F @tokenomics/contracts
check:schemas`), so without the shim on `PATH` they fail with `sh: pnpm: command not found` while
the outer command appears to work. CI does the same thing in its own step.

**One tsconfig and one test runner, both at the root.** Per-package copies were the alternative
and they are the same compiler options waiting to disagree — the defect this repo exists to
avoid, one level down from the schemas. The per-package vitest installs also broke outright:
pnpm 12 recorded a peerless `vitest@5.0.0` for `packages/estimator` while materializing only the
peer-resolved variant, so the symlink dangled on a clean install. Regenerating `pnpm-lock.yaml`
from scratch fixed the resolution; consolidating removed the duplication that invited it.

The lockfile is portable and has been exercised on three platforms — linux-arm64, linux-x64 (CI)
and darwin-arm64. `node_modules` is not portable; re-run `pnpm install` after changing machine.

Note: `scripts/generate-schemas.ts` uses `__dirname`, so the contracts package is intentionally
**not** `"type": "module"`.

### `zod-to-json-schema` emitted empty schemas on zod 4

Recorded because it is precisely the failure this repo exists to prevent, and it was two minutes
from being committed as build output.

`zod-to-json-schema@3.25.2` declares peer `zod: ^3.25.28 || ^4`. On zod 4 it does not throw. It
returns `{}` for every object. The first real run of the generator wrote four files shaped like:

```json
{ "$ref": "#/definitions/Provenance", "definitions": { "Provenance": {} } }
```

Exit 0, four files written, nothing to see. Committed, `check:schemas` would have gone green
forever while guarding schemas that validate anything at all. Its *types* were the only thing
that objected — `tsc` flagged the zod-3-shaped signature, which is how it was caught.

The generator now uses zod 4's built-in `z.toJSONSchema`, and `zod-to-json-schema` has been
removed from the package entirely — the fix drops a dependency rather than adding one.

Two generator options encode decisions worth revisiting:

- **`io: 'input'`** — these schemas describe a document as it *arrives* (a registry file, an
  ingested pricing row), before Zod applies `.default()`. The contracts lean hard on defaults,
  so input and output shapes genuinely differ: under `'output'` every defaulted field would be
  reported as required, which no source document has to satisfy.
- **`reused: 'ref'`** — shared subschemas are extracted to `$defs` rather than inlined at every
  use site. Registry inlined was 429 KB, which no reviewer can read a drift diff of.

  Zod names an unregistered def **positionally** (`__schema0…__schemaN`), so inserting one field
  renumbered every def after it. **Closed 2026-09-07**, in two steps in the generator: every
  exported schema is registered in `z.globalRegistry` under its export name, and the anonymous
  leftovers — inline shapes zod saw twice, 2–385 bytes, median 74 — are inlined back afterwards,
  since the `$ref` cost about as much as the body it replaced.

  `$defs` now holds only the package's real types, **zero** `__schemaN` across all seven files,
  and the files are *smaller* than before (registry 82.3 → 67.6 KB). A drift diff now names the
  type that changed. 314 `$ref`s resolve; none dangle, none are unreferenced.

`unrepresentable` is left at its default, `'throw'` — a shape JSON Schema cannot express should
fail the build, not be silently widened to `{}`.

### The split is closed

`generate-schemas.ts` now emits seven files, all gated:

```
registry.schema.json   model-row.schema.json   vision-profile.schema.json   provenance.schema.json
assumption.schema.json   workflow-input.schema.json   estimate-output.schema.json
```

Two of the three hand-authored orphans — `workflow-input` and `estimate-output` — became build
output on 2026-09-07 and now come from Zod. Regenerating fixed their stale enums in passing:
`estimate-output`'s `method` went from 6 values to the canonical 11, and `confidence` gained
`NONE` in both.

**`pricing-record.schema.json` is the exception, and is not being regenerated.** Its payload —
`token_rates`, `context_tiers`, `cache_policy`, `vision_profile`, `self_hosted_profile` —
duplicated `TextRateProfile`, `ContextTier`, `CacheProfile`, `VisionProfile` and
`HardwareProfile`, which already exist in richer form and where every `Rate` carries its own
`Provenance` with `source_url` and `verified_at`. Porting it would have been a fifth definition
of the rate shapes.

Checked against `ModelRow`, exactly three things were missing, and all three now live on `Rate`
where the fact they describe actually is: `DeploymentMode`, `RateConflict` (rule 5's only home in
the contracts) and `max_age_days` + `rateFreshness()`. The file itself is now superseded and
should be deleted.

> **Correction, 2026-09-08.** It was **four**, not three, and the paragraph above overstated the
> duplication. Only half of `self_hosted_profile` duplicated `HardwareProfile` — the measured
> throughput fields. The other half was the **instance economics** (`gpu_count`,
> `vram_per_gpu_gb`, on-demand and spot hourly rates, `regional_tax_rate`, `storage_monthly`,
> `egress_per_gb`, `concurrency_efficiency_factor`), and that had no counterpart anywhere in the
> contracts. It went out with the file and stayed missing until §A5.9 needed it.
>
> It is back as `packages/contracts/src/instance.ts` — `InstanceProfile` and `DeploymentPlan` —
> as a separate row rather than a revived pricing record. A model row describes a model; an
> instance row describes a rented machine; one model runs on many instances and one instance
> serves many models. Folding them together is what made the old record duplicate four other
> shapes to begin with.
>
> The lesson is narrower than "don't delete things": the deletion note asserted a completeness
> check ("exactly three things were missing") that had been run against `ModelRow` and not against
> the self-hosting path, and it read as though it had been run against both.

## Open queue

1. ~~**Add the missing contract layer.**~~ **Closed 2026-09-07.** `Assumption` (one superset type,
   replacing two drifted copies), `Ambiguity`, `MissingDatum`, `WorkflowInput` and `EstimateOutput`
   all exist in Zod and are generator targets. `DeploymentMode`, `RateConflict` and the
   `max_age_days` staleness gate landed on `Rate` rather than on a recreated pricing record — see
   below. 128 tests.

   Two corrections to `docs/drift-sweep.md` §5c came out of it: the two impact scales are **not**
   duplicates and must not be reconciled (`impact` is on `Ambiguity`, `impact_if_wrong` on
   `Assumption`), and its suggested Zod would have dropped `seed_provenance`.
2. **Four prose fixes in `SPEC.md`** — §A3 (`Method` 5 of 11, `Confidence` missing `NONE`),
   §A3.8 (`SourceClass` missing `VENDOR_CONFIG`, `MEASURED`), §A7 (`per_output_token`),
   §A14 (calibration buckets). Line numbers in `docs/drift-sweep.md`.
3. **§A7 needs a fact, not an edit** — the prose says image generation is "not per token"; the
   contract has `per_output_token`. One of them is wrong.
4. **Paste the VERIFY resolutions into §A4.1** — all three are closed with sources in
   `docs/verify-resolution.md`.
5. ~~**Prove the gate.**~~ **Closed 2026-09-07.** `PRETTY_SURE` was injected into the
   generated `Confidence` enum; `check:schemas` went red and named the file; regenerating
   restored green. `.github/workflows/ci.yml` now runs install → typecheck → test → gate on
   every push and PR.
6. **Then** delete the superseded files per `MIGRATION.md`, re-point `verify-rates.ts` /
   `calibrate-scripts.ts` / the probe at `@tokenomics/contracts`, and start `/packages/estimator`.
7. **Mine the prototype** — `docs/prototype-salvage.md`. The image geometry math and the rate
   refresh pipeline are built and worth porting; the Claude tokenizer path is a legacy proxy
   presented as exact and must be tagged honestly before it moves.
8. **Optional, high leverage** — `docs/mcp-surface-a16.md` specs an MCP server so an agent can
   price its own call before dispatching it.
9. **`ttft_seconds` needs a stated convention.** §A5.9 writes
   `request_seconds = ttft + prefill + decode`, which treats TTFT as the latency *before* prefill
   begins. The industry's published "time to first token" usually **includes** prefill, so a
   `HardwareProfile` row populated from a vendor benchmark double-counts the prefill term. The
   formula is implemented exactly as specified and `Throughput.ttft_seconds` carries the warning;
   what is missing is a sentence in SPEC §A5.9 saying which of the two the field is, and an
   ingestion rule that enforces it.
10. **Does the service-tier multiplier really scale server-tool fees?** §A5.10's formula puts
   `Σ server_tool_calls × per_call_fee` **inside** the parenthesis that the tier multiplier and the
   residency uplift both apply to, so `request.ts` implements it that way. A batch discount on a
   web-search call fee is not obviously how any provider bills it. Needs one vendor page to
   confirm or split the term out of the parenthesis.

## The first real number

`/registry/registry.json` holds one model: **Claude Opus 5**, every figure fetched from
`platform.claude.com` on 2026-09-08 with a `source_url` and a `verified_at`. It is the first
`Registry` document this repo has ever had, and the first time the contracts and the estimator have
met data rather than a fixture.

`packages/estimator/src/end-to-end.test.ts` drives it through the whole chain —
`Registry.parse` → `countVisionTokens` → `buildLine` → `assembleCandidate` — and lands on a dollar
figure. A 1000×1000 image is **1296 visual tokens**, and at $5/1M that is **$6.48 per thousand
images**: the same figure Anthropic's own worked example states, computed here from the geometry
rather than copied from the page.

**It pins the refusal just as hard.** A text task against the same fully-priced row returns nothing:
`tokenizer_multiplier` and `framing_tokens_per_message` are recorded as `UNAVAILABLE` because nobody
has measured them, §A4.5.4 forbids borrowing the English bootstrap ratio, and the model is a
reasoning model with no reasoning prior. One refused line drags the whole candidate to `NONE`
confidence even while the vision line beside it is HIGH and costed. A repo that only tests the first
outcome is one that will eventually ship the second as a zero.

**What the slice found, in its first ten minutes:**

- **A contract defect.** `input_rate_by_modality` is a `z.record` over an enum key, which in Zod 4
  is exhaustive — a text-and-image model must write `audio: null, video: null` rather than omit
  them. The behaviour is right (an omitted key is indistinguishable from a modality nobody
  considered) but it was undocumented, and nothing had ever parsed a real row to discover it. Now
  documented in `pricing.ts`.
- **A published fact that validates §A5.10's first shape correction.** "Claude 4.6 and later models
  include the full 1M token context window at standard pricing. (A 900k-token request is billed at
  the same per-token rate as a 9k-token request.)" `context_tiers` is `null` — not a single-entry
  array and not an assumed surcharge.
- **A published residency uplift, and a reason not to use it.** The 1.1× `inference_geo` multiplier
  is real and applies "on all token pricing categories, including input tokens, output tokens, cache
  writes, and cache reads" — vendor confirmation of exactly the term `request.ts` refuses to let a
  line escape. But it is scoped to "Claude 4.6 and later models", a set the docs never enumerate, so
  `residency_uplift_pct` is `UNAVAILABLE` and the US-only route refuses rather than being quoted at
  the default price or a guessed one. **VERIFY #5.**
- **Derived cache rates.** The page publishes *multipliers* of base input (1.25× five-minute write,
  2× one-hour write, 0.1× reads), not absolute rates, so the cache rates carry `method: DERIVED` and
  name the arithmetic in their provenance.

## Layer 0 — four ways a parser silently undercounts

`packages/parser` is §A4.4's L1: a deterministic parse with no model, no network and no clock.
`parse_meta.parser_model_id` is `null` and the contract permits null **only** for L1 — an L1 parse
costs nothing, and that absence is the margin metric, not a missing field.

L1 either emits a `WorkflowInput` or escalates to L2 with what it managed (matched intents, script
mix) rather than an empty workflow or a raw string. `parseConfidence` prices four penalties —
a suppressed verb, three or more scripts, a long free-text instruction, a conditional branch — and
`PARSE_CONFIDENCE_FLOOR` is 0.6.

Every defect below is an **undercount**, and that asymmetry is why they are worth this much prose:
a verb that vanishes takes a whole document's tokens out of the estimate and leaves nothing on
screen to notice, while an overcount is visible and editable.

| | What broke | How it was caught |
|---|---|---|
| **1** | `extract` was in the lexicon in Arabic (`استخرج`) and Chinese (`提取`) but **not English**. "Extract the clauses from the contract" matched no verb, so the contract's READ never entered the workflow | A negation test that used the English word. The same audit flagged `analyze` (Arabic `حلل` is there, English is not) — **not** added, because "analyze this image" belongs to `analyze_image` and widening `ingest` would route it to text ingestion. Recorded, not papered over |
| **2** | Ta-marbuta folded to `ه` **before** pronominal-suffix stripping, so the suffix rule ate the letter the fold had just produced: `مراجعة` → `مراجعه` → `مراجع`. The stem stopped matching the lexicon and the verb disappeared | An assertion that `مراجعة` normalizes to `مراجعه`. The fold now runs **last**; a real suffix never attaches to a bare `ة`, so stripping first is safe |
| **3** | A 24-character negation window suppressed the verb in "don't summarize, **just** extract" — `extract` sits 17 characters after the negator, well inside the window | Distance cannot separate that from "don't summarize **or** extract", where the verb genuinely is negated. The contrast marker is the only signal in the sentence that can, so `isNegated` now scans from the **end** of the latest negator for one. From the end, because `rather than` contains `rather ` and `instead of` contains `instead ` — scanning from the start would let those two negators cancel themselves |
| **4** | A compound verb's two halves both pointed `expands_from` at a synthetic parent id (`intent:summarize`) that was not a task | `WorkflowInput` rejected the whole workflow: `expands_from` must name a task that exists. The pair now anchors on its own first half — which is also the right answer, because a parent row would be a third entry that nothing bills, and §A4.4.3's point is that the expansion **is** the two things you pay for |

Defect 4 is the one worth noting for how it was found. It was not caught by a test written to look
for it; it was caught because the contract already refused to represent it. That is the same
property that made `CostComponent` the right guard for §A4.4.1's "system overhead must not be a
per-candidate line" — `SystemOverhead` lives on `EstimateOutput`, `CostComponent` has no member for
it, and so no runtime check is needed or written.

### The mutations

Each guard broken on purpose, against 44 parser tests:

| Mutation | Red |
|---|---|
| Numeral westernization removed (§A4.4.2's named defect) | 3 |
| `translate` → WRITE only, `summarize` → READ only (§A4.4.3's two named misclassifications) | 4 |
| Ta-marbuta folded before suffix stripping | 1 |
| Contrast marker ignored | 3 |
| `expands_from` anchored on a synthetic parent | 13 |

The last row is the contract doing the work: one wrong id fails `WorkflowInput.parse`, so every
test that parses a workflow goes red at once. The third is the narrowest — one test — which is
honest about its coverage rather than flattering.

## §A5.3 — a provider may price a video frame off its own scale

`VideoInputProfile` had exactly one cost path: frames sampled at
`frame_sample_rate_hz`, each priced through the model's **image** geometry.
`per_frame_uses_vision_geometry: false` could say *"not that"*, and then there was
nothing to multiply by, so such a model refused outright. The refusal message named
the gap itself: *"no alternative per-frame count is published."*

Google publishes one. From
[ai.google.dev/gemini-api/docs/tokens](https://ai.google.dev/gemini-api/docs/tokens)
(page footer: last updated 2026-09-04 UTC), read 2026-09-08:

| | |
|---|---|
| Video, bullet list | *"263 tokens per second (applies to static processing)"* |
| Video, table below it | *"~100 tokens/second by default (low resolution) or ~300 tokens/second (high resolution). All frames sampled at 1 FPS."* |
| Images | *"≤384 pixels in both dimensions count as 258 tokens. Larger images are tiled into 768x768 pixel tiles, each counting as 258 tokens."* |

None of 100, 263 or 300 is 258. Pricing a Gemini frame through Gemini's image
geometry would have produced a different number in the same unit — the failure that
reads as an answer rather than as an error.

`tokens_per_frame` is **per sampled frame, not per second.** The two coincide only
at 1 fps, and the frame is the quantity that scales: `sampleFrames` already derives
the count from duration × fps and clamps at `max_frames`, so a per-second field
would multiply the fps in twice and skip the clamp. Google's own note — *"token
usage scales proportionally with the configured FPS"* — is the per-frame reading. A
vendor publishing per-second converts at its own default rate, and that division is
`method: 'DERIVED'`.

A refinement refuses a row carrying both paths. Two prices for one frame makes which
one gets read an implementation detail, which is the same defect as two definitions
of a contract shape.

### And Gemini video is still not priced — VERIFY #7

Not for want of a field. **The same page states 263 tokens/second in one place and
~100/~300 in another, both labelled static processing.** Rule 5: reported, never
merged. 263 sits between 100 and 300, which makes averaging look reasonable and
would fabricate a fourth number no source states.

Where that lands is itself a finding: `RateConflict` is rule 5's only implementation
in the contracts and it lives on `Rate`, shaped for money (`competing_amount`,
`delta_pct`). A vendor contradicting itself about a **sourced constant** — a
tokens-per-second, a tile size, a resolution limit — has nowhere to be recorded, and
can only appear as a plain absence. *(Closed structurally by §A6 below: every `sourced()`
value now carries a `SourcedConflict` slot. The Gemini video row that would hold this one
is still unbuilt.)*

### A fixture that had never been checked against its contract

`videoProfile()` in `media.test.ts` returned `any` from a hand-built literal, so the
video fixtures were never validated against `VideoInputProfile`. Adding a required
field should have broken every call site at compile time — the property the tier-1
`covers` change relied on deliberately. Instead one test failed at run time with
`Cannot read properties of undefined`. It now parses, as its sibling `audioProfile`
always did. `hardware` in `selfhosted.test.ts` and the `EstimateLine` literals in
`request.test.ts` still do not.

## Rule 1, made mechanical

§A12's first checklist item is a grep: *"finds zero numeric price literals, tile
constants, or tokens-per-second values in `/packages` and `/apps`"*. A grep run by
hand proves the tree on the day somebody remembers to run it.

`pnpm check:literals` runs in CI. Every numeric literal in a non-test source under
`packages/*/src` is either **structural** (0, 1, 2 — indices, arity, tier numbers)
or recorded in `scripts/literal-allowlist.json` **with a reason a human wrote**.
Counts are matched exactly, so a second occurrence of an already-allowed value is
also drift, and an entry whose literal has gone is reported as stale — a list that
only grows stops being a record.

Keyed on `(file, value)` and deliberately **not** on line number: a gate that churns
on every edit above it gets regenerated without being read.

It is a lexer, not a parser. TypeScript 7 is the native port and ships no JS
compiler API, and a parser dependency for a lint of our own source is not worth its
supply chain. It blanks comments and string bodies with a small state machine and
then matches numbers, so its failure direction is **over**-reporting: an unusual
construct produces a spurious entry that someone annotates, never a rate that slips
through silently.

Proven in four directions on 2026-09-09 — a planted `0.000005`, a second occurrence
of an allowed `0.1`, a blanked reason, and a stale entry each turn it red.

The sweep found **no rule-1 violation**: 59 entries, all structural arity, calendar
and unit conversions, HTTP statuses, named thresholds, and the Chinese numeral
table. This is a regression guard, not a bug fix. It did catch that the four
`parseConfidence` penalties in the parser are unnamed weights, which is why they now
carry written reasons.

## §A11 — the chain, and the eighteen warnings nobody could see

Every other suite here tests a module against its own contract, and every one
passes. §A11 exists for the defects where each module is individually correct and
the seam between them is not. It found one immediately.

`packages/e2e` drives the whole chain — prose → `parseL1` → `WorkflowInput` →
estimator → `route` → `EstimateOutput` — and `assembleEstimate()` is the box that
had never been built. `assembleCandidate` stops at one `Candidate`; every
`EstimateOutput` that had existed was hand-written inside a test, which is the
condition under which a rule holds in the contracts and never holds in the product.
It **computes** `confidence` and `needs_human_review` rather than accepting them,
because the contract refines on both and taking them as parameters means writing
the derivation twice.

§A12's headline item is now proven in its own words: **parser overhead once per
estimate, 1 vs 10 candidates**, stated as arithmetic — candidate cost scales with
the comparison set, the parse does not.

### Eighteen of thirty-two `WarningCode`s were raised nowhere

Not "modules forget to emit codes". **The warning channel was two different things
sharing a name.** Only `output.ts` typed its warnings as codes; `media.ts` and
`selfhosted.ts` pushed a *code* with the sentence in a separate `notes` array,
`cache.ts` pushed *prose* with no code, `request.ts` pushed a mixture through a
`Set<string>`. `EstimateWarning` is `{code, message, severity}` — each module had
one half, and the pairing is unrecoverable because `notes` also collects messages
that have no warning.

Flipping the channel to `EstimateWarning[]` **was** the survey; the compiler named
every site. Where they landed:

| | |
|---|---|
| **Raised — 8, then 11** | `VISUAL_TOKENS_DOMINATE_CONTEXT`, `NEAR_CONTEXT_TIER_THRESHOLD`, `ASSET_EXCEEDS_MAX_EDGE`, `PROVIDER_WILL_NORMALIZE`, `RESIZE_BELOW_LEGIBILITY_FLOOR`, `ESCALATION_FAILED`, `STALE_FX_RATE`, `MEDIA_PAYLOAD_NOT_REMOTE_COUNTED`; later `MODEL_DEPRECATED` (#23) and, with ingestion, `PRICE_CHANGED_SINCE_LAST_RUN` and `RATE_CONFLICT_UNRESOLVED` |
| **Layer not built — 9, then 7** | tier-2 proxy codes, the asset reroute, tier-3 padding, the calibration corpus. The two §A6 codes left this row when ingestion was built |
| **Unreachable — 1** | `CACHE_KEY_MISSING_TOKENIZER_REVISION`. The contract *rejects* such a line outright, so the data can never exist to warn about. Prevention beats notification — which makes the enum member dead weight, not a gap |

`warnings.test.ts` holds the ledger and fails three ways: a new unraised code, a
reason that outlived its defect, and drift in the count. It earned its keep on the
merge — eight codes stopped being unraised and the enum grew to 35, and both
assertions fired rather than passing quietly.

### Two that needed more than an emission

**`STALE_FX_RATE`** needed a function. `rateFreshness` asks whether the *rate* was
re-checked; on a non-USD row the list price can sit unchanged for a year while the
conversion that made it dollars has moved. `fx_rate_date` had been required since
the contract was written and **nothing read it** — the same defect `rateInForce`
was written for, one field along. The window is the rate's **own** `max_age_days`:
a row claiming 30-day re-verification is claiming how fast it goes out of date, so
a conversion older than that is stale by its own standard. No policy invented.

**`MEDIA_PAYLOAD_NOT_REMOTE_COUNTED`** had no guard at all. A text-only count on a
media-bearing request is not wrong by itself — a text line and a vision line are
composed and added. What is wrong is a count that *claims* to cover the whole
request when it cannot have seen the media: a local tokenizer skips image blocks,
and tagged `WHOLE_REQUEST` that number suppresses the framing components **and**
tells the caller nothing else is owed, so every image is priced at zero. Only tier
1 has seen the media, and Anthropic says so — the count *"includes … images and
PDFs"*. `payload_has_media` is required rather than optional, so a caller who
forgets cannot fall into the unsafe path.

### What the mutations caught that the tests did not

Twice, a mutation survived and exposed a hole the suite could not see.

Inverting §A3.7 at the estimate level — taking the **strongest** candidate instead
of the weakest — turned nothing red, because every test compared candidates of
*equal* confidence, where min and max coincide. The fix is the shape that matters
in practice: a HIGH candidate beside one that refused. A sweep afterwards confirmed
the hole was local; the other two call sites already used differing values.

Replacing a warning's message with `'x'` also turned nothing red. Nothing was
checking that a code arrives with anything a reader can act on — which is the
entire point of pairing them.

**Keep both patterns.** A min/max rule needs a test where the two differ, and
equal-valued fixtures hide it.

## §A6 — ingestion, and rule 5 running for the first time

Until now every figure in `registry.json` was read by a person from a vendor page and
typed in with its URL and date. That is the right way for a figure to *enter* — the
project's rule — and it leaves the registry with no way to notice when the world moves.
`packages/ingest` is §A4.2's Tier A: pull a machine-readable feed, record what came back,
compare it to the registry, and report. **It never writes a rate.** The only thing it can
put on a row is a `conflict` slot beside a figure a human sourced.

```
takeSnapshot     feed body → Snapshot {source_url, retrieved_at, sha256, bytes}   I/O, via a port
extractLiteLLM   body → Observation[]  (RATE | LIMIT | LIFECYCLE), in the feed's own unit
compareRates     Observation vs registry Rate → one of seven outcomes
diffObservations two pulls of one source → PriceChangeEvent[]
applyConflicts   CONFLICT → registry with the slot set; the figure untouched
openConflicts    the review queue — every unresolved conflict, both kinds
```

The first feed is LiteLLM's `model_prices_and_context_window.json`, an **aggregator**, so
every observation it yields is `AGGREGATOR` at `MEDIUM` — the contract refuses HIGH for that
class, and it refuses it at the observation, not somewhere downstream. Which LiteLLM key
describes a registry row is **data with a reason** (`registry/sources/litellm.json`): the
feed lists one product under a dozen keys at different prices because Bedrock, Vertex,
OpenRouter and the vendor's own API are different routes, and picking the closest-looking
key would be guessing a rate. The currency is also config, with the sentence from LiteLLM's
docs that states it and the date it was read.

### Seven outcomes, because "they disagree" is the least of it

| Outcome | Meaning |
|---|---|
| `AGREE` | Same figure after explicit unit normalization (per token ↔ per 1k ↔ per 1M; nothing else converts) |
| `WITHIN_TOLERANCE` | Different figure, inside the tolerance — reported with its delta so drift can be watched |
| `CONFLICT` | Beyond tolerance. A `RateConflict` is built with **both figures in the registry's unit**, a signed delta, and `resolved: false` |
| `REGISTRY_UNSOURCED` | The row has the slot and never sourced it — a lead for a human, not a value to write |
| `NO_SLOT` | A tier boundary the registry does not draw, a variant it does not carry — not rounded to the nearest tier |
| `NOT_COMPARABLE` | Different currencies or a non-token unit. Never converted (§A4.2) |
| `ZERO_BASE` | Registry says free, feed says not. No finite percentage exists, so none is invented |

`tolerance_pct` is **required with no default**. §A3 names `PRICE_CONFLICT_TOLERANCE_PCT` and
gives it no value; a default in code would be a policy nobody wrote down applied to every
conflict. The runner takes it per run.

### On the real feed

`pnpm -F @tokenomics/ingest ingest:litellm --tolerance-pct 2`, live, 2026-09-09: the feed hashed
identically to a pull eighteen minutes earlier (`aed90403…`, 2,338,687 bytes), and **every comparable
figure agreed** — Anthropic's four rates, Gemini's base and above-200k input and output. What it
found instead was the other five outcomes doing their job:

- Gemini's cache-read rate at both tiers: `REGISTRY_UNSOURCED`. The registry row has no cache
  profile; the feed states one. A lead to read on Google's page, not a value.
- Gemini `context_window` and `max_output`: the feed states 1,048,576 and 65,535; the registry
  has `UNAVAILABLE` (Google's spec tables are JS-rendered). Reported as claims for a human.
- `claude-opus-5` `deprecation_date`: the feed claims 2027-07-24; the registry has null. A
  lifecycle claim from an aggregator is reported, never written — the vendor's page decides.

Zero conflicts, so the conflict path is proven on **synthetic** observations named as such
(`example.invalid` sources, the real reading doubled) and by mutation: averaging the two
figures, ignoring the tolerance, silencing an unresolved conflict, downgrading it to WARN,
overwriting another source's conflict, dropping constants from the queue, an off-by-one in the
tier lookup, guessing a missing key, and dropping REMOVED events each turned between one and
five tests red. One mutation survived — removing the `outcome !== 'CONFLICT'` check in
`applyConflicts` — and it is equivalent: every non-conflict comparison carries `conflict: null`,
so the second check already refuses it.

### Rule 5 gets a second home, and a reader

`Rate.conflict` has been on the contract since the rate was written and, until
`rateConflictWarnings`, **nothing read it** — the fourth field found by the grep that found
`effective_from`, `fx_rate_date` and `deprecation_date`. Ingestion could have filled it and an
estimate would have priced straight through. The warning is `BLOCKING`, because rule 5 says an
unresolved conflict marks `needs_human_review` and `assembleEstimate` derives that flag from
severity alone; the estimate still renders, at the registry figure. `packages/e2e/src/ingest.test.ts`
drives a synthetic conflict from the feed to `needs_human_review: true` and checks the line was
priced at $5/M — not $10, and not $7.50.

Finding 3.15 — *rule 5 has no home for a conflict on a sourced constant* — is closed
structurally. Every `sourced()` value now carries `conflict: SourcedConflict | null`: two or
more candidates, each with its URL, retrieval time and a locator on the page, `resolved: false`
until a human decides, and `value` left as whatever the reader could honestly commit to. It is
deliberately **not** a generalisation of `RateConflict`: that record answers "which of two rows
is right", this one "what did the source actually say". `openConflicts` reads both, so the
review queue is one list. VERIFY #7 itself is not yet recorded — the Gemini row has no
`video_in` profile to hang it on, and building that profile means reading the rest of the
video page, which is the data item, not this one.

### What "verified" means here

The prototype's refresh script set `verified: true` when a price string appeared on a page.
`Snapshot.content_sha256` is what that flag was actually measuring, under its honest name:
`unchangedSince(a, b)` says the bytes did not move. It says nothing about whether any model
has any price. That still needs a person and the vendor's page — which is what the comparison
is *for*.

## §A5.4 — the output side gets a way in

Every output estimate refused, and correctly: §A5.4 says each prior is "calibrated from
observed runs, not invented", and no run had ever been observed. What was missing was not a
number but the path a number could take. `packages/calibrate` is that path, pure and keyless.
An integration that made a real call hands over the response body; `sampleFromResponse` turns it
into an `OutputSample`, `buildOutputPriors` turns enough samples into an `OutputPrior`, and
`estimateOutputTokens` prices with it instead of refusing. **No sample exists** — no live call
has ever been made from this repo — so on `main` every output estimate still refuses. The
runner reads a file a key wrote somewhere else.

### The three providers do not agree on what "output" contains

Read from each vendor's API reference in the browser on 2026-09-09, quoted in
`packages/calibrate/src/usage.ts`:

| Provider | Reasoning field | Relationship to the output count |
|---|---|---|
| Anthropic | `usage.output_tokens_details.thinking_tokens` — "Breakdown of output tokens by category" | a category **of** `output_tokens`: visible = output − thinking |
| OpenAI (Responses) | `usage.output_tokens_details.reasoning_tokens`; `max_output_tokens` bounds "visible output tokens and reasoning tokens" | a category **of** `output_tokens` |
| Google Gemini | `usageMetadata.thoughtsTokenCount`; `totalTokenCount` is "prompt + thoughts + response candidates" (page: last updated 2026-08-28) | **additional** to `candidatesTokenCount`: visible = candidates as it stands |

A caller that mapped `output_tokens → visible` for all three would double-count reasoning on
two providers and miss it on the third — and reasoning is the invisible, frequently larger half
of a reasoning model's bill. So `OutputSample` carries two figures, `visible_output_tokens` and
`reasoning_tokens`, and the adapter that knows the containment fills them. `reasoning_tokens:
null` means *not reported*, never zero: a reasoning model whose samples all carry null builds a
prior with no reasoning term, and the estimator's existing guard refuses it, which is the right
outcome for an unmeasured invisible term. The same test that proves a prior makes the line price
proves that guard still holds.

Gemini's absent `thoughtsTokenCount` is recorded as null for a reason that is not a preference:
the API's JSON omits zero-valued integers, so "absent" cannot be told from "zero" by the
response alone. A caller that knows thinking was off passes `thoughts_known_zero`. The Chat
Completions field the spec names — `usage.completion_tokens_details` — is deliberately not
mapped: its reference page was not read for this, and a field mapped from memory is a guessed
provider fact wearing a citation.

### The builder does not guess either

`min_samples` is required with no default. §A4.1 sets 200 for the text corpus buckets and says
nothing about output priors; a default in code would be a policy the spec did not state,
applied to every table. Below it a prior is `LOW` and raises `CALIBRATION_SAMPLE_TOO_SMALL` with
the two numbers in the sentence; at or above it, `MEDIUM` — never `HIGH`, because a distribution
measured on one workload is a calibrated table (`CALIBRATED_HEURISTIC`), not a provider fact.
Percentiles are nearest-rank, no interpolation: an interpolated p90 is a length no response
produced. An unbounded band with zero spread is refused rather than given a width. One unknown
reasoning figure withholds the whole reasoning distribution — a partial one understates in the
direction the bill grows. Re-captured responses are deduped on the provider's response id.

The ledger moved from 8 of 36 to **7**. `packages/e2e/src/priors.test.ts` drives ten synthetic
responses to a LOW prior, prices the `completion_output` line at the registry's $25/M — $0.005
p50 and $0.008 p90 for 200 and 320 billable tokens — and carries the warning into the estimate,
where it lowers confidence to LOW and does not force review.

### A test that passed for the wrong reason

`parseL1('summarize the report')` carries the parser's own blocking `pdf_has_text_layer` gap —
"the report" is a document of unknown kind — and a blocking gap sets `needs_human_review` by
itself. The §A6 chain test asserted the flag **true** after a BLOCKING conflict warning and
passed whether or not the warning did anything. The §A5.4 test asserted the flag **false** after
a WARN, and could not. Both now parse `'summarize this text'`, assert there is no blocking gap,
and the §A6 test checks the flag *before* the severity, so a conflict downgraded to WARN fails
on the claim rather than on a detail. A flag with three causes needs the other two ruled out
before the assertion means anything.

Mutations: ten tried, nine caught at one to six tests red. The survivor was a hole, not an
equivalent — the OpenAI adapter's refusal of reasoning larger than output had no test where the
Anthropic one did — and now has one.

## Tier 1 — reading the endpoint properly, and the bug that found

`packages/tokenizers` is the first package allowed to do I/O. `estimator` states in its own index
that it has no I/O, no clock and no network — that is what makes an estimate reproducible from its
arguments — so the network call lives here and the estimator receives a plain value. Everything is
written against a `CountTokensPort`, so **no test touches the network and no API key exists in this
repo**.

### It found a double-count before it sent a single request

Anthropic's count-tokens endpoint is handed the **whole request**, and the docs are explicit that
the count "includes system prompts, tool definitions, messages, thinking blocks, images and PDFs".

`countTextTokens`'s `exact` hook replaced only the `prompt_input` component, then added §A5.1.2
framing and §A5.1.3 tool schemas **on top**. So a tier-1 count would have billed the same tokens
twice — and worse, it would have **blocked outright**, because framing is a hard refusal when
unmeasured and this row cannot supply it. A provider's own exact count, refused for want of a term
that provider had already counted.

The fix is a `covers` discriminator with no default:

| | |
|---|---|
| `PROMPT_ONLY` | The rendered prompt and nothing else. Framing and tool schemas are still owed. |
| `WHOLE_REQUEST` | Everything the provider bills as input. One number, and adding anything to it double-counts. |

No default, because guessing is a silent double-count one way and a silent undercount the other.
Making it required broke both existing call sites at compile time, which is the point. A mutation
that treats `WHOLE_REQUEST` as `PROMPT_ONLY` — the original bug — turns seven tests red.

### The cache key is the whole of tier 0

The docs also state that newer models "use a tokenizer producing **~30% more tokens** than earlier
models for the same content" and instruct you to "always count against the specific model you plan
to use". A cache keyed on the content hash alone would serve one model's count for another's request
and be wrong by roughly a third — consistently, in one direction, on every hit. So the key is
`(model_id, request fingerprint)` and `model_id` is not optional. Changing the system prompt, the
tool set or the thinking config changes the fingerprint; message order matters, object key order
does not.

**A cached value keeps the tier it was produced at.** §A4.5 is explicit that a cached tier-3
heuristic is still tier 3 — tier 0 says where an answer was *fetched*, not how it was *produced*.
`served_from` and `tier` are separate fields for that reason, and re-tagging would let a guess
acquire a provider's confidence by sitting in a map.

### Two vendor caveats, carried rather than filed away

- "Token counts may include tokens added automatically by Anthropic for system optimizations. **You
  are not billed for system-added tokens.**" The count can therefore *exceed* the invoice.
- "The token count is an **estimate**. In some cases, the actual number of input tokens used when
  creating a message might differ by a small amount."

§A4.5 assigns `PROVIDER_COUNT_API` HIGH confidence and that is kept — it is the vendor's own count
of the vendor's own tokenization, and nothing available is closer. But both sentences ride along on
every count and onto the priced line.

### There is no tier 2 here

Anthropic publishes no local tokenizer, so the ladder is **0 → 1 → 3**. A failed tier-1 call does
not degrade by one rung, it drops to the calibrated heuristic — which for this model does not exist
yet. `countWithLadder` therefore returns `FELL_THROUGH` rather than a number, and the caller runs
the heuristic path with its own lower confidence. Substituting anything here would be rule 4's exact
violation: an answer labelled with the tier that was asked for.

### The result, on the real row

The same `claude-opus-5` row that refuses on text produces **$0.0075 for a 1500-token request**
once tier 1 answers, and a combined vision + text candidate totals `(1296 + 1500) × $5/1M` on one
estimate. Counting is free and separately rate-limited (5,000–20,000 RPM by usage tier), so tier 1
costs a round trip rather than money.

## A second provider, and the first real context tier

`/registry/registry.json` now holds **two models from two vendors**: `claude-opus-5` and
`gemini-2.5-pro`, each figure fetched from that vendor's own domain with a `source_url` and a
`verified_at`.

### §A5.7 stops being a thought experiment

Anthropic publishes `context_tiers: null` — "the full 1M token context window at standard pricing".
Google publishes a step:

> **Gemini 2.5 Pro**: Input "$1.25, prompts ≤200k $2.50, prompts >200k"; Output "$10.00, prompts
> ≤200k $15.00, prompts >200k"

The wording is "prompts >200k tokens" — **the whole prompt reprices, not the overflow**. So on real
published rates:

| Request | Tier | Cost |
|---|---|---|
| 199,000 tokens | ≤200k | **$0.2488** |
| 201,000 tokens | >200k | **$0.5025** |

A request **1% larger costs 2.02× as much.** A marginal reading — charging the first 200k at $1.25
and only the 1,000 extra at $2.50 — gives $0.2525 and is understated by a factor of two. That is the
`applies_to_whole_request` distinction the tests had been measuring against fixtures, now measured
against a vendor.

It also makes the advice concrete: **trimming 1,000 tokens, 0.5% of the prompt, halves the bill.**
That is what §A5.7's near-threshold warning is for.

### `rateInForce` — the fields nothing was reading

Google's pricing page carries scheduled changes: *"$0.75 through December 31, 2026. $1.50 starting
January 1, 2027."* Two rates for one model, distinguished only by `effective_from` /
`effective_to` — fields that have been on `Rate` since the contract was written and which **nothing
read**. Confirmed by grep before fixing: no selector existed anywhere.

A registry holding both halves would have priced whichever row the caller reached first, and been
silently 2× out from a fixed date onward.

`rateInForce()` sits beside `rateFreshness()` and answers a different question. Freshness asks
whether a row was *checked* recently enough to trust; validity asks whether it *applies to the date
being priced*. A rate can be verified this morning and still be the wrong rate — there is a test
that asserts exactly that pairing. Overlapping windows are reported as `AMBIGUOUS`, never resolved:
picking the cheaper flatters the estimate and picking the newer assumes an ordering nobody
published (rule 5).

### The gaps are the other half of the row

Gemini 2.5 Pro **accepts images and cannot be priced for them**. Google publishes the tile geometry
(258 tokens ≤384px; 768×768 tiles at 258 each) but no per-image base and **no worked example**, so
whether a 1000×1000 image is 1032 or 1290 tokens is unresolved — 25% on every image, in one
direction, invisible in the output. Recorded as `UNAVAILABLE` geometry with `probe_candidate: true`
(**VERIFY #6**), while `supports_vision` stays **true**: the model does vision, we cannot count it,
and saying otherwise would be a false capability claim. This is the first time
`VISION_GEOMETRY_UNAVAILABLE` has fired on real data.

The contrast is the finding. Anthropic's geometry is HIGH because Anthropic publishes worked
examples — the same ones that caught our off-by-one. Google's blocks because it does not. The
difference is not general documentation quality; it is whether the vendor publishes the specific
artefact that makes a geometry checkable.

Also unpriced and recorded rather than assumed: cache (published for the Flash models in this
family, **not** for 2.5 Pro — carrying a Flash rate across is another model's answer), audio and
video input rates (siblings price audio separately, so parity with text would assume this model is
the exception), and the context window (Google's spec tables are JS-rendered and return only a
navigation shell).

## The router — §A7

`packages/router` is pure, like the estimator: candidates and rows arrive as arguments, so a
recommendation is reproducible from its inputs. That is the point of §A7's requirement that every
recommendation carry a `Rationale` — `{triggering_metric, observed_value, threshold, evidence_ref}`,
and one without it does not render.

### The trap it exists to avoid

`assembleCandidate` sums a refusal line as zero, because `EstimateLine.cost` is null on a refusal.
**A candidate whose every line refused therefore totals $0.00** — and a naive sort on `total_cost.p50`
puts the model nothing could price *first, as the cheapest option*.

That is not hypothetical. Both registry rows refuse on some path: Anthropic on text without tier 1,
Google on vision. A cheapest-by-total router would have recommended whichever one failed hardest.

So the first thing `rank()` does is not a comparison, it is a filter. A candidate is rankable only
if its estimate **finished** — `confidence !== 'NONE'`, which §A3.7 already computes as the minimum
over the lines. A partially refused candidate is excluded too: its total is a lower bound, and
comparing a lower bound against a complete total is the same bug wearing a smaller number. Mutating
that check to `return true` turns five tests red.

### What else is not comparable

**Two currencies.** §A4.2 makes the vendor's native currency the source of truth precisely so nobody
silently compares a CNY figure against a USD one. Ranking returns null rather than converting on an
exchange rate nobody recorded.

**Ties.** Broken by `model_id` lexicographically. Without that, two candidates at the same price are
ordered by their position in the registry file — so re-sorting the registry would change the
recommendation, and a recommendation that moves when nothing about the models moved is one nobody
can reproduce.

### Two of the three objectives cannot be answered

§A7 asks for Cheapest | Best-Capability | Balanced. **Cheapest works. The other two return null**,
because they need a quality signal and §A6 says "do NOT invent benchmark scores. Null unless
sourced" — and neither registry row carries one.

Ranking on price or context window instead would be a capability claim derived from neither. So the
router returns null *with a reason*, which is the correct output rather than a gap to paper over.

### The gate drops loudly

§A7 puts the capability gate before the estimator, and the ordering matters for the *reason*
reported, not just the outcome: a model can fail both the vision check and the rate check, and
"fixing the rate does not make a text-only model see". Capability first, pricing after.

It also reports checks it **could not perform**, separately from passes. Gemini's context window is
`UNAVAILABLE` — Google's spec tables are JS-rendered — so the gate cannot tell whether a 500k-token
request fits. It says so rather than passing it silently. An unexamined pass is not a pass.

### On the real registry

| Workflow | Outcome |
|---|---|
| Vision | Gemini **excluded** (`UNAVAILABLE` geometry, VERIFY #6); Anthropic eligible |
| Text | **Both** eligible — the same Gemini row, undropped, because its gap is vision-specific |
| 100k-token read | **Gemini wins**: $0.125 against Anthropic's $0.50, at $1.25/1M below the 200k tier |
| Best-capability | **Null** — no sourced `quality_score` on either row |

### A withdrawn model is not rankable; a deprecated one is, with a warning

`ModelRow` has carried `effective_to` and `deprecation_date` since the contract was written,
and until #23 **nothing read them** — the third field found by the grep that found
`rateInForce`'s dates and `fx_rate_date`. The consequence here is worse than a mispriced
rate: the router would recommend a model that has been shut down, at a price that is
arithmetically correct for something you cannot call. Not hypothetical — Google's models page
lists shut-down endpoints in a "Previous models" section beside live ones (retrieved 2026-09-08
from https://ai.google.dev/gemini-api/docs/models; the page shows no date).

`modelInService(row, at)` returns **four** states, because two would merge facts with different
fixes. `WITHDRAWN` (past `effective_to`) and `NOT_YET_AVAILABLE` are excluded with
`MODEL_NOT_IN_SERVICE`. **`DEPRECATED` is deliberately not excluded**: the endpoint still
answers, it may honestly be the cheapest option today, so it stays eligible and raises
`MODEL_DEPRECATED` — "migrate off this model" is the useful sentence. The lifecycle check runs
**before** the capability gate, with a test pinning the order: "it has been withdrawn" sends the
reader to the right fix; "it lacks vision" sends them to the wrong one.

## Build order

**Contracts** ✅ (Zod canonical, JSON Schema generated with a CI drift gate)
→ **estimator** ✅ (pure functions, fully unit-tested — every §A5 section has a module:
   vision, text, output, audio/video, cache, tiers, assembly, self-hosting, request multipliers)
→ **tokenizers** ◐ (§A4.5 tiers 0 and 1 done; no tier 2 for Anthropic)
→ **parser** ◐ (§A4.4 L1 deterministic; L2 model-assisted not built — L1 escalates to it)
→ **router** ✅ (§A7 gate, three objectives, split routing — pure)
→ **e2e** ✅ (§A11 chain + §A12's checkable items; `assembleEstimate` is the last box)
→ **ingestion** ◐ (§A4.2 Tier A: snapshot → observations → two-source comparison → conflict
   queue, with LiteLLM as the first feed; Tier B manual overrides and OpenRouter not built)
→ **calibration** ◐ (§A5.4 output-prior capture: response body → sample → prior; the path
   exists, no sample does — populating needs a key at a call site outside this repo)
→ registry → UI.

**Estimator before UI.** The math is the product.

### `packages/estimator` — what exists

`countVisionTokens` evaluates all six geometries in the union, ported from
`prototype/src/lib/images.js` behind the contracts. The prototype had three hardcoded functions
with the constants inline and no provenance; here the constants arrive from the registry, each
carrying its own `Provenance`, a missing one **blocks** rather than defaulting to zero, and the
result's confidence is the minimum over the constants actually read (§A3.7).

Three behaviours worth knowing, each pinned by a test:

- **`BLOCK_GRID_SEP` is not monotonic.** With a 336px block, 10 tokens per block and 100 per
  separator row: `2000×336` (672k px) costs **770**, while `672×2000` (1,344k px) costs **430**.
  Twice the pixels, 44% cheaper — because separators bill on *width alone*. Any "smaller is
  cheaper" shortcut gives wrong advice here.
- **A `TOKEN_CAP` patch grid saturates.** Under a 1568-token cap, `8000×8000` is normalized to
  `1092×1092` for 1521 tokens: 64× the pixels for 1.17× the cost. Oversized is cheap and lossy,
  not expensive. Under `AREA_CLAMP` the same image is expensive and faithful.
- **An oversized asset is not silently scaled.** The prototype's `scaleToFit` ran
  unconditionally, which prices a request the provider would have rejected. Scaling now happens
  only where `provider_auto_normalizes` says the provider does it; otherwise the asset is
  `BLOCKED` and the decision goes to the §A5.2.1 ladder.

`evaluateResize` recomputes both sides and never reasons from area. It suppresses proposals
entirely on `FLAT` geometry, blocks below the legibility floor, and reports
`RESIZE_SAVES_NOTHING` when a shrink raises the count.

### Text, caching, context tiers, assembly

**`text.ts` — §A5.1 and §A5.5.** `input = tokenize(prompt) + framing_overhead + tool_schema`.
All three, because the second is per-model and per-turn and the third routinely dominates a short
agentic prompt. Tool schemas are priced from the **`structured_json` bucket**, not the prose one —
a ratio measured on prose says nothing about brace-heavy machine text.

The sharp edge is §A4.5.4. A bootstrap chars-per-token ratio exists for English prose and **for
nothing else**, so `countTextTokens` returns UNAVAILABLE with a `missing_data` entry naming the
bucket rather than borrowing the Latin ratio. A 70/30 Latin-Arabic document resolves to `mixed`,
which is equally uncalibrated — it is not 70% priceable. Character counts are honest; wrong token
counts are not.

`conversationInputTokens` implements the growth §A5.5 warns is quadratic:
`N(s+a) + (a+b)·N(N-1)/2` for `FULL_HISTORY`. `SLIDING_WINDOW` requires its window size and
`SUMMARIZED_ROLLUP` requires a stated summary size — that one is an assumption nobody knows before
the run, and defaulting it would flatter the single biggest lever in a chatbot workflow.

**`context.ts` — §A5.7.** A step function, with the part that actually matters:
`applies_to_whole_request`. Crossing a threshold can reprice *every* token, not just the overflow.
On the tiers in the tests that is the difference between a saving of 600,000 and 15,000 — **40×** —
so reporting the marginal figure makes the recommendation useless. A request that fits no tier is
a refusal, not a top-tier price.

**`cache.ts` — §A5.6 plus §A5.10's storage term.** `cache_hit_ratio` is a required input *with a
stated basis*; an unexplained ratio is indistinguishable from a flattering default. Caching can
lose money, and the estimator distinguishes *why*: at a low hit ratio the culprit is the write
premium, while a long-lived cache on low traffic loses to the hourly storage charge. The pre-v2.0
cache model could express neither, having no storage term at all.

**`candidate.ts` — §A5.8.** Assembly. The canonical formula is written with a cache *credit*;
this produces the algebraically identical decomposition — uncached at the input rate, cached at
the read rate — because `EstimateLine.cost` is a nonnegative `Range` and a credit line is
literally unrepresentable. A test pins the two forms equal. Confidence is **computed** from the
lines, never accepted, so a caller cannot assert more than the weakest line supports.

`contextOverflow` is the only consumer of the padded quantities, deliberately a separate function
from anything that prices, so the padded number has no path into a total.

### Output and reasoning — §A5.4

The non-deterministic half, and the reason rule 3 exists rather than being decorative. Keyed on
the `expected_output_band` the analyzer picked, because §A4.4 forbids the analyzer emitting a
number itself.

**Reasoning tokens are invisible but billed.** On a reasoning model they are frequently the larger
half — in the tests, 4000 against 900 of visible output. They appear only in
`usage.completion_tokens_details`, so a reasoning model whose prior leaves the term null
**blocks**: treating an unmeasured invisible quantity as zero is the most expensive silent error
available here.

**`max_tokens` is a clamp, not a forecast.** Clamping p90 to the cap makes the estimate look
tighter while the real risk moves elsewhere — the output gets truncated. So the clamp lowers what
is billed and `MAX_TOKENS_BELOW_P90` says why, rather than the risk disappearing into a smaller
number.

`max_tokens_includes_reasoning` is a required input with **no default**, because providers differ
and the answer changes the result materially: on the same 4200-token cap and the same prior,
visible output is 900 tokens if reasoning is billed separately and **200** if reasoning eats the
budget first. Guessing that would be guessing a provider fact.

An `unbounded` band with no cap is refused outright — nothing bounds the cost, so the p90 would be
unfalsifiable.

### Audio and video — `media.ts`, §A5.3

Duration-driven, not byte-driven. Two lines of arithmetic:

```
audio_tokens = ceil(duration_seconds) × tokens_per_second[model]
video_tokens = frames_sampled × per_frame_image_tokens + audio_track_tokens
```

and four ways to be confidently wrong. Each is closed here, and the two most easily optimised away
have a mutation on record that turns exactly one test red.

**1. Audio is billed two different ways.** Some providers convert duration to tokens; others bill
seconds against a `per_second` rate — §A5.8's own identity writes `audio_seconds × audio_rate`.
`billing_basis` discriminates and there is no fallback between them, because reading a row as the
wrong one is a mispricing that scales with the length of the recording. A `PER_SECOND` model gets no
synthesized token figure: that would be a fabricated number wearing a plausible unit, and the
contract refuses a row claiming both bases.

Standalone audio also had **no home in the contracts**. `VideoInputProfile.audio_tokens_per_second`
is the audio *track of a video* — a different quantity on a different asset — so a bare audio file
had nothing to convert with. `AudioInputProfile` is new here.

**2. `per_frame_image_tokens` is a §A5.2 geometry result.** A video is a stack of images, so the
vision geometry *is* the per-frame input — the same coupling §A5.9.1 makes for VRAM, and a geometry
error multiplies by the frame count. `countVideoTokens` calls `countVisionTokens` rather than taking
a flat per-frame number, and refuses outright when the geometry is unavailable.

**3. The sample rate may not be yours to set.** §A5.3 calls sampling "the whole cost", and
`user_configurable_fps` records whether the provider actually exposes it. A person who lowers fps to
save money on a model that ignores the setting has changed nothing — so the request is discarded
*loudly*, with `FPS_NOT_CONFIGURABLE`, rather than quietly honoured and handed back as a saving.
`max_frames` clamps and says that coverage stops rising along with the cost: past the cap a longer
video is not more expensive, it is more thinly sampled.

**4. The LOW ceiling is on the answer.** §A5.3: "force `confidence: LOW` unless the provider
publishes a deterministic formula." Applied last, so strong provenance on the sample rate and the
geometry cannot lift a figure the provider never committed to. The quantity is unchanged — the
ceiling moves confidence, not the number.

**Adaptive sampling is the one refusal.** Where a provider decides at run time how much to load, the
*quantity* genuinely varies and the band can span an order of magnitude on one input. The contracts
put it plainly — P50/P90 or nothing — so with nothing measured `countVideoTokens` returns nothing and
asks for an observed frame range. Supply one and the band survives into the estimate. Everywhere else
the count is arithmetic and returns an exact range, for the reason `range.ts` sets out: what is
uncertain is whether the constants are right, and that belongs on `method` + `confidence`.

**The audio track lands on one side of the `+` or the other.** `audio_billed_separately` decides:
folded into the video quantity where the provider meters them together, or its own line where it is
charged apart. Both are real and both are visible on an invoice. A clip *with* a track on a model
that publishes no audio rate is refused rather than counted without it — dropping it would understate
every clip that has one.

### Request-level multipliers and non-token fees — `request.ts`, §A5.10

§A5.8's identity covers what is metered per token. This is the rest of the invoice, and every term
in it goes missing for the same structural reason: it is a property of the **request**, and a
row-level registry has nowhere to put it. The same model under two service tiers is two different
answers from one registry entry.

**The two multiplicative layers are applied per line, not to the total.** Algebraically identical,
but `Candidate.total_cost` is required to equal the sum of its lines, so scaling the total alone
breaks the contract and scaling *some* lines silently exempts whichever the author forgot. §A5.10
is explicit that the residency uplift covers "all categories, cache reads and writes included" —
the terms least likely to be checked, because nobody looks for a regional surcharge on a cache
write. A mutation test that exempts `cache_*` from the uplift turns that assertion red.

Quantities are never scaled. A batch tier changes what tokens cost, not how many you send;
scaling the quantity would corrupt the token totals and the context-window check along with the
price. Refusal lines pass through unscaled — multiplying nothing produces a zero that reads as free.

**Nothing here defaults to neutral.** Each term has a plausible-looking wrong value and the module
refuses it instead:

| Term | The tempting default | What happens |
|---|---|---|
| Service tier multiplier | 1× for an unpublished tier | Refuses. §A5.10 records one provider's premium tier at **1.8×** where two others use 2× — another vendor's figure does not transfer, and neither does 1. |
| Residency uplift | 0% when unsourced | Refuses. The router recommends the regional endpoint *because* it is compliant, then quotes it at the non-compliant price. A region the model does not publish refuses outright rather than pricing a route that does not exist. |
| Tool-use system prompt | 0 tokens when unpublished | Refuses. This is what the provider injects for *enabling* tools, **additional to** the schema JSON §A5.1 already counts. Two meters, two components — folded into one line, nobody can later check they did not overlap. |
| Server-tool per-call fees | absent from token arithmetic | Priced on their own `server_tool_call` line. A tool the workflow calls and the registry does not price is reported as a hole, not a free call. |
| Free monthly allowance | assume it is intact | **Billed in full, visibly.** Applying it needs month-to-date usage the estimator is not given; the three options are understate silently, refuse a fee that *is* known, or overstate by at most the allowance and say so. The third, with a warning naming the allowance. |
| Re-rolls | 1 candidate per image | Flagged. §A5.10: "almost never actually 1", and every candidate bills — so the figure is the *floor* of a generation cost, and the default costs the estimate confidence rather than passing silently. |

Confidence propagates through the multipliers like any other input (§A3.7): a HIGH token count at a
MEDIUM-confidence tier multiplier is a MEDIUM figure. A multiplier of exactly 1× still floors it —
an unsure claim that nothing was added is still an unsure claim.

`resolveRequestLayer` resolves all four layers in one pass and refuses as a unit, because a
partially-applied multiplier looks exactly like a complete answer.

### Self-hosting — `selfhosted.ts`, §A5.9 and §A5.9.1

Costing flips from per-token to per-second of GPU wall-clock. The arithmetic is not the hard part;
the four errors §A5.9 names are, because each is a one-line change and none of them produces a
number that looks wrong. Each is closed here by a **type or a control-flow path**, not a comment —
a comment is what the implementations that got these wrong already had.

| §A5.9 error | What closes it |
|---|---|
| 1. `kv_heads`, not attention heads (~7× under GQA) | `KvGeometry` has no `attention_heads` member, and `kvGeometryFrom()` is the only constructor. Passing the query count requires widening the type. |
| 2. MoE weights use **total** params | `weightsBytes` reads `params_b_active` only where `is_moe === false`, i.e. where it equals the total. An MoE row with no total returns UNAVAILABLE. |
| 3. FlashAttention does not reduce KV cache | `supports_flash_attention` is never read in the file, and cannot be — `KvGeometry` does not carry it. KV quantization is the lever that does move the term, and a test pins fp16/fp8 at exactly 2×. |
| 4. `gpu_memory_utilization` caps the **total** | One `availableVramBytes()` figure; weights + KV + activations are compared against it together. No term gets its own budget. |

**The gate has three states.** A deployment whose activation buffer has never been measured has a
*lower bound*, and a lower bound that fits proves nothing — so it reports `INDETERMINATE` and names
the field that would settle it. A lower bound that already **exceeds** the budget does settle it,
in the one direction a floor can: `INFEASIBLE`.

**The idle GPU is billed once.** §A5.9's `÷ utilization` is what pays for idle time, so a separate
always-on charge on top double-counts it — and the result still looks plausible. `selfHostedCost`
returns the two lines that sum to *exactly* the spec formula (`gpu_seconds` + `idle_gpu`), so the
idle penalty is visible in the breakdown without being charged twice. A test asserts the identity
to 12 decimal places.

**The crossover is a staircase, not a line.** Two things make the naive chart lie. Utilization is a
*function of volume*, so holding it fixed puts the self-hosted line through the origin and there is
no crossover to find. And an always-on instance has **no marginal per-request cost at all** — you
pay for the GPU either way — so cost is flat until the instance saturates and then steps by a whole
instance. A test walks a case where the first two stairs are both too expensive and the crossover
only opens on the third; a linear model reports it 2× too early.

**Unit bases differ by field, deliberately.** `vram_per_gpu_gib` is GiB because that is what the
runtime reports; `image_activation_buffer_gb` is GB because SPEC §A5.9.1 names the field that way.
Rather than reinterpret either — 7.4% at the exact point where the answer is "does it fit" —
everything converts to **bytes** at its own boundary and only bytes are compared.

**Two gaps in the contracts surfaced by building this**, both recorded rather than guessed:

1. `LowDetailBehaviour.INHERIT` means "the main geometry at reduced resolution", but the
   reduction factor is not modelled anywhere. `countVisionTokens` refuses that combination rather
   than counting at full resolution and looking authoritative doing it.
2. `VisionConstraints.shortest_edge_target_px` has no direction flag. §A5.2.1 warns that several
   providers *upscale* below that target — which is what makes shrinking able to raise a count —
   but nothing records which ones do. Only downscaling is implemented. **Closed for Anthropic**
   by `docs/verify-resolution.md` VERIFY #4 (they downscale only); still open for everyone else.

### Conformance against published worked examples

`vision.conformance.test.ts` pins the estimator to numbers **Anthropic published**, not to
numbers we chose. Verified 2026-09-07 against
[the vision docs](https://platform.claude.com/docs/en/build-with-claude/vision) and
[the resize/pad rules](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates);
neither page shows a publication date.

That check earned its keep immediately. `1000×1000 → 1296` matched, but the A4-at-130-DPI
example (`1075×1520`) resized to `924×1306` where the documentation says `924×1307`. The binary
search was comparing patch rows against an *unrounded* short edge; images have integer
dimensions, and `⌈924.36/28⌉ = 34` against `⌈924/28⌉ = 33` was enough to reject a size the
provider accepts. Same token count on that example, but the resized dimensions are what
coordinates normalize by. Fixed, and VERIFY #4 records it.

It also settled the conflict `docs/external-brief-review.md` §5 flagged: the patch grid is
right, `28² = 784` rather than 750, and 1568 is **two** limits in two units — max long edge
1568 px *and* max visual tokens 1568 on the standard tier.
