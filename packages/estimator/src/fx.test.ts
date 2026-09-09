// /packages/estimator/src/fx.test.ts
//
// §A4.2 — the vendor's list price and the dollars it becomes go stale separately.
//
//   pnpm vitest src/fx.test.ts     # offline, free

import { describe, it, expect } from 'vitest';
import { Rate, fxFreshness } from '@tokenomics/contracts';
import { fxStaleWarning, fxStaleWarnings } from './fx';

const prov = (over: Record<string, unknown> = {}) => ({
  method: 'PROVIDER_FORMULA',
  confidence: 'HIGH',
  source_class: 'VENDOR_DOCS',
  source_url: 'https://example.invalid/pricing',
  verified_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

const cny = (over: Record<string, unknown> = {}) =>
  Rate.parse({
    amount: 21,
    unit: 'per_1m_tokens',
    list_currency: 'CNY',
    fx_rate_used: 0.14,
    fx_rate_date: '2026-09-01T00:00:00.000Z',
    max_age_days: 30,
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_to: null,
    provenance: prov(),
    ...over,
  });

const usd = () =>
  Rate.parse({
    amount: 3,
    unit: 'per_1m_tokens',
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_to: null,
    max_age_days: 30,
    provenance: prov(),
  });

const AT = (iso: string) => new Date(iso);

describe('a conversion goes stale on its own schedule', () => {
  it('a USD rate converted nothing, so there is nothing to go stale', () => {
    expect(fxFreshness(usd(), AT('2030-01-01T00:00:00.000Z'))).toBe('FRESH');
    expect(fxStaleWarning(usd(), AT('2030-01-01T00:00:00.000Z'))).toBeNull();
  });

  it('inside the row’s own window it is FRESH and silent', () => {
    expect(fxFreshness(cny(), AT('2026-09-20T00:00:00.000Z'))).toBe('FRESH');
    expect(fxStaleWarning(cny(), AT('2026-09-20T00:00:00.000Z'))).toBeNull();
  });

  it('past it, STALE — and the window is the row’s OWN max_age_days, not a number we picked', () => {
    expect(fxFreshness(cny(), AT('2026-10-15T00:00:00.000Z'))).toBe('STALE');
    const w = fxStaleWarning(cny(), AT('2026-10-15T00:00:00.000Z'))!;
    expect(w.code).toBe('STALE_FX_RATE');
    expect(w.message).toMatch(/30-day policy/);
    // A moved exchange rate makes a price wrong, not unrepresentable. Unlike a
    // missing rate, it warns beside the number rather than blocking it.
    expect(w.severity).toBe('WARN');
  });

  it('a FRESH rate can carry a STALE conversion — the two checks are independent', () => {
    // Verified this morning, converted in January. `rateFreshness` is satisfied and
    // the dollars are three-quarters of a year old. Nothing read fx_rate_date until
    // now, which is the same defect `rateInForce` was written for, one field along.
    const r = cny({
      fx_rate_date: '2026-01-05T00:00:00.000Z',
      provenance: prov({ verified_at: '2026-09-09T00:00:00.000Z' }),
    });
    expect(fxFreshness(r, AT('2026-09-09T12:00:00.000Z'))).toBe('STALE');
    expect(fxStaleWarning(r, AT('2026-09-09T12:00:00.000Z'))!.code).toBe('STALE_FX_RATE');
  });

  it('no policy on the row is not the same as fresh', () => {
    const r = cny({ max_age_days: null });
    expect(fxFreshness(r, AT('2030-01-01T00:00:00.000Z'))).toBe('NO_POLICY');
    expect(fxStaleWarning(r, AT('2030-01-01T00:00:00.000Z'))!.message).toMatch(/how old is too old/);
  });

  it('deduplicates across the rates one estimate priced against', () => {
    const at = AT('2026-10-15T00:00:00.000Z');
    const ws = fxStaleWarnings([cny(), cny(), usd()], at);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.code).toBe('STALE_FX_RATE');
  });
});
