// /packages/estimator/src/request.test.ts
//
// §A5.10 is a list of terms that get MISSED, so most of these tests assert that
// something is not silently zero, not silently one, and not silently free.
//
//   pnpm vitest src/request.test.ts     # offline, free

import { describe, it, expect } from 'vitest';
import { Provenance, RequestOptions, ImageMetrics } from '@tokenomics/contracts';
import { buildLine } from './candidate';
import {

  resolveServiceTier,
  residencyUplift,
  toolUseSystemPromptTokens,
  serverToolFees,
  serverToolCost,
  rerollFactor,
  applyRequestMultipliers,
  resolveRequestLayer,
} from './request';

/** Warnings are `{code, message, severity}` now, so an assertion reads one half or the other. */
const codes = (ws: readonly { code: string }[]) => ws.map((w) => w.code);
const messages = (ws: readonly { message: string }[]) => ws.map((w) => w.message).join(' ');

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

const rate = (amount: number, unit: string, over: Partial<any> = {}) => ({
  amount,
  unit,
  list_currency: 'USD',
  fx_rate_used: null,
  fx_rate_date: null,
  fx_source_url: null,
  effective_from: '2026-09-01T00:00:00.000Z',
  effective_to: null,
  time_of_day_variant: 'all_hours' as const,
  max_age_days: null,
  conflict: null,
  provenance: prov(over),
});

const tierProfile = (over: Record<string, unknown> = {}): any => ({
  tier: 'priority',
  multiplier: s(2),
  available: true,
  excludes: [],
  unavailable_in_regions: [],
  ...over,
});

const compliance = (over: Record<string, unknown> = {}): any => ({
  data_residency_region: ['us-east', 'me-central'],
  is_prc_hosted: false,
  contractual_dpa_available: true,
  residency_uplift_pct: s(0.15),
  notes: null,
  ...over,
});

const rates = (over: Record<string, unknown> = {}): any => ({
  variant: 'standard',
  currency: 'USD',
  input_rate_by_modality: { text: rate(3, 'per_1m_tokens') },
  output_rate: rate(15, 'per_1m_tokens'),
  reasoning_output_rate: null,
  per_request_fee: null,
  context_tiers: null,
  cache: null,
  tool_use_system_prompt_tokens: [{ tool_choice_mode: 'auto', tokens: s(346) }],
  server_tool_fees: [
    { tool: 'web_search', rate: rate(10, 'per_1k_calls'), free_allowance_per_month: null },
  ],
  ...over,
});

const line = (over: Record<string, unknown> = {}) =>
  buildLine({
    task_id: 't1',
    component: 'prompt_input',
    quantity: { p50: 1000, p90: 2000, p99: null },
    unit: 'tokens',
    rate_amount: 0.000003,
    rate_record_id: 'r1',
    method: 'EXACT_TOKENIZER',
    confidence: 'HIGH',
    tier: 2,
    ...over,
  } as any);

/* ══════════════ the service tier — per provider, never shared ══════════════ */

describe('resolveServiceTier', () => {
  it('reads the multiplier off THIS provider — 1.8x and 2x are both real', () => {
    // §A5.10 records one provider's premium tier at 1.8x where two others use 2x.
    // A shared constant would be wrong for one of them and look right for the rest.
    const a = resolveServiceTier([tierProfile({ multiplier: s(1.8) })], 'priority', null);
    const b = resolveServiceTier([tierProfile({ multiplier: s(2) })], 'priority', null);
    expect(a.status === 'OK' && a.multiplier).toBe(1.8);
    expect(b.status === 'OK' && b.multiplier).toBe(2);
  });

  it('refuses an unpublished tier rather than treating it as 1x', () => {
    const r = resolveServiceTier([tierProfile()], 'batch', null);
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') {
      expect(r.reason).toMatch(/not 1 by default/);
      expect(r.warning).toBe('SERVICE_TIER_UNAVAILABLE');
    }
  });

  it('refuses an unsourced multiplier', () => {
    const r = resolveServiceTier(
      [tierProfile({ multiplier: s(null, { method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }) })],
      'priority',
      null,
    );
    expect(r.status).toBe('UNAVAILABLE');
  });

  it('refuses a NONE-confidence multiplier — a refusal wearing a number', () => {
    const r = resolveServiceTier(
      [tierProfile({ multiplier: s(2, { method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }) })],
      'priority',
      null,
    );
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/NONE confidence/);
  });

  it('honours a documented exclusion between tiers', () => {
    const r = resolveServiceTier([tierProfile({ tier: 'fast', excludes: ['batch'] })], 'fast', null, ['batch']);
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/cannot be combined/);
  });

  it('a residency constraint can remove a discount tier', () => {
    const r = resolveServiceTier(
      [tierProfile({ tier: 'batch', unavailable_in_regions: ['me-central'] })],
      'batch',
      'me-central',
    );
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/not offered in me-central/);
  });
});

/* ══════════════ residency — the Gulf routing trap ══════════════ */

describe('residencyUplift', () => {
  it('is zero and does not apply when no region was requested', () => {
    const r = residencyUplift(compliance(), null);
    expect(r.status === 'OK' && r.uplift_pct).toBe(0);
    expect(r.status === 'OK' && r.applies).toBe(false);
  });

  it('applies the published uplift on a listed regional endpoint', () => {
    const r = residencyUplift(compliance(), 'me-central');
    expect(r.status === 'OK' && r.uplift_pct).toBe(0.15);
    expect(r.status === 'OK' && r.applies).toBe(true);
  });

  it('refuses a region the model does not publish, rather than quoting the default price there', () => {
    const r = residencyUplift(compliance(), 'eu-west');
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/does not publish an endpoint/);
  });

  it('refuses an unsourced uplift — compliance is not free by default', () => {
    const r = residencyUplift(
      compliance({ residency_uplift_pct: s(null, { method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }) }),
      'me-central',
    );
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/as though compliance were free/);
  });
});

/* ══════════════ two tool meters, not one ══════════════ */

describe('toolUseSystemPromptTokens', () => {
  it('returns the published injection for the enabled mode', () => {
    const r = toolUseSystemPromptTokens(rates(), 'auto');
    expect(r.status === 'OK' && r.tokens).toBe(346);
  });

  it('is NOT_APPLICABLE when tools are off — distinct from unknown', () => {
    expect(toolUseSystemPromptTokens(rates(), null).status).toBe('NOT_APPLICABLE');
  });

  it('refuses an unpublished mode rather than treating the injection as zero', () => {
    const r = toolUseSystemPromptTokens(rates(), 'required');
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/not zero merely because it is unpublished/);
  });

  it('is additive to the tool schema, not a subset of it — two lines, two components', () => {
    const schemaLine = line({ component: 'tool_schema', quantity: { p50: 1200, p90: 1200, p99: null } });
    const r = toolUseSystemPromptTokens(rates(), 'auto');
    if (r.status !== 'OK') throw new Error('tool system prompt');
    const injectionLine = buildLine({
      task_id: 't1',
      component: 'tool_use_system_prompt',
      quantity: { p50: r.tokens, p90: r.tokens, p99: null },
      unit: 'tokens',
      rate_amount: r.rate.amount / 1e6,
      rate_record_id: 'r1',
      method: 'PROVIDER_FORMULA',
      confidence: r.confidence,
    } as any);
    expect(schemaLine.component).not.toBe(injectionLine.component);
    expect(injectionLine.quantity!.p50).toBe(346);
  });
});

/* ══════════════ server tools — the majority of an agentic bill ══════════════ */

describe('serverToolFees', () => {
  it('converts a per-1k-calls rate to a per-call amount', () => {
    const r = serverToolFees(rates().server_tool_fees, [
      RequestOptions.parse({ server_tools: [{ tool: 'web_search', calls_per_execution: 3 }] }).server_tools[0]!,
    ]);
    expect(r.charges).toHaveLength(1);
    expect(r.charges[0]!.amount_per_call).toBeCloseTo(0.01, 12);
    expect(r.charges[0]!.billable_calls).toBe(3);
  });

  it('multiplies by executions — a loop over 500 docs searches 500 times', () => {
    const uses = RequestOptions.parse({ server_tools: [{ tool: 'web_search', calls_per_execution: 2 }] }).server_tools;
    const r = serverToolFees(rates().server_tool_fees, uses, 500);
    expect(r.charges[0]!.billable_calls).toBe(1_000);
    expect(serverToolCost(r.charges).p50).toBeCloseTo(10, 12);
  });

  it('reports a tool the registry does not price as a hole, not a free call', () => {
    const uses = RequestOptions.parse({ server_tools: [{ tool: 'code_container', calls_per_execution: 5 }] }).server_tools;
    const r = serverToolFees(rates().server_tool_fees, uses);
    expect(r.charges).toHaveLength(0);
    expect(r.unpriced[0]!.reason).toMatch(/not a free call/);
  });

  it('reports a non-per-call unit as unpriced rather than guessing the quantity', () => {
    const fees = [{ tool: 'code_container', rate: rate(0.05, 'per_gb_day'), free_allowance_per_month: null }];
    const uses = RequestOptions.parse({ server_tools: [{ tool: 'code_container', calls_per_execution: 1 }] }).server_tools;
    const r = serverToolFees(fees as any, uses);
    expect(r.unpriced[0]!.reason).toMatch(/not a per-call unit/);
  });

  it('applies a free allowance when month-to-date usage is known', () => {
    const fees = [{ tool: 'web_search', rate: rate(10, 'per_1k_calls'), free_allowance_per_month: 1_000 }];
    const uses = RequestOptions.parse({
      server_tools: [{ tool: 'web_search', calls_per_execution: 300, calls_used_this_month: 900 }],
    }).server_tools;
    const r = serverToolFees(fees as any, uses);
    expect(r.charges[0]!.free_calls).toBe(100);
    expect(r.charges[0]!.billable_calls).toBe(200);
    expect(codes(r.warnings)).not.toContain('SERVER_TOOL_ALLOWANCE_NOT_APPLIED');
  });

  it('does NOT grant an allowance it cannot verify — it bills and says so', () => {
    const fees = [{ tool: 'web_search', rate: rate(10, 'per_1k_calls'), free_allowance_per_month: 1_000 }];
    const uses = RequestOptions.parse({
      server_tools: [{ tool: 'web_search', calls_per_execution: 300 }],
    }).server_tools;
    const r = serverToolFees(fees as any, uses);
    expect(r.charges[0]!.free_calls).toBe(0);
    expect(r.charges[0]!.billable_calls).toBe(300);
    expect(codes(r.warnings)).toContain('SERVER_TOOL_ALLOWANCE_NOT_APPLIED');
    expect(r.notes.join(' ')).toMatch(/overstates by at most the allowance/);
  });

  it('an exhausted allowance frees nothing', () => {
    const fees = [{ tool: 'web_search', rate: rate(10, 'per_1k_calls'), free_allowance_per_month: 1_000 }];
    const uses = RequestOptions.parse({
      server_tools: [{ tool: 'web_search', calls_per_execution: 50, calls_used_this_month: 4_000 }],
    }).server_tools;
    expect(serverToolFees(fees as any, uses).charges[0]!.billable_calls).toBe(50);
  });

  it('a tool listed with zero calls produces no charge', () => {
    const uses = RequestOptions.parse({ server_tools: [{ tool: 'web_search', calls_per_execution: 0 }] }).server_tools;
    expect(serverToolFees(rates().server_tool_fees, uses).charges).toHaveLength(0);
  });
});

/* ══════════════ re-rolls ══════════════ */

const imageMetrics = (over: Record<string, unknown> = {}) =>
  ImageMetrics.parse({
    dimensions_source: 'USER_STATED',
    operation: 'generate',
    ...over,
  });

describe('rerollFactor', () => {
  it('flags the default of 1 — §A5.10 says it is almost never the real figure', () => {
    const r = rerollFactor(imageMetrics());
    expect(r.factor).toBe(1);
    expect(r.defaulted).toBe(true);
    expect(r.warning).toBe('REROLL_COUNT_DEFAULTED');
    expect(r.note).toMatch(/floor of the generation cost/);
  });

  it('multiplies by every candidate billed', () => {
    const r = rerollFactor(imageMetrics({ candidates_per_accepted_image: 4 }));
    expect(r.factor).toBe(4);
    expect(r.defaulted).toBe(false);
  });

  it('does not apply to analysis, which bills an image once', () => {
    const r = rerollFactor(imageMetrics({ operation: 'analyze' }));
    expect(r.factor).toBe(1);
    expect(r.warning).toBeNull();
  });

  it('the contract refuses a candidate count on an analysed image', () => {
    expect(() => imageMetrics({ operation: 'analyze', candidates_per_accepted_image: 3 })).toThrow(
      /generation, not analysis/,
    );
  });
});

/* ══════════════ applying the multipliers ══════════════ */

describe('applyRequestMultipliers', () => {
  const mult = (over: Partial<any> = {}) => ({
    service_tier: 'priority' as const,
    service_tier_multiplier: 2,
    service_tier_confidence: 'HIGH' as const,
    region: null,
    residency_uplift_pct: 0,
    residency_confidence: 'HIGH' as const,
    ...over,
  });

  it('scales every line, so total == sum(lines) survives', () => {
    const lines = [line(), line({ component: 'completion_output', rate_amount: 0.000015 })];
    const before = lines.reduce((a, l) => a + l.cost!.p50, 0);
    const r = applyRequestMultipliers(lines, mult());
    const after = r.lines.reduce((a, l) => a + l.cost!.p50, 0);
    expect(after).toBeCloseTo(before * 2, 12);
  });

  it('applies the residency uplift to cache reads and writes — the terms most easily exempted', () => {
    const lines = [
      line({ component: 'cache_read', rate_amount: 0.0000003 }),
      line({ component: 'cache_write', rate_amount: 0.00000375 }),
      line({ component: 'cache_storage', rate_amount: 0.000001 }),
    ];
    const r = applyRequestMultipliers(lines, mult({ service_tier_multiplier: 1, service_tier: 'standard', region: 'me-central', residency_uplift_pct: 0.15 }));
    lines.forEach((l, i) => {
      expect(r.lines[i]!.cost!.p50).toBeCloseTo(l.cost!.p50 * 1.15, 15);
    });
    expect(codes(r.warnings)).toContain('RESIDENCY_UPLIFT_APPLIED');
  });

  it('compounds the two layers in the order §A5.10 writes them', () => {
    const l = line();
    const r = applyRequestMultipliers([l], mult({ region: 'me-central', residency_uplift_pct: 0.15 }));
    expect(r.lines[0]!.cost!.p50).toBeCloseTo(l.cost!.p50 * 2 * 1.15, 15);
    expect(r.multipliers.combined_factor).toBeCloseTo(2.3, 12);
  });

  it('leaves QUANTITIES untouched — a batch tier changes the price, not the token count', () => {
    const l = line();
    const r = applyRequestMultipliers([l], mult());
    expect(r.lines[0]!.quantity).toEqual(l.quantity);
  });

  it('passes a refusal through unscaled — multiplying nothing produces a zero that reads as free', () => {
    const refusal = buildLine({
      task_id: 't1',
      component: 'reasoning_output',
      quantity: null,
      unit: null,
      rate_amount: null,
      rate_record_id: null,
      method: 'UNAVAILABLE',
      confidence: 'NONE',
    } as any);
    const r = applyRequestMultipliers([refusal], mult());
    expect(r.lines[0]!.cost).toBeNull();
    expect(r.lines[0]!.confidence).toBe('NONE');
  });

  it('floors each line by the weaker multiplier (§A3.7)', () => {
    const r = applyRequestMultipliers([line()], mult({ service_tier_confidence: 'LOW' }));
    expect(line().confidence).toBe('HIGH');
    expect(r.lines[0]!.confidence).toBe('LOW');
    expect(r.multipliers.confidence).toBe('LOW');
  });

  it('a 1x multiplier still floors confidence — an unsure claim that nothing was added', () => {
    const r = applyRequestMultipliers([line()], mult({ service_tier_multiplier: 1, service_tier: 'standard', service_tier_confidence: 'MEDIUM' }));
    expect(r.lines[0]!.cost!.p50).toBe(line().cost!.p50);
    expect(r.lines[0]!.confidence).toBe('MEDIUM');
  });
});

/* ══════════════ resolving the layer as a unit ══════════════ */

describe('resolveRequestLayer', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    options: RequestOptions.parse({ service_tier: 'priority', tool_choice_mode: 'auto', server_tools: [{ tool: 'web_search', calls_per_execution: 2 }] }),
    tier_profiles: [tierProfile()],
    compliance: compliance(),
    rates: rates(),
    ...over,
  });

  it('resolves all four layers in one pass', () => {
    const r = resolveRequestLayer(input());
    if (r.status !== 'OK') throw new Error(r.reasons.join('; '));
    expect(r.multipliers.service_tier_multiplier).toBe(2);
    expect(r.multipliers.residency_uplift_pct).toBe(0);
    expect(r.tool_system_prompt.status).toBe('OK');
    expect(r.server_tools.charges).toHaveLength(1);
  });

  it('says out loud that the compliant route costs more', () => {
    const r = resolveRequestLayer(input({ options: RequestOptions.parse({ service_tier: 'priority', region: 'me-central' }) }));
    if (r.status !== 'OK') throw new Error(r.reasons.join('; '));
    expect(r.notes.join(' ')).toMatch(/compliant route is not the default price/);
  });

  it('refuses as a unit — a partially applied multiplier looks like a complete answer', () => {
    const r = resolveRequestLayer(input({ tier_profiles: [] }));
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(codes(r.warnings)).toContain('SERVICE_TIER_UNAVAILABLE');
  });

  it('the code and the sentence explaining it travel together', () => {
    // Found by mutation: replacing the warning's message with 'x' turned nothing
    // red, so nothing was checking that a code arrives with anything a reader can
    // act on. A bare SERVICE_TIER_UNAVAILABLE tells you a tier failed, not which
    // one or why — and reuniting the two halves is the whole point of this change.
    const r = resolveRequestLayer(input({ tier_profiles: [] }));
    if (r.status !== 'UNAVAILABLE') throw new Error('expected UNAVAILABLE');
    const w = r.warnings.find((x) => x.code === 'SERVICE_TIER_UNAVAILABLE')!;
    expect(w.message).toBe(r.reasons[0]);
    expect(w.message.length).toBeGreaterThan(20);
  });

  it('an unresolvable region blocks the whole layer, not just the uplift', () => {
    const r = resolveRequestLayer(input({ options: RequestOptions.parse({ service_tier: 'priority', region: 'eu-west' }) }));
    expect(r.status).toBe('UNAVAILABLE');
  });
});
