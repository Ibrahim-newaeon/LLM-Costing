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
| `prototype/` | Working Vite/React prototype recovered from `~/llm-token-calculator`. Reference only — see `docs/prototype-salvage.md` |
| `reference/` | The published reference page. **Stale** — 8 drift sites, no generator. Kept so it is not lost, not because it is current |
| `docs/` | Findings from the 2026-09-07 review pass |

### Dropped

**`TOKENOMICS_MEGA_PROMPT_PART_A.md`** was not carried over. Checked line by line against
`SPEC.md` before the old folder was deleted: of its 1,106 lines, 20 were unique, and all 20 were
the preamble describing what Part A is. No spec content was lost. Regenerate the single-paste
version from `SPEC.md` when it is needed.

## State, honestly

`packages/contracts` is the only thing built. Nothing consumes it yet — no estimator, no
tokenizers, no router, no UI.

The toolchain was stood up on 2026-09-07, and as of that date everything here has actually been
run rather than merely read:

| Command | Result, 2026-09-07 |
|---|---|
| `pnpm typecheck` | 0 errors — TypeScript 7.0.2, `strict` |
| `pnpm test` | 29 passed, 1 file (`src/registry.test.ts`) — first execution ever |
| `pnpm check:schemas` | green; the four generated targets match the Zod |
| gate proof | injected `PRETTY_SURE` into the generated `Confidence` enum → red, file named; regenerate → green |

Resolved versions live in `pnpm-lock.yaml`. Use `corepack pnpm install`. The lockfile is
portable; `node_modules` is not — it is built for whatever platform ran the install.

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

The generator now uses zod 4's built-in `z.toJSONSchema`, which also removes the dependency.
`zod-to-json-schema` is still declared in `packages/contracts/package.json` and imported by
nothing; drop it with `pnpm remove zod-to-json-schema -F @tokenomics/contracts`.

Two generator options encode decisions worth revisiting:

- **`io: 'input'`** — these schemas describe a document as it *arrives* (a registry file, an
  ingested pricing row), before Zod applies `.default()`. The contracts lean hard on defaults,
  so input and output shapes genuinely differ: under `'output'` every defaulted field would be
  reported as required, which no source document has to satisfy.
- **`reused: 'ref'`** — shared subschemas are extracted to `$defs` rather than inlined at every
  use site. Registry renders at 81 KB with 63 defs; inlined it was 429 KB, which no reviewer can
  read a drift diff of. The cost: zod names them `__schema0…__schemaN` **positionally**, so
  inserting one field renumbers the rest and a one-line change produces a large diff. Registering
  ids on the exported schemas would give them real names. Open.

`unrepresentable` is left at its default, `'throw'` — a shape JSON Schema cannot express should
fail the build, not be silently widened to `{}`.

### The generated set and the authored set are still disjoint

`generate-schemas.ts` emits four files. As of 2026-09-07 they exist, are correct, and are gated:

```
registry.schema.json   model-row.schema.json   vision-profile.schema.json   provenance.schema.json
```

`schemas/` also holds three hand-authored files that no generator produces:

```
estimate-output.schema.json   pricing-record.schema.json   workflow-input.schema.json
```

No overlap. The gate now guards four real files and still ignores the three the app would
actually use. `MIGRATION.md`'s instruction to "regenerate" those three cannot be carried out: the
Zod shapes they describe — `EstimateOutput`, `WorkflowInput`, a pricing record — **do not exist
in `packages/contracts`**.

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

## Build order

Contracts (Zod canonical, JSON Schema generated with a CI drift gate)
→ estimator (pure functions, fully unit-tested)
→ tokenizers (§A4.5 tiers) + Layer 0 parser (§A4.4)
→ pricing ingestion → registry → router → UI → e2e.

**Estimator before UI.** The math is the product.
