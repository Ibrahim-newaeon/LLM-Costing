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
| `schemas/` | Seven JSON Schemas, all **generated** from the contracts and gated in CI |
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

`packages/contracts` is complete as a contract layer and fully gated. `packages/estimator` has
begun with visual token counting — the first code that consumes the contracts. No tokenizers, no
ingestion, no router, no UI yet.

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

## Build order

**Contracts** ✅ (Zod canonical, JSON Schema generated with a CI drift gate)
→ **estimator** ✅ (pure functions, fully unit-tested — every §A5 section has a module:
   vision, text, output, audio/video, cache, tiers, assembly, self-hosting, request multipliers)
→ tokenizers (§A4.5 tiers) + Layer 0 parser (§A4.4)
→ pricing ingestion → registry → router → UI → e2e.

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
