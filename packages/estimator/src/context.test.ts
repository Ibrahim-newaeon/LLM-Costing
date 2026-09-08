import { describe, it, expect } from 'vitest';
import { ContextTier } from '@tokenomics/contracts';
import { selectContextTier, contextTierCrossingSaving } from './context';

const prov = {
  method: 'PROVIDER_FORMULA',
  confidence: 'HIGH',
  source_class: 'VENDOR_PAGE',
  source_url: 'https://example.invalid/pricing',
  verified_at: '2026-09-01T00:00:00.000Z',
  verified_by: null,
  notes: null,
};

const rate = (amount: number) => ({
  amount,
  unit: 'per_1m_tokens',
  effective_from: '2026-01-01T00:00:00.000Z',
  effective_to: null,
  provenance: prov,
});

const tier = (upper: number | null, input: number, output: number, whole = true) =>
  ContextTier.parse({
    upper_bound_tokens: upper,
    input_rate: rate(input),
    output_rate: rate(output),
    applies_to_whole_request: whole,
  });

const TIERS = [tier(200_000, 3, 15), tier(null, 6, 22.5)];

describe('selectContextTier', () => {
  it('distinguishes "no tiers" from a failure', () => {
    expect(selectContextTier(null, 1000).status).toBe('NO_TIERS');
    expect(selectContextTier([], 1000).status).toBe('NO_TIERS');
  });

  it('picks the first tier whose bound the request fits under', () => {
    const r = selectContextTier(TIERS, 150_000);
    if (r.status !== 'SELECTED') throw new Error('expected SELECTED');
    expect(r.index).toBe(0);
    expect(r.input_rate.amount).toBe(3);
  });

  it('crosses into the next tier one token over', () => {
    const under = selectContextTier(TIERS, 200_000);
    const over = selectContextTier(TIERS, 200_001);
    if (under.status !== 'SELECTED' || over.status !== 'SELECTED') throw new Error('expected SELECTED');
    expect(under.input_rate.amount).toBe(3);
    expect(over.input_rate.amount).toBe(6);
  });

  it('warns inside the proximity band, and not outside it', () => {
    const near = selectContextTier(TIERS, 195_000);
    const far = selectContextTier(TIERS, 100_000);
    if (near.status !== 'SELECTED' || far.status !== 'SELECTED') throw new Error('expected SELECTED');
    expect(near.near_threshold?.headroom_tokens).toBe(5_000);
    expect(far.near_threshold).toBeNull();
  });

  it('refuses a request that fits no tier rather than pricing it at the top one', () => {
    const bounded = [tier(100_000, 3, 15)];
    const r = selectContextTier(bounded, 250_000);
    expect(r.status).toBe('UNAVAILABLE');
  });

  it('rejects tiers that do not ascend', () => {
    expect(selectContextTier([tier(200_000, 3, 15), tier(100_000, 6, 22)], 10).status).toBe(
      'UNAVAILABLE',
    );
  });

  it('rejects an unbounded tier that is not last', () => {
    expect(selectContextTier([tier(null, 6, 22), tier(200_000, 3, 15)], 10).status).toBe(
      'UNAVAILABLE',
    );
  });
});

describe('contextTierCrossingSaving — the whole-request step', () => {
  it('reprices EVERY token when applies_to_whole_request is true', () => {
    const s = contextTierCrossingSaving(TIERS, 1, 205_000);
    expect(s).not.toBeNull();
    expect(s!.trim_tokens).toBe(5_000);
    expect(s!.repriced_tokens).toBe(200_000); // the whole request, not the 5k overflow
    expect(s!.saving).toBe(3 * 200_000);
  });

  it('reprices only the overflow when it does not', () => {
    const marginal = [tier(200_000, 3, 15, false), tier(null, 6, 22.5, false)];
    const s = contextTierCrossingSaving(marginal, 1, 205_000);
    expect(s!.repriced_tokens).toBe(5_000);
    expect(s!.saving).toBe(3 * 5_000);
  });

  it('the difference between those two readings is 40x here', () => {
    const whole = contextTierCrossingSaving(TIERS, 1, 205_000)!;
    const marginal = contextTierCrossingSaving(
      [tier(200_000, 3, 15, false), tier(null, 6, 22.5, false)],
      1,
      205_000,
    )!;
    expect(whole.saving / marginal.saving).toBe(40);
  });

  it('returns null when there is no cheaper tier below', () => {
    expect(contextTierCrossingSaving(TIERS, 0, 100)).toBeNull();
  });

  it('refuses to compare rates in different units', () => {
    const mismatched = [
      ContextTier.parse({
        upper_bound_tokens: 200_000,
        input_rate: { ...rate(3), unit: 'per_1k_tokens' },
        output_rate: rate(15),
        applies_to_whole_request: true,
      }),
      tier(null, 6, 22.5),
    ];
    expect(contextTierCrossingSaving(mismatched, 1, 205_000)).toBeNull();
  });
});
