// /packages/estimator/src/conflict.test.ts
//
// Rule 5, read back: `Rate.conflict` reaches the warning channel.
//
//   pnpm vitest src/conflict.test.ts     # offline, free

import { describe, it, expect } from 'vitest';
import { Rate } from '@tokenomics/contracts';
import { rateConflictWarning, rateConflictWarnings } from './conflict';

const prov = () => ({
  method: 'PROVIDER_FORMULA',
  confidence: 'HIGH',
  source_class: 'VENDOR_DOCS',
  source_url: 'https://example.invalid/vendor-pricing',
  verified_at: '2026-09-01T00:00:00.000Z',
});

/** SYNTHETIC. The competing figure is the vendor figure doubled, to exercise the path. */
const conflict = (over: Record<string, unknown> = {}) => ({
  competing_record_id: 'aggregator@2026-09-09',
  competing_amount: 10,
  competing_source_url: 'https://example.invalid/aggregator.json',
  delta_pct: 100,
  ...over,
});

const rate = (over: Record<string, unknown> = {}) =>
  Rate.parse({
    amount: 5,
    unit: 'per_1m_tokens',
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_to: null,
    max_age_days: 30,
    provenance: prov(),
    ...over,
  });

describe('an unresolved conflict is a warning; a resolved one is history', () => {
  it('no conflict, no warning — a guard that fires on good input gets deleted', () => {
    expect(rateConflictWarning(rate())).toBeNull();
  });

  it('an unresolved conflict is BLOCKING, names both figures and both sources, and says nothing was averaged', () => {
    const w = rateConflictWarning(rate({ conflict: conflict() }))!;
    expect(w.code).toBe('RATE_CONFLICT_UNRESOLVED');
    expect(w.severity).toBe('BLOCKING');
    expect(w.message).toContain('5 per_1m_tokens USD');
    expect(w.message).toContain('https://example.invalid/vendor-pricing');
    expect(w.message).toContain('states 10');
    expect(w.message).toContain('https://example.invalid/aggregator.json');
    expect(w.message).toContain('+100%');
    expect(w.message).toContain('neither was averaged');
  });

  it('a negative delta keeps its sign', () => {
    const w = rateConflictWarning(rate({ conflict: conflict({ competing_amount: 2.5, delta_pct: -50 }) }))!;
    expect(w.message).toContain('(-50%)');
  });

  it('a resolved conflict stays on the row and is silent', () => {
    expect(rateConflictWarning(rate({ conflict: conflict({ resolved: true }) }))).toBeNull();
  });

  it('the same conflict on two rates (input and image share a figure) warns once', () => {
    const c = conflict();
    const ws = rateConflictWarnings([rate({ conflict: c }), rate({ conflict: c }), rate()]);
    expect(ws).toHaveLength(1);
  });
});
