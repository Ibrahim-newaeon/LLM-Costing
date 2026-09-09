// /packages/estimator/src/selfhosted.test.ts
//
// §A5.9 names four errors "in descending size". Each gets a test that would FAIL
// against the obvious wrong implementation, because each of them produces a
// plausible-looking number rather than a crash — that is what makes them expensive.
//
//   pnpm vitest src/selfhosted.test.ts     # offline, free

import { describe, it, expect } from 'vitest';
import { Provenance, InstanceProfile, DeploymentPlan, HardwareProfile, BYTES_PER_GIB } from '@tokenomics/contracts';
import {

  kvGeometryFrom,
  kvCacheBytes,
  clampedContextTokens,
  weightsBytes,
  vramFeasibility,
  throughputFrom,
  requestTiming,
  resolveUtilization,
  selfHostedCost,
  breakevenCrossover,
  bytesToGib,
  DAYS_PER_MONTH,
} from './selfhosted';

/** Warnings are `{code, message, severity}` now, so an assertion reads one half or the other. */
const codes = (ws: readonly { code: string }[]) => ws.map((w) => w.code);
const messages = (ws: readonly { message: string }[]) => ws.map((w) => w.message).join(' ');

const prov = (over: Partial<any> = {}) =>
  Provenance.parse({
    method: 'PROVIDER_FORMULA',
    confidence: 'HIGH',
    source_class: 'VENDOR_PAGE',
    source_url: 'https://example.invalid/docs',
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

/**
 * A GQA model: 64 query heads, 8 KV heads. The numbers are illustrative — this file
 * asserts RELATIONSHIPS between its own inputs and outputs, never that any real
 * model has these dimensions.
 */
const hardware = (over: Record<string, unknown> = {}): HardwareProfile =>
  HardwareProfile.parse({
  params_b_total: 70,
  params_b_active: 70,
  is_moe: false,
  layers: 80,
  kv_heads: 8,
  attention_heads: 64,
  head_dim: 128,
  max_context_tokens: 128_000,
  kv_dtype: 'fp16',
  weight_dtype: 'bf16',
  supports_flash_attention: false,
  supports_paged_attention: true,
  image_activation_buffer_gb: s(4),
  prefill_throughput_tps: s(8000, { method: 'MEASURED_BENCHMARK', confidence: 'MEDIUM' }),
  decode_throughput_tps: s(40, { method: 'MEASURED_BENCHMARK', confidence: 'MEDIUM' }),
  ttft_seconds: s(0.2, { method: 'MEASURED_BENCHMARK', confidence: 'MEDIUM' }),
  architecture_source_url: 'https://example.invalid/config.json',
    ...over,
  });

const instance = (over: Record<string, unknown> = {}) =>
  InstanceProfile.parse({
    instance_id: 'inst-1',
    cloud_provider: 'example-cloud',
    instance_type: 'gpu.8x',
    gpu_model: 'EXAMPLE-GPU',
    gpu_count: 8,
    vram_per_gpu_gib: 80,
    gpu_memory_utilization: 0.9,
    hourly_rate_on_demand: rate(4, 'per_gpu_hour'),
    regional_tax_rate: s(0),
    egress_gb_per_1k_requests: s(0),
    concurrency_efficiency_factor: s(1),
    cold_start_seconds: s(45),
    ops_labour_monthly: s(0),
    instance_source_url: 'https://example.invalid/pricing',
    ...over,
  });

const plan = (over: Record<string, unknown> = {}) =>
  DeploymentPlan.parse({
    instance_id: 'inst-1',
    rate_basis: 'ON_DEMAND',
    expected_requests_per_day: 5000,
    planned_context_tokens: 8_000,
    ...over,
  });

/* ══════════════ ERROR 1 — kv_heads, not attention heads ══════════════ */

describe('error 1: the KV term reads kv_heads and cannot read attention_heads', () => {
  it('sizes the cache on 8 KV heads, not 64 query heads', () => {
    const h = hardware();
    const g = kvGeometryFrom(h);
    expect(g.status).toBe('OK');
    if (g.status !== 'OK') return;

    const actual = kvCacheBytes(g.geometry, 8_000, 1);
    // What the same arithmetic gives if somebody reaches for the query count.
    // `attention_heads` is nullable on the contract; the fixture sets it. The `any`
    // cast used to hide that, which is finding 3.16 in one line.
    const wrong = kvCacheBytes({ ...g.geometry, kv_heads: h.attention_heads! }, 8_000, 1);
    expect(wrong / actual).toBe(8);
    expect(actual).toBe(2 * 80 * 8 * 128 * 2 * 8_000 * 1);
  });

  it('is a no-op distinction on a full multi-head model — which is why it must be read, not assumed', () => {
    const h = hardware({ kv_heads: 64, attention_heads: 64 });
    const g = kvGeometryFrom(h);
    if (g.status !== 'OK') throw new Error('geometry');
    expect(kvCacheBytes(g.geometry, 1_000, 1)).toBe(
      kvCacheBytes({ ...g.geometry, kv_heads: 64 }, 1_000, 1),
    );
  });

  it('refuses rather than defaulting when the model card is missing a head count', () => {
    const g = kvGeometryFrom(hardware({ kv_heads: null }));
    expect(g.status).toBe('UNAVAILABLE');
    if (g.status === 'UNAVAILABLE') expect(g.missing).toContain('kv_heads');
  });

  it('multiplies by batch size', () => {
    const g = kvGeometryFrom(hardware());
    if (g.status !== 'OK') throw new Error('geometry');
    expect(kvCacheBytes(g.geometry, 1_000, 4)).toBe(4 * kvCacheBytes(g.geometry, 1_000, 1));
  });
});

/* ══════════════ ERROR 2 — MoE weights use TOTAL params ══════════════ */

describe('error 2: MoE weights size on total parameters', () => {
  it('uses params_b_total even when an active count is present and much smaller', () => {
    const w = weightsBytes(hardware({ is_moe: true, params_b_total: 141, params_b_active: 39 }));
    expect(w.status).toBe('OK');
    if (w.status !== 'OK') return;
    expect(w.bytes).toBe(141 * 1e9 * 2);
  });

  it('refuses an MoE row with no total rather than falling back to active', () => {
    const w = weightsBytes(hardware({ is_moe: true, params_b_total: null, params_b_active: 39 }));
    expect(w.status).toBe('UNAVAILABLE');
    if (w.status === 'UNAVAILABLE') expect(w.reason).toMatch(/every expert stays resident/);
  });

  it('reads the active count only on a dense model, where it equals the total', () => {
    const w = weightsBytes(hardware({ is_moe: false, params_b_total: null, params_b_active: 70 }));
    expect(w.status).toBe('OK');
    if (w.status === 'OK') expect(w.bytes).toBe(70 * 1e9 * 2);
  });

  it('marks a sub-byte dtype as a lower bound rather than pretending 0.5 is exact', () => {
    const w = weightsBytes(hardware({ weight_dtype: 'int4' }));
    if (w.status !== 'OK') throw new Error('weights');
    expect(w.is_lower_bound).toBe(true);
    expect(w.note).toMatch(/lower bound/);
  });
});

/* ══════════════ ERROR 3 — FlashAttention does not touch the KV cache ══════════════ */

describe('error 3: FlashAttention is absent from the KV term', () => {
  it('toggling supports_flash_attention changes no KV figure', () => {
    const off = vramFeasibility({ hardware: hardware({ supports_flash_attention: false }), instance: instance(), plan: plan() });
    const on = vramFeasibility({ hardware: hardware({ supports_flash_attention: true }), instance: instance(), plan: plan() });
    expect(on.kv_cache_bytes).toBe(off.kv_cache_bytes);
    expect(on.required_bytes).toBe(off.required_bytes);
  });

  it('KV quantization is the lever that does move it', () => {
    const fp16 = vramFeasibility({ hardware: hardware({ kv_dtype: 'fp16' }), instance: instance(), plan: plan() });
    const fp8 = vramFeasibility({ hardware: hardware({ kv_dtype: 'fp8' }), instance: instance(), plan: plan() });
    expect(fp16.kv_cache_bytes! / fp8.kv_cache_bytes!).toBe(2);
  });
});

/* ══════════════ ERROR 4 — gpu_memory_utilization caps the total ══════════════ */

describe('error 4: one budget, all three terms', () => {
  it('compares weights + KV + activations against the single capped figure', () => {
    const i = instance({ gpu_count: 2, vram_per_gpu_gib: 80, gpu_memory_utilization: 0.9 });
    const r = vramFeasibility({ hardware: hardware(), instance: i, plan: plan() });
    expect(r.available_bytes).toBe(2 * 80 * BYTES_PER_GIB * 0.9);
    expect(r.required_bytes).toBe(r.weights_bytes! + r.kv_cache_bytes! + r.activation_bytes!);
  });

  it('is not a reserve: lowering it lowers what everything together may occupy', () => {
    const hi = vramFeasibility({ hardware: hardware(), instance: instance({ gpu_memory_utilization: 0.95 }), plan: plan() });
    const lo = vramFeasibility({ hardware: hardware(), instance: instance({ gpu_memory_utilization: 0.5 }), plan: plan() });
    expect(hi.available_bytes / lo.available_bytes).toBeCloseTo(0.95 / 0.5, 10);
    expect(hi.required_bytes).toBe(lo.required_bytes);
  });
});

/* ══════════════ the three-state gate ══════════════ */

describe('the gate has three states because a lower bound that fits proves nothing', () => {
  it('FEASIBLE when every term is known and they fit', () => {
    const r = vramFeasibility({ hardware: hardware(), instance: instance(), plan: plan() });
    expect(r.verdict).toBe('FEASIBLE');
    expect(r.required_is_lower_bound).toBe(false);
  });

  it('INDETERMINATE when the activation buffer has never been measured, even though it fits', () => {
    const r = vramFeasibility({
      hardware: hardware({ image_activation_buffer_gb: s(null, { method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }) }),
      instance: instance(),
      plan: plan(),
    });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.missing).toContain('image_activation_buffer_gb');
    expect(r.required_is_lower_bound).toBe(true);
  });

  it('INFEASIBLE on a lower bound that already exceeds the budget — the one direction a floor settles', () => {
    const r = vramFeasibility({
      hardware: hardware({
        params_b_total: 400,
        image_activation_buffer_gb: s(null, { method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }),
      }),
      instance: instance({ gpu_count: 1, vram_per_gpu_gib: 80 }),
      plan: plan(),
    });
    expect(r.verdict).toBe('INFEASIBLE');
    expect(r.required_bytes!).toBeGreaterThan(r.available_bytes);
  });

  it('INDETERMINATE when the model card cannot produce a KV figure at all', () => {
    const r = vramFeasibility({ hardware: hardware({ layers: null }), instance: instance(), plan: plan() });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.kv_cache_bytes).toBeNull();
  });
});

/* ══════════════ §A5.9.1 — the VLM chain ══════════════ */

describe('visual tokens land in the same context and the same cache', () => {
  it('adds visual tokens to the KV term', () => {
    const withImage = vramFeasibility({ hardware: hardware(), instance: instance(), plan: plan({ planned_context_tokens: 8_000 }), visual_tokens: 8_000 });
    const without = vramFeasibility({ hardware: hardware(), instance: instance(), plan: plan({ planned_context_tokens: 8_000 }) });
    expect(withImage.kv_cache_bytes! / without.kv_cache_bytes!).toBe(2);
  });

  it('clamps by MIN(tokens, max_context) and flags that the clamp bit', () => {
    const r = vramFeasibility({
      hardware: hardware({ max_context_tokens: 4_096 }),
      instance: instance(),
      plan: plan({ planned_context_tokens: 4_000 }),
      visual_tokens: 3_000,
    });
    expect(r.context_clamped).toBe(true);
    const g = kvGeometryFrom(hardware());
    if (g.status !== 'OK') throw new Error('geometry');
    expect(r.kv_cache_bytes).toBe(kvCacheBytes(g.geometry, 4_096, 1));
    expect(r.notes.join(' ')).toMatch(/CONTEXT_TOO_SMALL/);
  });

  it('reports the image share of context — a capability limit wearing a cost limit for cover', () => {
    const r = vramFeasibility({
      hardware: hardware({ max_context_tokens: 4_096 }),
      instance: instance(),
      plan: plan({ planned_context_tokens: 100 }),
      visual_tokens: 2_048,
    });
    expect(r.image_share_of_context).toBeCloseTo(0.5, 10);
    // §A11 found this one: the share was computed and reported, and nothing said
    // it mattered. Half the window gone to images is the room the prompt has left.
    expect(codes(r.warnings)).toContain('VISUAL_TOKENS_DOMINATE_CONTEXT');
    expect(messages(r.warnings)).toMatch(/50% of the 4096-token context/);
  });

  it('does not cry wolf below the threshold', () => {
    const r = vramFeasibility({
      hardware: hardware({ max_context_tokens: 4_096 }),
      instance: instance(),
      plan: plan({ planned_context_tokens: 100 }),
      visual_tokens: 256,
    });
    expect(r.image_share_of_context).toBeCloseTo(0.0625, 10);
    expect(codes(r.warnings)).not.toContain('VISUAL_TOKENS_DOMINATE_CONTEXT');
  });

  it('the clamp makes the memory figure SMALLER, which is why it cannot be read as good news', () => {
    const clamped = clampedContextTokens(200_000, 128_000);
    expect(clamped.tokens).toBe(128_000);
    expect(clamped.clamped).toBe(true);
    expect(clampedContextTokens(1_000, null)).toEqual({ tokens: 1_000, clamped: false, share_of_context: null });
  });
});

/* ══════════════ request timing ══════════════ */

describe('requestTiming', () => {
  const t = { prefill_tps: 8_000, decode_tps: 40, ttft_seconds: 0.2, concurrency_efficiency_factor: 0.5 };

  it('implements ttft + prefill + decode, then divides by the concurrency factor', () => {
    const r = requestTiming({ p50: 8_000, p90: 8_000, p99: null }, { p50: 400, p90: 400, p99: null }, t);
    expect(r.request_seconds.p50).toBeCloseTo(0.2 + 1 + 10, 10);
    expect(r.effective_seconds.p50).toBeCloseTo((0.2 + 1 + 10) / 0.5, 10);
  });

  it('widens the timing band from the token bands rather than asserting one', () => {
    const r = requestTiming({ p50: 8_000, p90: 16_000, p99: null }, { p50: 100, p90: 400, p99: null }, t);
    expect(r.request_seconds.p90).toBeGreaterThan(r.request_seconds.p50);
  });

  it('§A5.9.1 — prefill dominates a document VLM request', () => {
    // Thousands of visual tokens in, a couple of hundred out.
    const doc = requestTiming({ p50: 200_000, p90: 200_000, p99: null }, { p50: 200, p90: 200, p99: null }, { ...t, concurrency_efficiency_factor: 1 });
    expect(doc.prefill_share_pct).toBeGreaterThan(80);

    // The same machine on chat is the opposite shape.
    const chat = requestTiming({ p50: 500, p90: 500, p99: null }, { p50: 800, p90: 800, p99: null }, { ...t, concurrency_efficiency_factor: 1 });
    expect(chat.prefill_share_pct).toBeLessThan(5);
  });

  it('refuses when the prefill figure is unmeasured, rather than substituting decode', () => {
    const r = throughputFrom(hardware({ prefill_throughput_tps: s(null, { method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }) }), instance());
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.missing).toContain('prefill_throughput_tps');
  });

  it('pulls the concurrency factor off the instance, not the model', () => {
    const r = throughputFrom(hardware(), instance({ concurrency_efficiency_factor: s(0.6) }));
    if (r.status !== 'OK') throw new Error('throughput');
    expect(r.throughput.concurrency_efficiency_factor).toBe(0.6);
  });
});

/* ══════════════ utilization — the honest lever ══════════════ */

describe('resolveUtilization', () => {
  it('derives utilization from the workload when none is stated', () => {
    // 8640 requests x 1s = 8640s of a 86400s day.
    const u = resolveUtilization(plan({ expected_requests_per_day: 8_640, utilization_factor: null }), 1);
    expect(u.is_derived).toBe(true);
    expect(u.derived).toBeCloseTo(0.1, 10);
    expect(u.value).toBeCloseTo(0.1, 10);
  });

  it('reports both figures when a stated utilization disagrees, and averages neither', () => {
    const u = resolveUtilization(plan({ expected_requests_per_day: 8_640, utilization_factor: 0.8 }), 1);
    expect(u.diverges).toBe(true);
    expect(u.stated).toBe(0.8);
    expect(u.derived).toBeCloseTo(0.1, 10);
    expect(u.value).toBe(0.8);
  });

  it('flags a workload that one instance cannot hold', () => {
    const u = resolveUtilization(plan({ expected_requests_per_day: 200_000, utilization_factor: null }), 1);
    expect(u.exceeds_single_instance).toBe(true);
    expect(u.derived).toBe(1);
  });
});

/* ══════════════ the cost decomposition ══════════════ */

describe('selfHostedCost', () => {
  const timing = { request_seconds: { p50: 2, p90: 4, p99: null }, effective_seconds: { p50: 2, p90: 4, p99: null }, prefill_share_pct: 10 };

  it('gpu_seconds + idle_gpu sum to EXACTLY the §A5.9 formula — the double-count guard', () => {
    const i = instance({ hourly_rate_on_demand: rate(4, 'per_gpu_hour'), regional_tax_rate: s(0.15) });
    const p = plan({ utilization_factor: 0.25, expected_requests_per_day: 5_000 });
    const r = selfHostedCost({ instance: i, plan: p, timing });
    if (r.status !== 'OK') throw new Error(r.missing.join(','));

    const compute = r.components.filter((c) => c.unit === 'seconds');
    const total = compute.reduce((a, c) => a + c.quantity.p50 * c.rate_amount, 0);

    // effective_seconds x (hourly/3600) x (1+tax) / utilization
    const spec = (2 * ((4 * 8) / 3600) * 1.15) / 0.25;
    expect(total).toBeCloseTo(spec, 12);

    expect(r.components.map((c) => c.component)).toContain('idle_gpu');
    expect(r.components.find((c) => c.component === 'idle_gpu')!.note).toMatch(/not billed a second time/);
  });

  it('idle_cost_per_day is informational and already inside the idle line', () => {
    const r = selfHostedCost({ instance: instance(), plan: plan({ utilization_factor: 0.25 }), timing });
    if (r.status !== 'OK') throw new Error('cost');
    expect(r.idle_cost_per_day).toBeCloseTo(r.instance_daily_amount * 0.75, 10);
  });

  it('warns on a mostly-idle GPU', () => {
    const r = selfHostedCost({ instance: instance(), plan: plan({ utilization_factor: 0.05 }), timing });
    if (r.status !== 'OK') throw new Error('cost');
    expect(codes(r.warnings)).toContain('LOW_UTILIZATION_SELF_HOSTED');
  });

  it('says out loud that a spot price is the price of an uninterrupted run', () => {
    const i = instance({ hourly_rate_spot: rate(1.2, 'per_gpu_hour') });
    const r = selfHostedCost({ instance: i, plan: plan({ rate_basis: 'SPOT' }), timing });
    if (r.status !== 'OK') throw new Error('cost');
    expect(codes(r.warnings)).toContain('SPOT_RATE_INTERRUPTION_UNMODELLED');
  });

  it('refuses rather than quoting the other basis when the requested one has no rate', () => {
    const r = selfHostedCost({ instance: instance({ hourly_rate_spot: null }), plan: plan({ rate_basis: 'SPOT' }), timing });
    expect(r.status).toBe('UNAVAILABLE');
  });

  it('scale-to-zero has no idle line and amortizes the cold starts it trades for', () => {
    const r = selfHostedCost({
      instance: instance(),
      plan: plan({ always_on: false, scale_to_zero: true, cold_starts_per_day: 20, expected_requests_per_day: 1_000 }),
      timing,
    });
    if (r.status !== 'OK') throw new Error('cost');
    expect(r.components.some((c) => c.component === 'idle_gpu')).toBe(false);
    const cold = r.components.filter((c) => c.component === 'gpu_seconds' && c.note!.startsWith('Cold starts'));
    expect(cold).toHaveLength(1);
    expect(cold[0]!.quantity.p50).toBeCloseTo((20 * 45) / 1_000, 10);
  });

  it('omits an unmeasured line and says so, rather than costing it at zero', () => {
    const r = selfHostedCost({ instance: instance({ ops_labour_monthly: s(null, { method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }) }), plan: plan({ utilization_factor: 0.5 }), timing });
    if (r.status !== 'OK') throw new Error('cost');
    expect(r.components.some((c) => c.component === 'ops_labour')).toBe(false);
    expect(r.notes.join(' ')).toMatch(/not labour-free/);
  });

  it('amortizes ops labour per request when it is supplied', () => {
    const r = selfHostedCost({ instance: instance({ ops_labour_monthly: s(3_000) }), plan: plan({ utilization_factor: 0.5, expected_requests_per_day: 1_000 }), timing });
    if (r.status !== 'OK') throw new Error('cost');
    const ops = r.components.find((c) => c.component === 'ops_labour')!;
    expect(ops.rate_amount).toBeCloseTo(3_000 / DAYS_PER_MONTH / 1_000, 12);
  });

  it('does not tax somebody’s time', () => {
    const taxed = selfHostedCost({ instance: instance({ ops_labour_monthly: s(3_000), regional_tax_rate: s(0.15) }), plan: plan({ utilization_factor: 0.5, expected_requests_per_day: 1_000 }), timing });
    const untaxed = selfHostedCost({ instance: instance({ ops_labour_monthly: s(3_000), regional_tax_rate: s(0) }), plan: plan({ utilization_factor: 0.5, expected_requests_per_day: 1_000 }), timing });
    if (taxed.status !== 'OK' || untaxed.status !== 'OK') throw new Error('cost');
    const pick = (r: typeof taxed) => (r.status === 'OK' ? r.components.find((c) => c.component === 'ops_labour')!.rate_amount : 0);
    expect(pick(taxed)).toBe(pick(untaxed));
  });
});

/* ══════════════ the crossover ══════════════ */

describe('breakevenCrossover', () => {
  const base = {
    api_cost_per_request: 0.01,
    instance_daily_amount: 100,
    effective_seconds_p50: 1,
  };

  it('finds the volume where an always-on instance stops being the expensive option', () => {
    const r = breakevenCrossover(base);
    // 100/day of GPU against 0.01/request: 10,000 requests/day, and one instance at
    // 1s/request can serve 86,400 — so the crossover lands inside the first stair.
    expect(r.requests_per_day_crossover).toBe(10_000);
    expect(r.capacity_per_instance).toBe(86_400);
  });

  it('lands inside the first stair when the first stair is wide enough', () => {
    const r = breakevenCrossover({ ...base, effective_seconds_p50: 8_640, api_cost_per_request: 15 });
    expect(r.capacity_per_instance).toBe(10);
    // 100/day against 15/request crosses at 7, and one instance serves 10.
    expect(r.requests_per_day_crossover).toBe(7);
  });

  it('steps by a whole instance rather than sloping — the staircase, not a line', () => {
    // One instance serves 10 requests/day. With a daily fixed cost on top, the first
    // two stairs are BOTH too expensive and the crossover only opens on the third —
    // a linear model would have reported it at 160/12 ≈ 14 and been wrong by 2x.
    const r = breakevenCrossover({
      ...base,
      effective_seconds_p50: 8_640,
      api_cost_per_request: 12,
      fixed_daily_other: 60,
      sample_requests_per_day: [1, 10, 11, 20, 21, 29, 30],
    });
    expect(r.capacity_per_instance).toBe(10);
    expect(r.requests_per_day_crossover).toBe(30);

    const cost = (n: number) => r.series.find((p) => p.requests_per_day === n)!.self_hosted_cost;
    // Flat across a stair, then a whole instance at once. No slope anywhere.
    expect(cost(1)).toBe(160);
    expect(cost(10)).toBe(160);
    expect(cost(11)).toBe(260);
    expect(cost(20)).toBe(260);
    expect(cost(21)).toBe(360);

    // And the crossover is where the API line finally reaches the stair it is on.
    const at30 = r.series.find((p) => p.requests_per_day === 30)!;
    expect(at30.api_cost).toBeGreaterThanOrEqual(at30.self_hosted_cost);
    const at29 = r.series.find((p) => p.requests_per_day === 29)!;
    expect(at29.api_cost).toBeLessThan(at29.self_hosted_cost);
  });

  it('returns null when volume cannot close the gap', () => {
    const r = breakevenCrossover({ ...base, api_cost_per_request: 0.0000001 });
    expect(r.requests_per_day_crossover).toBeNull();
    expect(r.notes.join(' ')).toMatch(/does not become cheaper by adding volume/);
  });

  it('treats scale-to-zero as the linear case it is', () => {
    const r = breakevenCrossover({
      ...base,
      scale_to_zero: { marginal_per_request: 0.004, cold_fixed_daily: 6 },
    });
    // 6 / (0.01 - 0.004) = 1000
    expect(r.requests_per_day_crossover).toBe(1_000);
  });

  it('says when it assumed an instance can be driven to 100% of its arithmetic capacity', () => {
    expect(breakevenCrossover(base).notes.join(' ')).toMatch(/optimistic/);
    expect(breakevenCrossover({ ...base, max_utilization: 0.7 }).notes.join(' ')).not.toMatch(/optimistic/);
  });

  it('charges the always-on instance before the first request arrives', () => {
    const r = breakevenCrossover(base);
    const first = r.series[0]!;
    expect(first.self_hosted_cost).toBe(100);
    expect(first.api_cost).toBeLessThan(first.self_hosted_cost);
  });

  it('carries the assumption ids the crossover moves with', () => {
    const r = breakevenCrossover({ ...base, assumptions_ref: ['a1', 'a2'] });
    expect(r.assumptions_ref).toEqual(['a1', 'a2']);
  });
});

describe('bytesToGib', () => {
  it('round-trips the one conversion this module exposes', () => {
    expect(bytesToGib(BYTES_PER_GIB * 3)).toBe(3);
  });
});
