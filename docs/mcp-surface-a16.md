# §A16 — MCP surface

Proposed addendum to Part A. Nothing here replaces an existing section; it adds one consumer.

---

## A16.0 Why this surface

Every surface in the spec so far assumes a person: someone opens the UI, or runs the command,
or reads the report. But the workload being priced is an agent, and the moment worth catching
is the one before it dispatches.

An agent that can call `check_budget` and decline its own plan is a different product from a
calculator a human opens afterwards. Everything needed for it already exists — the estimator,
the contracts, the confidence algebra. What is missing is a shape an agent can act on.

## A16.1 Position

`/packages/mcp` is a **consumer of `@tokenomics/contracts` and `/packages/estimator`.** It
computes nothing. It contains no rate, no tokenizer, no geometry, no fallback path of its own.
If an answer cannot be produced by the estimator, the MCP server does not produce one either.

Build it **after** the estimator and the router, alongside or before the UI.

## A16.2 The verdict — the one new type

A report is for reading. An agent needs a decision, and the decision has to carry the reason
so a human can be shown it later.

```ts
type Verdict =
  | { decision: 'PROCEED';          estimate: EstimateOutput }
  | { decision: 'OVER_BUDGET';      estimate: EstimateOutput; budget: Amount;
                                     exceeded_by: Amount; compared_on: 'P50' | 'P90' }
  | { decision: 'BELOW_CONFIDENCE'; estimate: EstimateOutput; required: Confidence;
                                     actual: Confidence; limiting_line: string }
  | { decision: 'REFUSED';          reason: 'MISSING_RATE' | 'UNKNOWN_MODEL'
                                          | 'MISSING_VISION_PROFILE' | 'NON_COMPARABLE';
                                     missing: string[] };
```

`Amount` is `{ value: number; currency: Currency }` using `Currency` from
`@tokenomics/contracts/pricing`. There is no `Money` type in the package; do not add one.

`REFUSED` is not an error. It is §A3's refusal rule reaching the caller intact — it is
literally `blocksEstimate(c) === 'NONE'` from `provenance.ts`, surfaced as an outcome an agent
can branch on. Compute it with that function; do not re-derive the condition here. **The refusal is the feature.** A cost tool that returns a number when it
has no rate is worse than one that returns nothing, and an agent is exactly the caller most
likely to treat a silent default as fact.

`limiting_line` names the line that set the floor, because `minConfidence()` propagates by
minimum and the caller will want to know which quantity dragged it down.

## A16.3 Tools

| Tool | Input | Returns |
|---|---|---|
| `estimate_workflow` | `WorkflowInput` (the §A4.4 task graph) | `EstimateOutput`, unchanged |
| `check_budget` | `WorkflowInput`, `budget`, `compare_on?`, `min_confidence?` | `Verdict` |
| `compare_models` | `WorkflowInput`, `model_ids[]` | ranked list, `rankingEligibility()` applied |
| `explain_line` | `estimate_id`, `line_id` | method, confidence, `source_url`, `verified_at`, source class |
| `list_models` | filter by provider / confidence / modality | what is seeded and at what confidence |

`list_models` matters more than it looks. An agent that picks a model the registry cannot
price gets a refusal it has no way to anticipate. Let it ask first.

`compare_models` must apply the §A5.10 rule already in the contracts: a subscription-priced
model is **non-comparable**, not cheap. Returning it in a price ranking is the failure that
rule exists to prevent, and an agent sorting on a number will fall into it every time.

`explain_line` is what lets an agent tell a human *why* it stopped. Without it, a refusal is
indistinguishable from a bug.

## A16.4 Gating

- **Compare on P90 by default.** A pre-flight check exists to prevent a bad surprise, and P50
  is the wrong half of the distribution for that. Make it overridable, never silent — the
  verdict carries `compared_on`.
- **`min_confidence` is optional and has no default floor.** When set and unmet, return
  `BELOW_CONFIDENCE` rather than `PROCEED`. This is what lets a team say "no `LOW`-confidence
  numbers gate production spend" without hardcoding that policy into the engine.
- **Never downgrade a refusal into a number.** `REFUSED` outranks every other branch.

## A16.5 Interaction with the count-token rate ceiling

Per VERIFY #1, Anthropic's counting endpoint is free but capped by requests per minute, and
per VERIFY #2 Gemini is remote for all multimodal input. An MCP server called before *every*
agent request is the highest-frequency caller in the system — it will hit that ceiling long
before a human-driven UI would.

Mandatory here, not optional:

1. **Per-run dedupe** by content hash before the cache. An agent loop re-counting an unchanged
   system prompt every round is the common case, not the edge case.
2. **Persistent content-hash cache** across runs.
3. **Expose consumption in telemetry** (§A16.8) so the ceiling is visible before it is hit.

## A16.6 Content boundary

Default transport is **stdio, local**. The server sees message bodies because it runs on the
same machine as the agent.

If it is ever served over HTTP, it accepts a `WorkflowInput` — the §A4.4 task graph, which
carries *quantities*, not prose — and never raw messages. The Layer 0 parser runs client-side.
This falls out of the existing architecture for free: the analyzer/estimator split already
separates the text from the counts. Preserve it deliberately, because a cost tool that ships
customer prompts to a server is a liability shaped exactly wrong, and retrofitting the split
after the transport exists is expensive.

## A16.7 Schemas are generated

MCP tool input schemas are **generated from the Zod contracts**, by the same
`generate-schemas.ts` path, gated by the same `--check` drift rule in CI.

Hand-authoring MCP tool schemas would recreate precisely the defect `MIGRATION.md` closes:
two definitions of one shape, drifting. The verdict union is the only new Zod in this package.

## A16.8 Errors versus refusals

| Situation | Response |
|---|---|
| Missing rate, missing vision profile, unpriceable model | `Verdict.REFUSED` — a valid result |
| Unknown model id, malformed `WorkflowInput`, bad budget | MCP protocol error |

The distinction is load-bearing. A refusal is a fact about the world the caller should surface;
a protocol error is a bug in the caller. Collapsing them teaches an agent to retry a refusal,
which will never succeed and will burn the rate ceiling doing it.

## A16.9 Telemetry

Log every call: tool, model, resulting `method` and `confidence`, P50/P90, verdict, cache
hit/miss, count-API calls consumed. This is the same record the reconciliation loop needs to
compare predicted against billed — the MCP surface is where the highest-volume, most
structured version of that data is produced. Build the log line now even if nothing consumes
it yet.

## A16.10 Tests

- Each `Verdict` branch, including `REFUSED` for a model with no seeded rate.
- `REFUSED` outranks `OVER_BUDGET` when both apply.
- `min_confidence: HIGH` against a `CALIBRATED_HEURISTIC` line → `BELOW_CONFIDENCE`,
  `limiting_line` naming the right line.
- `compare_models` excludes a subscription-priced model from the ranking with `NON_COMPARABLE`.
- Repeated identical prompts in one run consume exactly one count-API call.
- Generated MCP tool schemas fail the CI drift gate when a contract changes without regeneration.
- `explain_line` returns `source_url` and `verified_at` for every non-refused line.

## A16.11 Note on the CLI gate

`check_budget` and a CLI `check` command returning a non-zero exit code are the same verdict
rendered two ways. Build the verdict once; the CLI is a thin renderer over it. That is the
whole of the "linter" framing — a build that fails on an unaffordable or unverifiable estimate.


---

## A16.12 Symbol check (verified against the contracts source, 2026-09-07)

Confirmed present in `@tokenomics/contracts` and used above as-is:
`Method` (11 values), `Confidence` (`HIGH | MEDIUM | LOW | NONE`), `SourceClass`, `Provenance`,
`Sourced<T>` (note: `value: T | null`), `minConfidence()`, `blocksEstimate()`,
`confidenceCeiling()`, `UNAVAILABLE_PROVENANCE`, `ModelRow`, `Registry`,
`rankingEligibility()`, `TokenizerAvailability` (`LOCAL_EXACT | REMOTE_API | PROXY | NONE`),
`Currency`, `Rate`, `ContextTier`, `CacheProfile`, `ServiceTierProfile`.

**Not in contracts:** `EstimateOutput` and `WorkflowInput`. Today they exist only as
hand-authored JSON Schemas under `/schemas`, which `MIGRATION.md` marks for regeneration. This
package must import them from wherever they land after that — most likely `/packages/estimator`
— and must not restate them. The verdict union is the only new Zod here.

`TokenizerAvailability.PROXY` is the exact field VERIFY #3 fills: an ERNIE or Hunyuan hosted
tier is `PROXY` with the open-weight repository recorded as the proxy's source.
