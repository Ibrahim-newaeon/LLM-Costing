// /packages/estimator/src/output.ts
//
// Output and reasoning tokens (§A5.4) — the non-deterministic half.
//
//   output_tokens    ~ Distribution(p50, p90, cap = max_tokens)
//   reasoning_tokens ~ Distribution(p50, p90)      // reasoning-capable models only
//   billable_output  = output_tokens + reasoning_tokens
//
// You cannot know these before the call, which is exactly why rule 3 exists: this is
// the term that makes a range mandatory rather than decorative.
//
// Two things here are refusals rather than estimates.
//
// REASONING TOKENS ARE INVISIBLE BUT BILLED. On a model flagged `is_reasoning_model`
// they are frequently the larger half of the bill, and they do not appear in the
// response text — only in `usage.completion_tokens_details`. A reasoning model with
// no reasoning prior therefore blocks: treating an unmeasured invisible term as zero
// is the most expensive silent error available in this file.
//
// AND max_tokens IS A CLAMP, NOT A FORECAST. Clamping p90 down to the cap makes the
// estimate look tighter while the real risk moves elsewhere — the output gets
// TRUNCATED. So the clamp is applied to what is billed, and the fact that the cap
// bites is raised as MAX_TOKENS_BELOW_P90 rather than hidden in a smaller number.

import {
  findOutputPrior,
  type Confidence,
  type Method,
  type OutputBand,
  type OutputPrior,
  type Range,
  type WarningCode,
} from '@tokenomics/contracts';

export interface OutputEstimateInput {
  model_id: string;
  band: OutputBand;
  priors: readonly OutputPrior[];
  is_reasoning_model: boolean;
  /** The configured cap, or null when the caller set none. */
  max_tokens: number | null;
  /**
   * Whether this provider counts reasoning tokens against `max_tokens`.
   *
   * Required, with no default, because providers differ and the answer changes the
   * result: if reasoning counts against the cap, visible output is squeezed rather
   * than the bill growing. Guessing it would be guessing a provider fact (rule 1).
   */
  max_tokens_includes_reasoning: boolean;
}

export interface OutputEstimate {
  status: 'ESTIMATED';
  /** What is billed: visible output plus reasoning, after the cap is applied. */
  billable_output: Range;
  visible_output: Range;
  reasoning: Range | null;
  /** True where the cap bites at p90 — i.e. truncation is likely. */
  truncation_likely: boolean;
  method: Method;
  confidence: Confidence;
  warnings: WarningCode[];
  notes: string[];
}

export interface OutputUnavailable {
  status: 'UNAVAILABLE';
  reason: string;
  missing_data: { field: string; why_it_matters: string; blocks_estimate: true };
}

export type OutputResult = OutputEstimate | OutputUnavailable;

const blocked = (field: string, why: string): OutputUnavailable => ({
  status: 'UNAVAILABLE',
  reason: why,
  missing_data: { field, why_it_matters: why, blocks_estimate: true },
});

export function estimateOutputTokens(input: OutputEstimateInput): OutputResult {
  const { model_id, band, priors, is_reasoning_model, max_tokens } = input;

  const prior = findOutputPrior(priors, model_id, band);
  if (prior === null) {
    return blocked(
      `output_prior[${model_id}/${band}]`,
      `No calibrated output prior for the "${band}" band on ${model_id}. §A5.4 requires priors ` +
        'measured from observed runs, not invented, so there is no number to give here yet. ' +
        'Capture `usage` from real responses and this fills in.',
    );
  }

  // §A5.4 — mandatory, and the reason it is mandatory is that the term is invisible.
  if (is_reasoning_model && prior.reasoning_tokens === null) {
    return blocked(
      `output_prior[${model_id}/${band}].reasoning_tokens`,
      `${model_id} is a reasoning model and its prior carries no reasoning distribution. ` +
        'Reasoning tokens are invisible in the response but billed, and are often the larger ' +
        'half of the bill — omitting the term would understate the cost silently. Populate it ' +
        'from usage.completion_tokens_details.',
    );
  }

  const warnings: WarningCode[] = [];
  const notes: string[] = [];

  const visibleRaw: Range = { ...prior.output_tokens, p99: null };
  const reasoningRaw: Range | null =
    prior.reasoning_tokens === null ? null : { ...prior.reasoning_tokens, p99: null };

  // The cap applies to whatever the provider counts against it.
  let visible = visibleRaw;
  let reasoning = reasoningRaw;

  if (max_tokens !== null) {
    if (input.max_tokens_includes_reasoning && reasoning !== null) {
      // Reasoning eats the budget first; visible output gets what is left. This is
      // the case where a low cap silently shortens the answer instead of the bill.
      const capVisible = (r: number, think: number) => Math.max(0, Math.min(r, max_tokens - think));
      visible = {
        p50: capVisible(visibleRaw.p50, reasoning.p50),
        p90: capVisible(visibleRaw.p90, reasoning.p90),
        p99: null,
      };
      reasoning = {
        p50: Math.min(reasoning.p50, max_tokens),
        p90: Math.min(reasoning.p90, max_tokens),
        p99: null,
      };
      if (visible.p90 < visibleRaw.p90) {
        notes.push(
          `Reasoning counts against max_tokens on this provider, so the ${max_tokens}-token cap ` +
            `leaves only ${visible.p90} for visible output at p90 (prior says ${visibleRaw.p90}).`,
        );
      }
    } else {
      visible = {
        p50: Math.min(visibleRaw.p50, max_tokens),
        p90: Math.min(visibleRaw.p90, max_tokens),
        p99: null,
      };
    }

    if (visibleRaw.p90 > max_tokens) {
      // The spec's wording: "your cap is below P90, expect truncation".
      warnings.push('MAX_TOKENS_BELOW_P90');
      notes.push(
        `max_tokens is ${max_tokens} but the calibrated p90 output is ${visibleRaw.p90}. ` +
          'Expect truncation. The clamp lowers the BILL, not the risk.',
      );
    }
  } else if (band === 'unbounded') {
    // No cap and no bound is not an estimate, it is an open cheque.
    return blocked(
      'max_tokens',
      'The output band is "unbounded" and no max_tokens is configured, so nothing bounds the ' +
        'output cost. §A5.4 requires the clamp; without it the p90 is unfalsifiable.',
    );
  }

  if (reasoning !== null) {
    // Even a calibrated reasoning term is an estimate of something nobody can see.
    warnings.push('REASONING_TOKENS_ESTIMATED');
  }

  const billable: Range = {
    p50: visible.p50 + (reasoning?.p50 ?? 0),
    p90: visible.p90 + (reasoning?.p90 ?? 0),
    p99: null,
  };

  if (prior.seed_provenance === 'SEED_UNCALIBRATED') {
    notes.push(
      `This prior is a seed with ${prior.n_samples} samples behind it, so it is LOW until ` +
        'observed runs replace it.',
    );
  }

  return {
    status: 'ESTIMATED',
    billable_output: billable,
    visible_output: visible,
    reasoning,
    truncation_likely: max_tokens !== null && visibleRaw.p90 > max_tokens,
    method: prior.provenance.method,
    confidence: prior.provenance.confidence,
    warnings,
    notes,
  };
}
