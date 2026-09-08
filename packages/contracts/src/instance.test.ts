// /packages/contracts/src/instance.test.ts
//
// The refinements, not the happy path. Each of these would have passed against a
// plain object and each one is a real invoice error.
//
//   pnpm vitest src/instance.test.ts     # offline, free

import { describe, it, expect } from 'vitest';
import { Provenance } from './provenance';
import {
  InstanceProfile,
  DeploymentPlan,
  instanceHourlyAmount,
  availableVramBytes,
  BYTES_PER_GIB,
} from './instance';

const prov = (over: Partial<any> = {}) =>
  Provenance.parse({
    method: 'PROVIDER_FORMULA',
    confidence: 'HIGH',
    source_class: 'VENDOR_PAGE',
    source_url: 'https://example.invalid/pricing',
    verified_at: '2026-09-08T00:00:00.000Z',
    verified_by: null,
    notes: null,
    ...over,
  });

const s = (value: unknown, over: Partial<any> = {}) => ({ value, provenance: prov(over) });

const rate = (amount: number, unit: string) => ({
  amount,
  unit,
  list_currency: 'USD',
  effective_from: '2026-09-01T00:00:00.000Z',
  effective_to: null,
  provenance: prov(),
});

const instance = (over: Record<string, unknown> = {}) =>
  InstanceProfile.parse({
    instance_id: 'inst-1',
    cloud_provider: 'example-cloud',
    instance_type: 'gpu.8x',
    gpu_model: 'EXAMPLE-GPU',
    gpu_count: 8,
    vram_per_gpu_gib: 79.6,
    gpu_memory_utilization: 0.9,
    hourly_rate_on_demand: rate(4, 'per_gpu_hour'),
    regional_tax_rate: s(0.15),
    egress_gb_per_1k_requests: s(0.02),
    concurrency_efficiency_factor: s(0.6),
    cold_start_seconds: s(45),
    ops_labour_monthly: s(2000),
    instance_source_url: 'https://example.invalid/pricing',
    ...over,
  });

describe('InstanceProfile', () => {
  it('refuses an instance with no price at all', () => {
    expect(() =>
      instance({ hourly_rate_on_demand: null, hourly_rate_spot: null }),
    ).toThrow(/neither an on-demand nor a spot rate/);
  });

  it('refuses a token rate masquerading as an hourly instance rate', () => {
    expect(() => instance({ hourly_rate_on_demand: rate(4, 'per_1m_tokens') })).toThrow(
      /per_gpu_hour or per_instance_hour/,
    );
  });

  it('refuses a storage rate with nothing to multiply it by', () => {
    expect(() =>
      instance({ storage_rate: rate(0.0001, 'per_gb_day'), weights_storage_gb: null }),
    ).toThrow(/weights_storage_gb/);
  });

  it('refuses a storage rate whose unit carries the wrong period', () => {
    expect(() =>
      instance({ storage_rate: rate(3, 'per_gb'), weights_storage_gb: 140 }),
    ).toThrow(/per_gb_day/);
  });
});

describe('instanceHourlyAmount — the 8x error', () => {
  it('multiplies a per-GPU rate by gpu_count', () => {
    const i = instance({ hourly_rate_on_demand: rate(4, 'per_gpu_hour') });
    expect(instanceHourlyAmount(i, 'ON_DEMAND')!.amount).toBe(32);
  });

  it('leaves a per-instance rate alone', () => {
    const i = instance({ hourly_rate_on_demand: rate(32, 'per_instance_hour') });
    expect(instanceHourlyAmount(i, 'ON_DEMAND')!.amount).toBe(32);
  });

  it('returns null rather than falling back to the other basis', () => {
    // Quoting a spot price as though it were guaranteed capacity is the failure
    // this null exists to force the caller to handle.
    const i = instance({ hourly_rate_spot: rate(1.2, 'per_gpu_hour') });
    expect(instanceHourlyAmount(i, 'SPOT')!.amount).toBeCloseTo(9.6, 10);
    expect(instanceHourlyAmount(instance({ hourly_rate_spot: null }), 'SPOT')).toBeNull();
  });
});

describe('availableVramBytes — §A5.9 error 4', () => {
  it('caps the TOTAL footprint, not a reserve for one term', () => {
    const i = instance({ gpu_count: 2, vram_per_gpu_gib: 80, gpu_memory_utilization: 0.9 });
    expect(availableVramBytes(i)).toBe(2 * 80 * BYTES_PER_GIB * 0.9);
  });
});

describe('DeploymentPlan', () => {
  const plan = (over: Record<string, unknown> = {}) =>
    DeploymentPlan.parse({
      instance_id: 'inst-1',
      rate_basis: 'ON_DEMAND',
      expected_requests_per_day: 5000,
      planned_context_tokens: 32_000,
      ...over,
    });

  it('accepts an always-on plan', () => {
    expect(plan().always_on).toBe(true);
  });

  it('refuses a plan that is both always-on and scale-to-zero', () => {
    expect(() => plan({ scale_to_zero: true })).toThrow(/either always-on or scale-to-zero/);
  });

  it('refuses a plan that is neither', () => {
    expect(() => plan({ always_on: false, scale_to_zero: false })).toThrow(
      /either always-on or scale-to-zero/,
    );
  });

  it('refuses scale-to-zero that hides its cold starts', () => {
    expect(() => plan({ always_on: false, scale_to_zero: true })).toThrow(/cold-start count/);
  });
});
