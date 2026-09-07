# Contracts v2.0 — reconciliation

Three definitions of the same shapes had drifted. This package replaces all three.

| Superseded | Action |
|---|---|
| `tokenomics/schema/registry.schema.ts` | **Delete.** Do not sync — two sources is how this happened. |
| Annex A15 §11 Zod block | **Delete from the annex**, replace with a pointer to `/packages/contracts`. |
| `/schemas/*.json` (hand-authored) | **Regenerate.** They are now build output, gated in CI. |

---

## The three defects this closes

### 1. The probe could produce a geometry the registry could not store

`fit.ts` emits `BLOCK_GRID_SEP`. Neither Zod file had it, and A15 §3 documents it as a **verified `PROVIDER_FORMULA`** for DeepSeek-VL2. A geometry you had already confirmed against a vendor page had nowhere to live.

`FLAT` was in A15 §11 and missing from `registry.schema.ts`, so a flat per-image model could not be seeded there at all.

**Fixed:** `PROBE_KIND_TO_GEOMETRY` is a total mapping from `fit.ts`'s `GeometryKind` onto the registry union, typed with `satisfies` so adding a kind to the fitter without a registry home is a compile error.

### 2. The schema rejected a model you had verified

A15 §11 line 866:

```ts
.refine((v) => v.geometry !== 'PATCH_GRID' || (v.patch_px !== null && v.token_cap !== null),
  { message: 'PATCH_GRID requires patch_px and token_cap.' })
```

Qwen-VL and GLM-4.1V are patch grids bounded by **pixel area**, not by a token cap. `token_cap` is null, so the refinement fires and the row cannot be seeded. `bound_type` appeared twice in the annex prose and zero times in either Zod file.

**Fixed structurally, not with another refinement.** A patch grid is a discriminated union on `bound_type`:

```ts
{ bound_type: 'TOKEN_CAP',  token_cap }                        // Claude shape
{ bound_type: 'AREA_CLAMP', min_area_px, max_area_px }         // Qwen / GLM shape
```

Neither can be null-filled into the other's shape. This matters beyond validation: the two bounds have **opposite cost behaviour** — a token cap saturates, so an oversized image is cheap and lossy; an area clamp does not, so the same image is expensive and faithful. A router comparing them on price alone, without the source dimensions, will be wrong about which is cheaper.

### 3. A geometry could be seeded without its own parameters

The old refinements caught this imperatively and only for some geometries. Now every geometry is a union member carrying exactly its own fields — a `TILE_GRID` cannot be missing `per_tile_tokens` and silently price every image at `base_tokens`, because the field is required on that member and a null `value` must arrive tagged `UNAVAILABLE` / `NONE`.

---

## Enum reconciliation

### `Method`

| Value | was in registry.schema.ts | A15 §11 | estimate-output.json |
|---|:--:|:--:|:--:|
| `EXACT_TOKENIZER` | ✓ | ✓ | ✓ |
| `PROVIDER_COUNT_API` | ✓ | ✓ | ✓ |
| `PROVIDER_FORMULA` | ✓ | ✓ | — |
| `TOKENIZER_SCALED` | ✓ | — | — |
| `CALIBRATED_HEURISTIC` | ✓ | ✓ | ✓ |
| `EXACT_PROXY` | ✓ | ✓ | — |
| `USER_SUPPLIED` | ✓ | ✓ | ✓ |
| `DERIVED` | ✓ | ✓ | — |
| `MEASURED_BENCHMARK` | — | — | ✓ |
| **`MEASURED_PROBE`** | — | — | — |
| `UNAVAILABLE` | ✓ | ✓ | ✓ |

Kept as a superset. `TOKENIZER_SCALED` and `MEASURED_BENCHMARK` are real distinct cases, not duplicates of `DERIVED`. **`MEASURED_PROBE` is new** — the geometry probe produced results with no method tag at all, which meant a measured constant entered the system indistinguishable from a documented one.

### `Confidence`

`NONE` existed only in `registry.schema.ts`, with no rule attached. Kept, and given one: **`NONE` ⟺ `UNAVAILABLE`**, enforced in both directions. It is not a fourth degree of doubt; it is the tag on a refusal.

### `SourceClass`

Only A15 §11 had it. Kept, extended with `VENDOR_CONFIG` (model cards — a different reliability class from a pricing page) and `MEASURED` (this repo's own harnesses), and the `AGGREGATOR` ≠ `HIGH` refinement retained. `confidenceCeiling()` applies the same cap at the ingestion boundary so a row cannot be promoted after the fact.

---

## What is now enforced rather than documented

| Rule | Spec | Mechanism |
|---|---|---|
| Aggregator never HIGH | §A3.8 | `Provenance` refinement |
| Confidence propagates by minimum | §A3.7 | `minConfidence()` — computed, no field to type into |
| A proxy is capped at LOW | §A4.1 | `Provenance` refinement |
| Every value except a refusal is traceable | §A3.1 | `source_url` refinement |
| A manual override has a named owner | §A4.2 | `verified_by` refinement |
| MoE weights use total params | §A5.9 | `ModelRow.superRefine` |
| Open weights need the VRAM gate fields | §A5.9 | `ModelRow.superRefine` |
| A quality score needs a source | §A6 | `ModelRow.superRefine` |
| Subscription ⇒ non-comparable | §A5.10 | `superRefine` + `rankingEligibility()` |
| A probe fit is evidence, not an entry | §A4.6.1 | `probeFitIsSeedable()` returns a verdict, writes nothing |
| Schemas are generated, not authored | §A2 | `generate-schemas.ts --check` in CI |

---

## New fields, by section

**§A5.2 vision** — `bound_type` + `min_area_px` / `max_area_px`; `BLOCK_GRID_SEP` with `block_px`, `per_block_tokens`, `sep_tokens_per_row`, `sep_constant`, `global_view_included`, `max_blocks`, `candidate_resolutions[]`, `tie_break_rule_known`; `LowDetailBehaviour` as its own union so *flat on low* is structural; `max_context_tokens` on the vision constraints so the context gate can be raised from **visual** tokens.

**§A5.10 request-level** — `ServiceTierProfile` (per provider, with `excludes` and `unavailable_in_regions`); `residency_uplift_pct`; `CacheProfile.storage_rate_per_hour`; `tool_use_system_prompt_tokens[]`; `server_tool_fees[]`; `bills_failed_generations`; `input_rate_by_modality` replacing a single input rate.

**§A5.7** — `context_tiers` is **nullable** (some providers include full long context at the standard rate) and each tier carries `applies_to_whole_request`.

**§A5.9.1 VLM sizing** — `kv_heads` alongside `attention_heads` so the ~7× GQA error is visible in the data, not just the docs; `params_b_total` / `params_b_active` / `is_moe`; `kv_dtype` separate from `weight_dtype`; `prefill_throughput_tps`; `image_activation_buffer_gb`; `served_quantization` on the row, because a provider serving FP8 is not serving the same artifact as one serving BF16.

**§A7 image** — `per_output_token` as a fourth pricing dimension, with `output_tokens_by_resolution[]`.

---

## Wiring it up

```jsonc
// package.json
{
  "scripts": {
    "generate:schemas": "tsx scripts/generate-schemas.ts",
    "check:schemas":    "tsx scripts/generate-schemas.ts --check",
    "test":             "vitest run"
  }
}
```

```yaml
# CI — must run before anything consumes the contracts
- run: pnpm check:schemas    # fails on drift
- run: pnpm test
```

Prove the gate works once, by hand: edit a generated `.json`, run `pnpm check:schemas`, watch it go red. A gate nobody has seen fail is a gate nobody trusts.

**Order:** land this, delete the two superseded files, then re-point `verify-rates.ts`, `calibrate-scripts.ts` and the probe's seeding step at `@tokenomics/contracts`. Only then start `/packages/estimator` — it consumes all of this.
