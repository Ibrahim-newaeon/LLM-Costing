import { describe, it, expect } from 'vitest';
import { CacheProfile, Rate } from '@tokenomics/contracts';
import { evaluateCache } from './cache';

const prov = {
  method: 'PROVIDER_FORMULA',
  confidence: 'HIGH',
  source_class: 'VENDOR_PAGE',
  source_url: 'https://example.invalid/pricing',
  verified_at: '2026-09-01T00:00:00.000Z',
  verified_by: null,
  notes: null,
};
// Parsed, not hand-rolled: Rate carries defaults (list_currency 'USD' among them)
// and a fixture that skips them compares unequal against one that does not.
const rate = (amount: number, unit = 'per_1m_tokens') =>
  Rate.parse({
    amount,
    unit,
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_to: null,
    provenance: prov,
  });
const src = (value: unknown) => ({ value, provenance: prov });

const profile = (over: Record<string, unknown> = {}) =>
  CacheProfile.parse({
    write_rate: rate(3.75),
    read_rate: rate(0.3),
    min_cacheable_tokens: src(1024),
    ttl_seconds: src(300),
    ...over,
  });

const base = {
  input_rate: rate(3),
  prefix_tokens: 10_000,
  variable_tokens: 500,
  hit_ratio: 0.9,
  hit_ratio_basis: 'fixed system prompt and tool block reused across calls',
  calls: 1000,
};

describe('evaluateCache', () => {
  it('saves money at a high hit ratio', () => {
    const r = evaluateCache({ ...base, profile: profile() });
    if (r.status !== 'EVALUATED') throw new Error('expected EVALUATED');
    expect(r.net_saving).toBeGreaterThan(0);
    expect(r.cached_cost).toBeLessThan(r.uncached_cost);
  });

  it('LOSES money at a low hit ratio when writes carry a premium', () => {
    const r = evaluateCache({ ...base, profile: profile(), hit_ratio: 0.05 });
    if (r.status !== 'EVALUATED') throw new Error('expected EVALUATED');
    expect(r.net_saving).toBeLessThan(0);
    expect(r.warnings.join(' ')).toContain('PREMIUM');
  });

  it('refuses a hit ratio with no stated basis — that is how caching looks free', () => {
    const r = evaluateCache({ ...base, profile: profile(), hit_ratio_basis: '   ' });
    expect(r.status).toBe('UNAVAILABLE');
  });

  it('returns the hit ratio as an editable assumption, never a silent default', () => {
    const r = evaluateCache({ ...base, profile: profile() });
    if (r.status !== 'EVALUATED') throw new Error('expected EVALUATED');
    expect(r.assumptions).toHaveLength(1);
    expect(r.assumptions[0]!.field).toBe('cache_hit_ratio');
    expect(r.assumptions[0]!.user_editable).toBe(true);
    expect(r.assumptions[0]!.impact_if_wrong).toBe('HIGH');
  });

  it('reports NOT_CACHEABLE below the minimum prefix', () => {
    const r = evaluateCache({ ...base, profile: profile(), prefix_tokens: 500 });
    expect(r.status).toBe('NOT_CACHEABLE');
  });

  it('blocks on an unpublished cache rate rather than treating it as free', () => {
    const r = evaluateCache({ ...base, profile: profile({ read_rate: null }) });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toContain('not zero');
  });

  it('refuses to mix units', () => {
    const r = evaluateCache({
      ...base,
      profile: profile({ read_rate: rate(0.3, 'per_1k_tokens') }),
    });
    expect(r.status).toBe('UNAVAILABLE');
  });
});

describe('§A5.10 — the hourly storage term', () => {
  const hourly = () => profile({ storage_rate_per_hour: rate(1) });

  it('requires hours_cached when the provider bills storage', () => {
    const r = evaluateCache({ ...base, profile: hourly() });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toContain('hours_cached');
  });

  it('shows a long-lived cache on a low-traffic workload as a NET LOSS', () => {
    // 5 calls against a cache held for 24h. The read saving is 4.5 x 10k x (3 - 0.3)
    // = 121,500; the storage charge is 24 x 10k x 1 = 240,000. Storage alone is
    // nearly twice the entire benefit. This is the case the pre-v2.0 cache model
    // could not express, because it had no storage term at all.
    //
    // At 10 calls this is still a net loss, but the culprit is the write premium
    // rather than storage — a different diagnosis, and the estimator distinguishes
    // them because the fixes differ: raise the hit ratio, or shorten the TTL.
    const r = evaluateCache({
      ...base, profile: hourly(), calls: 5, hours_cached: 24, hit_ratio: 0.9,
    });
    if (r.status !== 'EVALUATED') throw new Error('expected EVALUATED');
    expect(r.storage_dominates).toBe(true);
    expect(r.net_saving).toBeLessThan(0);
    expect(r.warnings.join(' ')).toContain('net loss');
  });

  it('the same cache pays for itself at high volume', () => {
    const r = evaluateCache({
      ...base, profile: hourly(), calls: 100_000, hours_cached: 24, hit_ratio: 0.9,
    });
    if (r.status !== 'EVALUATED') throw new Error('expected EVALUATED');
    expect(r.storage_dominates).toBe(false);
    expect(r.net_saving).toBeGreaterThan(0);
  });
});
