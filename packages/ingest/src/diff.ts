// /packages/ingest/src/diff.ts
//
// §A4.2 — "diff each pull against the prior snapshot and emit a PriceChangeEvent
// when a rate moves". Two observation sets from the SAME source; nothing here
// compares a source to the registry (that is compare.ts) or one source to another.

import { PriceChangeEvent, type EstimateWarning, type Observation, type RateKey, type RateObservation } from '@tokenomics/contracts';
import { forDisplay } from './compare';

const rateKeyId = (o: RateObservation): string =>
  `${o.model_id}|${o.key.direction}|${o.key.modality ?? '-'}|${o.key.variant}|${o.key.above_tokens ?? '-'}`;

const onlyRates = (obs: readonly Observation[]): Map<string, RateObservation> => {
  const m = new Map<string, RateObservation>();
  for (const o of obs) if (o.kind === 'RATE') m.set(rateKeyId(o), o);
  return m;
};

/**
 * What moved. Emitted in a stable order — by key id — so two runs over the same
 * inputs produce the same list and a diff of the diff is readable.
 */
export function diffObservations(
  previous: readonly Observation[],
  current: readonly Observation[],
): PriceChangeEvent[] {
  const prev = onlyRates(previous);
  const curr = onlyRates(current);
  const ids = [...new Set([...prev.keys(), ...curr.keys()])].sort();
  const out: PriceChangeEvent[] = [];

  for (const id of ids) {
    const p = prev.get(id);
    const c = curr.get(id);
    if (p && !c) {
      out.push(event(p.model_id, p.key, 'REMOVED', p.unit, p.currency, p.amount, null, p.snapshot_id, null));
      continue;
    }
    if (!p && c) {
      out.push(event(c.model_id, c.key, 'ADDED', c.unit, c.currency, null, c.amount, null, c.snapshot_id));
      continue;
    }
    if (!p || !c) continue;
    if (p.unit !== c.unit || p.currency !== c.currency) {
      // Not one figure that moved — a figure that was restated in another unit.
      // Two events, so nobody reads a per-1k → per-token change as a 1000× cut.
      out.push(event(p.model_id, p.key, 'REMOVED', p.unit, p.currency, p.amount, null, p.snapshot_id, null));
      out.push(event(c.model_id, c.key, 'ADDED', c.unit, c.currency, null, c.amount, null, c.snapshot_id));
      continue;
    }
    if (p.amount === c.amount) continue;
    out.push(event(c.model_id, c.key, 'CHANGED', c.unit, c.currency, p.amount, c.amount, p.snapshot_id, c.snapshot_id));
  }
  return out;
}

function event(
  model_id: string,
  key: RateKey,
  change: PriceChangeEvent['change'],
  unit: PriceChangeEvent['unit'],
  currency: string,
  previous_amount: number | null,
  current_amount: number | null,
  previous_snapshot_id: string | null,
  current_snapshot_id: string | null,
): PriceChangeEvent {
  const delta_pct =
    change === 'CHANGED' && previous_amount !== null && current_amount !== null && previous_amount !== 0
      ? forDisplay(((current_amount - previous_amount) / previous_amount) * 100)
      : null;
  return PriceChangeEvent.parse({
    model_id, key, change, unit, currency, previous_amount, current_amount, delta_pct, previous_snapshot_id, current_snapshot_id,
  });
}

const describeKey = (k: RateKey): string =>
  `${k.direction}${k.modality ? ` (${k.modality})` : ''}${k.variant !== 'standard' ? ` [${k.variant}]` : ''}${k.above_tokens !== null ? ` above ${k.above_tokens} tokens` : ''}`;

/**
 * The warning each event earns on an estimate made after it. WARN, not BLOCKING:
 * the estimate is priced at the registry's vendor-sourced rate, and what changed
 * is a feed the registry is checked against. The banner §A4.2 asks for is this
 * list, rendered.
 */
export function priceChangeWarnings(events: readonly PriceChangeEvent[]): EstimateWarning[] {
  return events.map((e) => {
    const what =
      e.change === 'CHANGED'
        ? `moved from ${e.previous_amount} to ${e.current_amount} ${e.unit} ${e.currency}` +
          (e.delta_pct === null ? ' (from zero; no finite percentage)' : ` (${e.delta_pct > 0 ? '+' : ''}${e.delta_pct}%)`)
        : e.change === 'ADDED'
          ? `appeared at ${e.current_amount} ${e.unit} ${e.currency}`
          : `disappeared (was ${e.previous_amount} ${e.unit} ${e.currency})`;
    return {
      code: 'PRICE_CHANGED_SINCE_LAST_RUN',
      message: `${e.model_id} ${describeKey(e.key)} ${what} between ${e.previous_snapshot_id ?? 'no prior snapshot'} and ${e.current_snapshot_id ?? 'the current pull'}. Re-verify the registry row against the vendor's page before quoting.`,
      severity: 'WARN',
    };
  });
}
