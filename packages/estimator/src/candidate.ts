// /packages/estimator/src/candidate.ts
//
// Assembly (§A5.8). Turning priced components into a Candidate the contracts accept.
//
// The canonical formula is written with a cache CREDIT:
//
//   API_COST = billable_input x input_rate
//            + billable_output x output_rate
//            + image_tokens x image_rate
//            - cached_tokens x (input_rate - cache_read_rate)
//            + cache_write_tokens x cache_write_rate
//            + per_request_fees
//
// This module produces the algebraically identical DECOMPOSITION instead: bill the
// uncached tokens at the input rate and the cached ones at the read rate, as two
// separate lines. Not a stylistic choice — `EstimateLine.cost` is a Range with
// nonnegative bounds, so a credit line cannot be represented, and a line-item
// breakdown that shows a negative row is harder to read anyway. Same total.
//
//   uncached x input + cached x read  ==  (uncached + cached) x input
//                                          - cached x (input - read)
//
// §A3.7 is enforced by the contract itself: `Candidate.confidence` must EQUAL
// minConfidence over its lines. This module computes it rather than accepting one,
// so a caller cannot assert a confidence the lines do not support.

import {
  EstimateLine,
  Candidate,
  minConfidence,
  type Confidence,
  type CostComponent,
  type CostUnit,
  type DeploymentMode,
  type Method,
  type Range,
  type Tier,
} from '@tokenomics/contracts';
import { exactRange } from './range';

/* ─────────────────────────── line building ─────────────────────────── */

export interface LineInput {
  task_id: string;
  component: CostComponent;
  quantity: Range | null;
  unit: CostUnit | null;
  /** Per-unit price in the rate's own unit. Null only for a refusal. */
  rate_amount: number | null;
  rate_record_id: string | null;
  method: Method;
  confidence: Confidence;
  tier?: 0 | 1 | 2 | 3 | null;
  context_safety_quantity?: number | null;
  note?: string | null;
}

/**
 * One priced line. Cost is quantity x rate at both ends of the band.
 *
 * A refusal (`method: 'UNAVAILABLE'`) carries no cost and no rate, which the
 * contract requires and which is the point: a line the engine could not price
 * appears in the breakdown as a refusal rather than vanishing or reading as zero.
 */
export function buildLine(input: LineInput): EstimateLine {
  const isRefusal = input.method === 'UNAVAILABLE';

  const cost: Range | null =
    isRefusal || input.quantity === null || input.rate_amount === null
      ? null
      : {
          p50: input.quantity.p50 * input.rate_amount,
          p90: input.quantity.p90 * input.rate_amount,
          p99: input.quantity.p99 === null ? null : input.quantity.p99 * input.rate_amount,
        };

  return EstimateLine.parse({
    task_id: input.task_id,
    component: input.component,
    quantity: input.quantity,
    unit: input.unit,
    rate_record_id: isRefusal ? null : input.rate_record_id,
    cost,
    context_safety_quantity: input.context_safety_quantity ?? null,
    method: input.method,
    tier: input.tier ?? null,
    tokenizer_proxy: null,
    cache: null,
    confidence: isRefusal ? 'NONE' : input.confidence,
    note: input.note ?? null,
  });
}

/* ─────────────────────────── assembly ─────────────────────────── */

export interface CandidateInput {
  model_id: string;
  provider_id: string;
  provider_tier?: Tier | null;
  deployment_mode: DeploymentMode;
  currency: string;
  lines: readonly EstimateLine[];
  data_residency_region?: string | null;
  is_prc_hosted?: boolean | null;
  display_currency?: string | null;
  fx_rate_ref?: string | null;
  self_hosted_detail?: unknown;
}

/**
 * Sum the lines into a Candidate.
 *
 * Confidence is COMPUTED here, never passed in. A HIGH token count multiplied by an
 * UNAVAILABLE rate is not a HIGH estimate — it is not an estimate at all — and the
 * contract rejects any candidate whose confidence exceeds its weakest line.
 *
 * A candidate with no lines is NONE rather than HIGH by vacuity.
 */
export function assembleCandidate(input: CandidateInput): Candidate {
  const total = input.lines.reduce<Range>(
    (acc, l) => ({
      p50: acc.p50 + (l.cost?.p50 ?? 0),
      p90: acc.p90 + (l.cost?.p90 ?? 0),
      p99: null,
    }),
    { p50: 0, p90: 0, p99: null },
  );

  const confidence = input.lines.length
    ? minConfidence(...input.lines.map((l) => l.confidence))
    : 'NONE';

  return Candidate.parse({
    model_id: input.model_id,
    provider_id: input.provider_id,
    tier: input.provider_tier ?? null,
    deployment_mode: input.deployment_mode,
    data_residency_region: input.data_residency_region ?? null,
    is_prc_hosted: input.is_prc_hosted ?? null,
    lines: input.lines,
    total_tokens: tokenTotals(input.lines),
    total_cost: total,
    currency: input.currency,
    display_currency: input.display_currency ?? null,
    fx_rate_ref: input.fx_rate_ref ?? null,
    self_hosted_detail: input.self_hosted_detail ?? null,
    confidence,
  });
}

/** Token subtotals by destination, for the UI. Only token-denominated lines count. */
function tokenTotals(lines: readonly EstimateLine[]) {
  const INPUT: CostComponent[] = [
    'prompt_input', 'framing_overhead', 'tool_schema', 'conversation_history', 'image_tiles',
  ];
  const sum = (want: CostComponent[]): Range | null => {
    const rows = lines.filter(
      (l) => want.includes(l.component) && l.unit === 'tokens' && l.quantity !== null,
    );
    if (rows.length === 0) return null;
    return rows.reduce<Range>(
      (acc, l) => ({ p50: acc.p50 + l.quantity!.p50, p90: acc.p90 + l.quantity!.p90, p99: null }),
      { p50: 0, p90: 0, p99: null },
    );
  };
  return {
    input: sum(INPUT),
    output: sum(['completion_output']),
    reasoning: sum(['reasoning_output']),
    cached: sum(['cache_read']),
  };
}

/**
 * The context-overflow check (§A4.5.5), which is the ONLY consumer of the padded
 * quantities. Deliberately a separate function from anything that prices, so the
 * padded number has no path into a total.
 */
export function contextOverflow(
  lines: readonly EstimateLine[],
  contextWindowTokens: number,
): { fits: boolean; safety_tokens: number; headroom_tokens: number } {
  const safety = lines.reduce(
    (acc, l) => acc + (l.context_safety_quantity ?? (l.unit === 'tokens' ? (l.quantity?.p90 ?? 0) : 0)),
    0,
  );
  return {
    fits: safety <= contextWindowTokens,
    safety_tokens: safety,
    headroom_tokens: contextWindowTokens - safety,
  };
}

/** Sum of exact per-request fees, as a degenerate range. */
export const perRequestFee = (amount: number, calls: number): Range => exactRange(amount * calls);
