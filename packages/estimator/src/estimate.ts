// /packages/estimator/src/estimate.ts
//
// The last box in the chain: candidates, a routing answer and a parse become one
// `EstimateOutput`.
//
// Nothing in this repo built one before. `assembleCandidate` stops at a single
// Candidate, and every EstimateOutput that has existed so far was hand-written in a
// test — which is exactly the condition under which a rule holds in the contracts
// and never holds in the product, because nothing in the product ever reaches the
// shape the contract governs.
//
// Pure, like the rest of this package: `generated_at` is injected, not read from a
// clock, so the same inputs produce the same estimate forever.

import {
  EstimateOutput,
  minConfidence,
  type Assumption,
  type Candidate,
  type Confidence,
  type Evidence,
  type EstimateWarning,
  type ExcludedModel,
  type MissingDatum,
  type Optimization,
  type Recommendations,
  type SystemOverhead,
  type WorkflowInput,
} from '@tokenomics/contracts';

export interface AssembleEstimateInput {
  estimate_id: string;
  /** Injected. This package has no clock — see the note in index.ts. */
  generated_at: string;
  pricing_snapshot_id: string;
  /** What Layer 0 produced. Its assumptions and gaps are the estimate's too. */
  workflow: WorkflowInput;
  candidates: readonly Candidate[];
  /**
   * Router output, taken as contract types rather than as the router's own result
   * shape. `estimator` does not depend on `router`, and a type import would be a
   * dependency edge drawn for one field's convenience.
   */
  recommendations?: Recommendations | null;
  excluded_models?: readonly ExcludedModel[];
  optimization_report?: readonly Optimization[];
  /**
   * §A4.4.1 — parser metering. EMPTY FOR AN L1 PARSE, and that emptiness is the
   * operating metric rather than a field somebody forgot.
   *
   * ⚠️ This is an estimate-level array and it is NOT indexed by candidate. The
   * rule "must not be a per-candidate line" needs no runtime check because
   * `CostComponent` has no member for it — the type system refuses to express the
   * mistake. What IS checked here is the arithmetic consequence: see
   * `system_overhead_is_flat` below.
   */
  system_overhead?: readonly SystemOverhead[];
  /** Signals the modules produced. Merged with the ones derived here. */
  warnings?: readonly EstimateWarning[];
  /** Estimator-side assumptions, merged with the parser's. */
  assumptions?: readonly Assumption[];
  /** Estimator-side gaps, merged with the parser's. */
  missing_data?: readonly MissingDatum[];
  evidence: readonly Evidence[];
}

/** Deduplicate by a key, keeping the first occurrence, so a merge is stable. */
function dedupe<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * §A3.7 one level up, plus the three derivations the contract will otherwise catch
 * only after somebody has already got them wrong.
 *
 * `confidence` and `needs_human_review` are COMPUTED here and are not parameters.
 * The contract refines on both, so passing them in would mean writing the same
 * derivation twice and waiting for the two copies to disagree — the defect this
 * project keeps finding in its own history.
 */
export function assembleEstimate(input: AssembleEstimateInput): EstimateOutput {
  const assumptions = dedupe(
    [...input.workflow.assumptions, ...(input.assumptions ?? [])],
    // `id` is nullable, so an unidentified assumption falls back to what it is
    // about. Two anonymous guesses at the same field on the same task ARE the same
    // guess; deduping them on identity alone would list one twice and, through
    // §A4.4.4's stacking rule, drop the ceiling for a duplicate nobody made.
    (a) => a.id ?? `${a.task_id ?? ''}|${a.field}`,
  );
  const missing_data = dedupe(
    [...input.workflow.missing_data, ...(input.missing_data ?? [])],
    (m) => `${m.field}|${m.task_id ?? ''}|${m.model_id ?? ''}`,
  );

  // Module signals pass through as they are. A blocking gap is deliberately NOT
  // mirrored into a synthetic warning: `missing_data` already carries it, and
  // stating one fact in two places is how the two copies start to disagree. What
  // reads both is `needs_human_review`, below — one derivation, one answer.
  const warnings = [...(input.warnings ?? [])];

  const confidence: Confidence = input.candidates.length
    ? minConfidence(...input.candidates.map((c) => c.confidence))
    : 'NONE';

  const needs_human_review =
    confidence === 'NONE' ||
    missing_data.some((m) => m.blocks_estimate) ||
    warnings.some((w) => w.severity === 'BLOCKING');

  return EstimateOutput.parse({
    estimate_id: input.estimate_id,
    workflow_id: input.workflow.workflow_id,
    scenario_id: null,
    generated_at: input.generated_at,
    pricing_snapshot_id: input.pricing_snapshot_id,
    candidates: input.candidates,
    recommendations: input.recommendations ?? null,
    excluded_models: input.excluded_models ?? [],
    optimization_report: input.optimization_report ?? [],
    breakeven: null,
    assumptions,
    evidence: input.evidence,
    confidence,
    needs_human_review,
    missing_data,
    warnings,
    system_overhead: input.system_overhead ?? [],
  });
}

/**
 * §A4.4.1's arithmetic, stated as a function so a test can assert it rather than
 * re-implement it: the parse is metered ONCE for the whole estimate, however many
 * models were compared.
 *
 * The rule is easy to state and easy to violate the moment somebody adds a
 * "parser cost" to each candidate so the totals "look right" per model. It would
 * multiply the parse by the size of the comparison set — 10 candidates, 10 parses
 * billed, for one parse that happened.
 */
export function systemOverheadCost(e: EstimateOutput): { p50: number; p90: number } {
  return e.system_overhead.reduce(
    (acc, o) => ({ p50: acc.p50 + (o.cost?.p50 ?? 0), p90: acc.p90 + (o.cost?.p90 ?? 0) }),
    { p50: 0, p90: 0 },
  );
}
