// /packages/ingest/src/compare.ts
//
// §A4.2 / rule 5 — the two-source diff. A registry rate (read by a human from the
// vendor's page) against an observation (read by an adapter from an aggregator).
// Seven outcomes, because "they disagree" is the least informative thing this
// function could say and most of what it finds is not that.
//
// It never chooses. A CONFLICT comes back with a ready-to-attach `RateConflict`
// whose `resolved` is false, and the registry figure stays the one priced against
// until a human says otherwise.

import { RateConflict, type ModelRow, type Observation, type RateKey, type RateObservation, type RateUnit } from '@tokenomics/contracts';
import { locateRate } from './locate';

export type ComparisonOutcome =
  /** Same figure to within float noise. */
  | 'AGREE'
  /** Different figure, inside the caller's tolerance. Reported so a drift can be watched. */
  | 'WITHIN_TOLERANCE'
  /** Different figure, beyond tolerance. Rule 5 — both shown, neither averaged. */
  | 'CONFLICT'
  /** Registry has the slot and never sourced it. A lead for a human, capped at MEDIUM if it were ever used. */
  | 'REGISTRY_UNSOURCED'
  /** The row has no such slot — a tier boundary the registry does not draw, a variant it does not carry. */
  | 'NO_SLOT'
  /** Different units or currencies. Never converted; never compared. */
  | 'NOT_COMPARABLE'
  /** Registry says free, source says not. No finite percentage exists; reported without one. */
  | 'ZERO_BASE';

export interface RateComparison {
  model_id: string;
  key: RateKey;
  outcome: ComparisonOutcome;
  /** Where on the row the figure lives, when the row has the slot. */
  path: string | null;
  registry: { amount: number; unit: RateUnit; currency: string; source_url: string | null } | null;
  observed: { amount: number; unit: RateUnit; currency: string; source_url: string | null };
  /** Signed, relative to the registry amount, in the registry's unit. Null unless both exist and the base is non-zero. */
  delta_pct: number | null;
  reason: string;
  /** Populated on CONFLICT only. `resolved: false` — this function does not decide. */
  conflict: RateConflict | null;
}

/**
 * Per-token scale of each token unit. Anything else is null: a per-image rate
 * and a per-token rate are not two spellings of one number.
 */
const TOKENS_PER_UNIT: Partial<Record<RateUnit, number>> = {
  per_token: 1,
  per_1k_tokens: 1_000,
  per_1m_tokens: 1_000_000,
};

/**
 * Two doubles that are the same published figure can differ in the last bit after
 * rescaling. Below this they are the same figure; it is not a tolerance on prices.
 */
const FLOAT_NOISE_PCT = 1e-9;

/**
 * Significant digits kept at the display boundary — a rescaled competing amount,
 * a percentage. The comparison itself runs on the unrounded values; what is stored
 * is "kept for display, not for choosing" (RateConflict.delta_pct), and
 * 24.999999999999993% is float residue, not information.
 */
const DISPLAY_PRECISION = 12;
export const forDisplay = (n: number): number => Number(n.toPrecision(DISPLAY_PRECISION));

export function perToken(amount: number, unit: RateUnit): number | null {
  const scale = TOKENS_PER_UNIT[unit];
  return scale === undefined ? null : amount / scale;
}

/**
 * Compare every RATE observation about a row against the row.
 *
 * `tolerance_pct` is required and has no default. §A3 names it
 * `PRICE_CONFLICT_TOLERANCE_PCT` and gives it no value; a default here would be a
 * policy nobody wrote down, applied to every conflict.
 */
export function compareRates(
  row: ModelRow,
  observations: readonly Observation[],
  tolerance_pct: number,
): RateComparison[] {
  if (!Number.isFinite(tolerance_pct) || tolerance_pct < 0) {
    throw new Error(`tolerance_pct must be a finite non-negative number; got ${tolerance_pct}.`);
  }
  const out: RateComparison[] = [];
  for (const o of observations) {
    if (o.kind !== 'RATE' || o.model_id !== row.model_id) continue;
    out.push(compareOne(row, o, tolerance_pct));
  }
  return out;
}

function compareOne(row: ModelRow, o: RateObservation, tolerance_pct: number): RateComparison {
  const observed = { amount: o.amount, unit: o.unit, currency: o.currency, source_url: o.provenance.source_url };
  const located = locateRate(row, o.key);
  const base = { model_id: row.model_id, key: o.key, observed, conflict: null, delta_pct: null };

  if (located.status === 'NO_SLOT') {
    return { ...base, outcome: 'NO_SLOT', path: null, registry: null, reason: located.reason };
  }
  if (located.status === 'UNSOURCED') {
    return {
      ...base,
      outcome: 'REGISTRY_UNSOURCED',
      path: located.path,
      registry: null,
      reason: `Registry never sourced ${located.path}; the source states ${o.amount} ${o.unit} ${o.currency}. A lead to verify on the vendor's page, not a value to write.`,
    };
  }

  const r = located.rate;
  const registry = { amount: r.amount, unit: r.unit, currency: r.list_currency, source_url: r.provenance.source_url };
  const withReg = { ...base, path: located.path, registry };

  if (r.list_currency !== o.currency) {
    return { ...withReg, outcome: 'NOT_COMPARABLE', reason: `Registry quotes ${r.list_currency}, source quotes ${o.currency}. Not converted (§A4.2).` };
  }
  const regPerToken = perToken(r.amount, r.unit);
  const obsPerToken = perToken(o.amount, o.unit);
  if (regPerToken === null || obsPerToken === null) {
    return { ...withReg, outcome: 'NOT_COMPARABLE', reason: `Registry unit ${r.unit} and source unit ${o.unit} are not both token units.` };
  }
  if (regPerToken === 0) {
    return obsPerToken === 0
      ? { ...withReg, outcome: 'AGREE', delta_pct: 0, reason: 'Both state zero.' }
      : { ...withReg, outcome: 'ZERO_BASE', reason: `Registry states 0; source states ${o.amount} ${o.unit}. No finite percentage exists for a move away from free.` };
  }

  const rawDelta = ((obsPerToken - regPerToken) / regPerToken) * 100;
  if (Math.abs(rawDelta) < FLOAT_NOISE_PCT) {
    return { ...withReg, outcome: 'AGREE', delta_pct: 0, reason: 'Same figure.' };
  }
  const delta_pct = forDisplay(rawDelta);
  if (Math.abs(rawDelta) <= tolerance_pct) {
    return { ...withReg, outcome: 'WITHIN_TOLERANCE', delta_pct, reason: `Differs by ${delta_pct}%, inside the ${tolerance_pct}% tolerance.` };
  }

  // Rule 5. The competing amount is rescaled into the registry's unit so the two
  // figures on the row read in one unit — arithmetic on a published figure,
  // rounded once at this boundary.
  const scale = TOKENS_PER_UNIT[r.unit]!;
  const competing_amount = forDisplay(obsPerToken * scale);
  const conflict = RateConflict.parse({
    competing_record_id: o.snapshot_id,
    competing_amount,
    competing_source_url: o.provenance.source_url,
    delta_pct,
    resolved: false,
  });
  return {
    ...withReg,
    outcome: 'CONFLICT',
    delta_pct,
    conflict,
    reason: `Registry states ${r.amount} ${r.unit}; source states ${competing_amount} ${r.unit} (${delta_pct > 0 ? '+' : ''}${delta_pct}%), beyond the ${tolerance_pct}% tolerance. Both kept; neither averaged (rule 5).`,
  };
}
