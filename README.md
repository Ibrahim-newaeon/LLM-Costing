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
| `packages/contracts/` | Zod contracts — the canonical shapes. The only code that exists today |
| `schemas/` | Three hand-authored JSON Schemas. **Not** produced by the generator — see below |
| `prompts/analyzer.system.md` | Runtime analyzer system prompt; ships at `/prompts/` in the built app |
| `docs/` | Findings from the 2026-09-07 review pass |

### Deliberately left behind

Both live in the old `Token Cost Calculator` folder and were not carried over:

- **`TOKENOMICS_MEGA_PROMPT_PART_A.md`** — a copy of `SPEC.md`'s §A0–§A14 with no generator
  and no gate. Every drift site found in the review appeared in both files at a constant
  six-line offset. One source now; regenerate the paste when it is needed.
- **`reference/tokenomics-reference.html`** — 142 KB, published, and carrying the stalest enum
  lists in the project (8 drift sites). Carrying it forward would import that drift. Regenerate
  it from `SPEC.md` when there is a generator, or stamp it with the commit it came from.

## State, honestly

`packages/contracts` is the only thing built. Nothing consumes it yet — no estimator, no
tokenizers, no router, no UI. The package manifests in this repo are new scaffolding; run
`pnpm add -D zod zod-to-json-schema tsx vitest typescript -F @tokenomics/contracts` to
resolve real versions rather than inventing them.

Note: `scripts/generate-schemas.ts` uses `__dirname`, so the contracts package is intentionally
**not** `"type": "module"`.

### The generated set and the authored set are disjoint

`generate-schemas.ts` emits four files:

```
registry.schema.json   model-row.schema.json   vision-profile.schema.json   provenance.schema.json
```

`schemas/` currently holds three entirely different ones:

```
estimate-output.schema.json   pricing-record.schema.json   workflow-input.schema.json
```

No overlap. So `pnpm check:schemas` today reports all four targets as *missing — never
generated*, and never inspects the three files that exist. `MIGRATION.md`'s instruction to
"regenerate" those three cannot be carried out: the Zod shapes they describe —
`EstimateOutput`, `WorkflowInput`, a pricing record — **do not exist in `packages/contracts`**.

That is the real gap. The contracts model *provenance* — where a number came from and how far
to trust it. They do not yet model the *estimate* itself, its inputs, or its assumptions.

## Open queue

1. **Add the missing contract layer** — `EstimateOutput`, `WorkflowInput`, a pricing record,
   and the assumption axis (`Assumption`, `impact_if_wrong`, `sensitivity_rank`, `impact`,
   `deployment_mode`), then add them to the generator's `TARGETS`. See `docs/drift-sweep.md` §5.
2. **Four prose fixes in `SPEC.md`** — §A3 (`Method` 5 of 11, `Confidence` missing `NONE`),
   §A3.8 (`SourceClass` missing `VENDOR_CONFIG`, `MEASURED`), §A7 (`per_output_token`),
   §A14 (calibration buckets). Line numbers in `docs/drift-sweep.md`.
3. **§A7 needs a fact, not an edit** — the prose says image generation is "not per token"; the
   contract has `per_output_token`. One of them is wrong.
4. **Paste the VERIFY resolutions into §A4.1** — all three are closed with sources in
   `docs/verify-resolution.md`.
5. **Prove the gate.** Once the generator has real targets, edit a generated file by hand and
   watch `check:schemas` go red. A gate nobody has seen fail is a gate nobody trusts.
6. **Then** delete the superseded files per `MIGRATION.md`, re-point `verify-rates.ts` /
   `calibrate-scripts.ts` / the probe at `@tokenomics/contracts`, and start `/packages/estimator`.
7. **Optional, high leverage** — `docs/mcp-surface-a16.md` specs an MCP server so an agent can
   price its own call before dispatching it.

## Build order

Contracts (Zod canonical, JSON Schema generated with a CI drift gate)
→ estimator (pure functions, fully unit-tested)
→ tokenizers (§A4.5 tiers) + Layer 0 parser (§A4.4)
→ pricing ingestion → registry → router → UI → e2e.

**Estimator before UI.** The math is the product.
