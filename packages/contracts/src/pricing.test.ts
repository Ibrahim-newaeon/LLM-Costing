// /packages/contracts/src/pricing.test.ts
//
// The staleness gate is how rule 2 — "refuse, don't guess" — becomes executable.
// Everything else in this package describes a number; `rateFreshness` is the thing
// that decides whether a number may be priced against at all, so its four states
// each get a named test, including the two that a boolean would have collapsed.
//
// The negative cases matter more than the positive ones.
//
//   pnpm vitest src/pricing.test.ts     # offline, free

import { describe, it, expect } from 'vitest';
import { Rate, RateConflict, rateFreshness, isPriceable, DeploymentMode } from './pricing';

const prov = (over: Partial<any> = {}) => ({
  method: 'PROVIDER_FORMULA' as const,
  confidence: 'HIGH' as const,
  source_class: 'VENDOR_PAGE' as const,
  source_url: 'https://example.invalid/pricing',
  verified_at: '2026-09-01T00:00:00.000Z',
  verified_by: null,
  notes: null,
  ...over,
});

const rate = (over: Partial<any> = {}) =>
  Rate.parse({
    amount: 3,
    unit: 'per_1m_tokens',
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_to: null,
    provenance: prov(),
    ...over,
  });

const AT_30_DAYS = new Date('2026-10-01T00:00:00.000Z');

/* ══════════════ the staleness gate — four states, not a boolean ══════════════ */

describe('rateFreshness distinguishes the states a boolean would merge', () => {
  it('UNVERIFIED — nobody ever checked this rate against its source', () => {
    const r = rate({ max_age_days: 30, provenance: prov({ verified_at: null }) });
    expect(rateFreshness(r, AT_30_DAYS)).toBe('UNVERIFIED');
  });

  it('NO_POLICY — verified, but no staleness policy was ever recorded', () => {
    // Distinct from FRESH on purpose: we do not know when this stops being true.
    const r = rate({ max_age_days: null });
    expect(rateFreshness(r, AT_30_DAYS)).toBe('NO_POLICY');
  });

  it('a null max_age_days is NOT read as "never stale"', () => {
    expect(rateFreshness(rate({ max_age_days: null }), AT_30_DAYS)).not.toBe('FRESH');
  });

  it('FRESH — verified inside its own policy window', () => {
    const r = rate({ max_age_days: 30 });
    expect(rateFreshness(r, AT_30_DAYS)).toBe('FRESH');
  });

  it('STALE — one second past the window blocks, it does not annotate (§A3.2)', () => {
    const r = rate({ max_age_days: 30 });
    expect(rateFreshness(r, new Date('2026-10-01T00:00:01.000Z'))).toBe('STALE');
  });

  it('the boundary is inclusive — exactly max_age_days old is still FRESH', () => {
    // Guards the `>` in the comparison. A `>=` here would expire every rate a
    // full day early and produce refusals nobody could explain.
    const r = rate({ max_age_days: 30 });
    expect(rateFreshness(r, AT_30_DAYS)).toBe('FRESH');
    expect(rateFreshness(r, new Date('2026-09-30T23:59:59.000Z'))).toBe('FRESH');
  });

  it('UNVERIFIED wins over NO_POLICY when both apply', () => {
    const r = rate({ max_age_days: null, provenance: prov({ verified_at: null }) });
    expect(rateFreshness(r, AT_30_DAYS)).toBe('UNVERIFIED');
  });
});

describe('the unparseable-date branch is reachable, and therefore worth keeping', () => {
  it('an unparseable verified_at degrades to UNVERIFIED rather than NaN', () => {
    // Rate.parse cannot produce this — `verified_at` is z.string().datetime().
    // But rateFreshness takes a typed Rate, and §A2 makes the estimator PURE:
    // rates arrive as arguments, with nothing forcing a parse at that boundary.
    // So this branch guards the realistic path, not the validated one.
    const unparsed = { ...rate({ max_age_days: 30 }), provenance: prov({ verified_at: 'last Tuesday' }) } as any;
    expect(rateFreshness(unparsed, AT_30_DAYS)).toBe('UNVERIFIED');
  });

  it('never returns a state derived from NaN arithmetic', () => {
    const unparsed = { ...rate({ max_age_days: 1 }), provenance: prov({ verified_at: '' }) } as any;
    // NaN > 1 is false, so without the guard this would silently report FRESH.
    expect(rateFreshness(unparsed, AT_30_DAYS)).not.toBe('FRESH');
  });
});

describe('isPriceable admits exactly one state', () => {
  it('only FRESH may be priced against', () => {
    expect(isPriceable('FRESH')).toBe(true);
    for (const f of ['STALE', 'UNVERIFIED', 'NO_POLICY'] as const) {
      expect(isPriceable(f), `${f} must not be priceable`).toBe(false);
    }
  });
});

/* ══════════════ rule 5 — conflicts are reported, not merged ══════════════ */

describe('a conflict is recorded on the rate, and does not resolve itself', () => {
  it('defaults to unresolved — a human decides, not the ingester', () => {
    const c = RateConflict.parse({
      competing_record_id: 'rec_002',
      competing_amount: 3.5,
      competing_source_url: 'https://example.invalid/other',
      delta_pct: 16.7,
    });
    expect(c.resolved).toBe(false);
  });

  it('a rate carries no conflict until one is found', () => {
    expect(rate().conflict).toBeNull();
  });

  it('freshness and conflict are orthogonal — a disputed rate is not a stale one', () => {
    // Rule 5 says surface both values and flag review. It does not say block.
    // Conflating the two would silently turn every disagreement into a refusal.
    const r = rate({
      max_age_days: 30,
      conflict: {
        competing_record_id: 'rec_002',
        competing_amount: 3.5,
        competing_source_url: 'https://example.invalid/other',
        delta_pct: 16.7,
        resolved: false,
      },
    });
    expect(rateFreshness(r, AT_30_DAYS)).toBe('FRESH');
  });
});

/* ══════════════ §A4.2 — native currency is the source of truth ══════════════ */

describe('a non-USD rate cannot be stored without its conversion evidence', () => {
  it('rejects a CNY rate with no fx_rate_used / fx_rate_date', () => {
    expect(() => rate({ list_currency: 'CNY' })).toThrow();
  });

  it('accepts it once the conversion is dated and sourced', () => {
    const r = rate({
      list_currency: 'CNY',
      fx_rate_used: 7.09,
      fx_rate_date: '2026-09-01T00:00:00.000Z',
      fx_source_url: 'https://example.invalid/fx',
    });
    expect(r.list_currency).toBe('CNY');
  });

  it('USD needs no fx evidence', () => {
    expect(rate().list_currency).toBe('USD');
  });
});

/* ══════════════ deployment mode ══════════════ */

describe('DeploymentMode', () => {
  it('carries the three modes that change which cost terms exist at all', () => {
    for (const m of ['API_MANAGED', 'SELF_HOSTED', 'DEDICATED_CAPACITY']) {
      expect(DeploymentMode.parse(m)).toBe(m);
    }
  });

  it('rejects an unlisted mode rather than passing it through', () => {
    expect(() => DeploymentMode.parse('SERVERLESS')).toThrow();
  });
});
