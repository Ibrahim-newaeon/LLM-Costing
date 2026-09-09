// /packages/estimator/src/fx.ts
//
// §A4.2 — a converted price is only as current as its conversion.
//
// `rateFreshness` asks whether the RATE was re-checked recently enough. On a
// non-USD row that is half the question: the vendor's list price can be unchanged
// for a year while the exchange rate that turned it into dollars has moved. The
// contract has required `fx_rate_used` + `fx_rate_date` since it was written and,
// until `fxFreshness`, nothing read the date — the same defect `rateInForce` was
// written for, one field along.
//
// The predicate lives in `@tokenomics/contracts` beside `rateFreshness`, because it
// is a pure question about a `Rate`. The WARNING lives here, because `estimate.ts`
// in the contracts package imports `pricing.ts`, so building an `EstimateWarning`
// there would close a cycle — and producing warnings is the estimator's job anyway.

import { fxFreshness, type EstimateWarning, type Rate } from '@tokenomics/contracts';

/**
 * The warning a stale or unpolicied conversion earns, or null when the rate is USD
 * or its conversion is inside the row's own window.
 *
 * Returned rather than thrown. A moved exchange rate makes a price wrong, not
 * unrepresentable, and the estimate should say so beside the number rather than
 * refuse to produce one — unlike a missing rate, which blocks.
 */
export function fxStaleWarning(r: Rate, now: Date = new Date()): EstimateWarning | null {
  const f = fxFreshness(r, now);
  if (f === 'FRESH') return null;
  const detail =
    f === 'STALE'
      ? `converted on ${r.fx_rate_date} at ${r.fx_rate_used}, older than this row's own ${r.max_age_days}-day policy`
      : f === 'NO_POLICY'
        ? 'converted with no staleness policy recorded on the row, so nothing says how old is too old'
        : 'converted with no usable conversion date';
  return {
    code: 'STALE_FX_RATE',
    message:
      `This ${r.list_currency} rate reaches the estimate in USD, ${detail}. ` +
      "The vendor's list price and the dollars it becomes go stale independently.",
    severity: 'WARN',
  };
}

/** Every distinct stale-conversion warning across the rates an estimate priced against. */
export function fxStaleWarnings(
  rates: readonly Rate[],
  now: Date = new Date(),
): EstimateWarning[] {
  const seen = new Set<string>();
  const out: EstimateWarning[] = [];
  for (const r of rates) {
    const w = fxStaleWarning(r, now);
    if (w === null || seen.has(w.message)) continue;
    seen.add(w.message);
    out.push(w);
  }
  return out;
}
