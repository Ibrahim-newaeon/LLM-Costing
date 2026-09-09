// /packages/estimator/src/context.ts
//
// Context-window tier pricing (§A5.7). A step function, not a flat rate.
//
//   rate = tiers.find(t => total_input_tokens <= t.upper_bound).rate
//
// The part that matters is `applies_to_whole_request`. Where crossing a threshold
// reprices EVERY token rather than the overflow, the step is far larger than a
// marginal reading suggests — and a small prompt trim can produce an outsized
// saving. Sizing that saving on the overflow alone understates it by orders of
// magnitude on a long request.

import type { ContextTier, EstimateWarning, Rate } from '@tokenomics/contracts';

/** Default proximity band for the near-threshold warning. Config, not a constant. */
export const TIER_PROXIMITY_WARN_PCT = 0.1;

export interface TierSelection {
  status: 'SELECTED';
  tier: ContextTier;
  index: number;
  input_rate: Rate;
  output_rate: Rate;
  /** Set when the request sits within the proximity band below the next threshold. */
  near_threshold: {
    upper_bound_tokens: number;
    headroom_tokens: number;
    /** Fraction of the tier's ceiling still unused. */
    headroom_fraction: number;
  } | null;
  /**
   * §A11 found this one: `near_threshold` was computed correctly, had a passing
   * test, and reached no estimate — because the module said it in its own shape and
   * nothing translated. The code now travels with the sentence that explains it.
   */
  warnings: EstimateWarning[];
}

export type TierResult =
  | TierSelection
  | { status: 'NO_TIERS' }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * Which tier a request lands in.
 *
 * `NO_TIERS` is distinct from a failure: most models include their full context at
 * the standard rate, and `context_tiers: null` means exactly that. Returning a
 * synthesized single tier instead would invent a threshold nobody published.
 */
export function selectContextTier(
  tiers: readonly ContextTier[] | null,
  totalInputTokens: number,
  proximityPct: number = TIER_PROXIMITY_WARN_PCT,
): TierResult {
  if (tiers === null || tiers.length === 0) return { status: 'NO_TIERS' };
  if (totalInputTokens < 0) {
    return { status: 'UNAVAILABLE', reason: 'total input tokens must be >= 0.' };
  }

  // Ordered ascending, with at most one unbounded tier and it must be last.
  const bounds = tiers.map((t) => t.upper_bound_tokens);
  const unboundedAt = bounds.indexOf(null);
  if (unboundedAt !== -1 && unboundedAt !== tiers.length - 1) {
    return {
      status: 'UNAVAILABLE',
      reason: 'An unbounded context tier must be last; anything after it is unreachable.',
    };
  }
  for (let i = 1; i < bounds.length; i++) {
    const prev = bounds[i - 1];
    const cur = bounds[i];
    if (prev !== null && cur !== null && cur <= prev) {
      return {
        status: 'UNAVAILABLE',
        reason: `Context tiers must ascend by upper_bound_tokens; tier ${i} does not.`,
      };
    }
  }

  const index = tiers.findIndex(
    (t) => t.upper_bound_tokens === null || totalInputTokens <= t.upper_bound_tokens,
  );
  if (index === -1) {
    return {
      status: 'UNAVAILABLE',
      reason:
        `${totalInputTokens} input tokens exceeds every published context tier and no unbounded ` +
        'tier exists. The request does not fit; that is a refusal, not a top-tier price.',
    };
  }

  const tier = tiers[index]!;
  const bound = tier.upper_bound_tokens;
  const near =
    bound !== null && totalInputTokens > bound * (1 - proximityPct)
      ? {
          upper_bound_tokens: bound,
          headroom_tokens: bound - totalInputTokens,
          headroom_fraction: (bound - totalInputTokens) / bound,
        }
      : null;

  const warnings: EstimateWarning[] = [];
  if (near !== null) {
    // Not a rounding nicety. §A5.7's tiers reprice the WHOLE request, so a prompt
    // sitting just under a bound is one edit away from roughly doubling — and the
    // trim that avoids it is smaller than the saving by an order of magnitude.
    warnings.push({
      code: 'NEAR_CONTEXT_TIER_THRESHOLD',
      message:
        `${near.headroom_tokens} tokens of headroom below the ${near.upper_bound_tokens}-token ` +
        'threshold. Crossing it reprices the whole request at the next tier, not just the overflow.',
      severity: 'WARN',
    });
  }

  return {
    status: 'SELECTED',
    tier,
    index,
    input_rate: tier.input_rate,
    output_rate: tier.output_rate,
    near_threshold: near,
    warnings,
  };
}

export interface TierCrossingSaving {
  /** Tokens that must be trimmed to drop below the threshold. */
  trim_tokens: number;
  /** Tokens repriced by the drop — the whole request, or just the overflow. */
  repriced_tokens: number;
  applies_to_whole_request: boolean;
  /** Per-token rate difference between the two tiers, in the rate's own units. */
  rate_delta_per_token: number;
  saving: number;
}

/**
 * What trimming below the next threshold down would actually save.
 *
 * The whole point of `applies_to_whole_request`: when it is true, dropping a tier
 * reprices every token in the request, so a trim of a few hundred tokens can save a
 * fraction of the ENTIRE input cost. When false, only the overflow is repriced and
 * the saving is small. Reporting the marginal figure in the first case understates
 * the lever badly enough to make the recommendation useless.
 *
 * Returns null when there is no cheaper tier below, or when either rate is missing —
 * a saving computed from a missing rate would be a fabricated number.
 */
export function contextTierCrossingSaving(
  tiers: readonly ContextTier[],
  currentIndex: number,
  totalInputTokens: number,
): TierCrossingSaving | null {
  if (currentIndex <= 0 || currentIndex >= tiers.length) return null;

  const current = tiers[currentIndex]!;
  const lower = tiers[currentIndex - 1]!;
  const lowerBound = lower.upper_bound_tokens;
  if (lowerBound === null) return null;

  const trim = totalInputTokens - lowerBound;
  if (trim <= 0) return null;

  // Rates are only comparable in the same unit and currency; comparing across them
  // would be arithmetic on unlike quantities.
  if (
    current.input_rate.unit !== lower.input_rate.unit ||
    current.input_rate.list_currency !== lower.input_rate.list_currency
  ) {
    return null;
  }

  const delta = current.input_rate.amount - lower.input_rate.amount;
  if (delta <= 0) return null;

  const repriced = current.applies_to_whole_request ? lowerBound : totalInputTokens - lowerBound;

  return {
    trim_tokens: trim,
    repriced_tokens: repriced,
    applies_to_whole_request: current.applies_to_whole_request,
    rate_delta_per_token: delta,
    saving: delta * repriced,
  };
}
