// /packages/estimator/src/conflict.ts
//
// Rule 5, read back. `Rate.conflict` has been on the contract since the rate was
// written — "set when another source disagrees beyond tolerance" — and until this
// file **nothing read it**. The fourth field found by the same grep that found
// `effective_from`, `fx_rate_date` and `deprecation_date`: a slot the ingest
// pipeline could fill and an estimate would price straight through, both sources
// shown to nobody.
//
// The warning is BLOCKING. Not because the number is unusable — the registry's own
// rate is still the one priced against, and the estimate still renders — but
// because §A3 rule 5 says an unresolved conflict marks `needs_human_review`, and
// `assembleEstimate` derives that flag from exactly one thing on the warning
// channel: severity. WARN would show the sentence and leave the flag false, which
// is the conflict being reported and then not acted on.
//
// Sibling of `fx.ts` for the same reason it is not in the contracts: the predicate
// is a question about a `Rate`, the warning is the estimator's to raise.

import type { EstimateWarning, Rate } from '@tokenomics/contracts';

/**
 * The warning an unresolved conflict earns, or null when the rate carries none or
 * a human has already resolved it. A resolved conflict stays on the row as history
 * and is deliberately silent here.
 */
export function rateConflictWarning(r: Rate): EstimateWarning | null {
  const c = r.conflict;
  if (c === null || c.resolved) return null;
  const sign = c.delta_pct >= 0 ? '+' : '';
  return {
    code: 'RATE_CONFLICT_UNRESOLVED',
    message:
      `This rate (${r.amount} ${r.unit} ${r.list_currency}, ${r.provenance.source_url ?? 'no url'}) ` +
      `disagrees with ${c.competing_source_url}, which states ${c.competing_amount} ` +
      `(${sign}${c.delta_pct}%). Both are shown; neither was averaged and nobody has yet ` +
      'decided which is right (rule 5). The estimate is priced at the registry figure.',
    severity: 'BLOCKING',
  };
}

/** Every distinct unresolved-conflict warning across the rates an estimate priced against. */
export function rateConflictWarnings(rates: readonly Rate[]): EstimateWarning[] {
  const seen = new Set<string>();
  const out: EstimateWarning[] = [];
  for (const r of rates) {
    const w = rateConflictWarning(r);
    if (w === null || seen.has(w.message)) continue;
    seen.add(w.message);
    out.push(w);
  }
  return out;
}
