// /packages/router/src/router.test.ts
//
// The router's job is to choose, and the ways choosing goes wrong here are all
// ways of comparing things that are not comparable: an unfinished estimate against
// a finished one, two currencies, a capability claim against a price.
//
//   pnpm vitest packages/router     # offline, free

import { describe, it, expect } from 'vitest';
import { Candidate, EstimateLine, type ModelRow, type Task } from '@tokenomics/contracts';
import { capabilityGate, rank, splitRoute, route, isRankable } from './index';

/* ─────────────────────────── fixtures ─────────────────────────── */

const prov = (over: Record<string, unknown> = {}) => ({
  method: 'PROVIDER_FORMULA',
  confidence: 'HIGH',
  source_class: 'VENDOR_DOCS',
  source_url: 'https://example.invalid/docs',
  verified_at: '2026-09-08T00:00:00.000Z',
  verified_by: null,
  notes: null,
  ...over,
});
const s = (value: unknown, p: Record<string, unknown> = prov()) => ({ value, provenance: p });

const rate = (amount: number, over: Record<string, unknown> = {}) => ({
  amount,
  unit: 'per_1m_tokens',
  list_currency: 'USD',
  fx_rate_used: null, fx_rate_date: null, fx_source_url: null,
  effective_from: '2026-01-01T00:00:00.000Z',
  effective_to: null,
  time_of_day_variant: 'all_hours',
  max_age_days: null,
  conflict: null,
  provenance: prov(),
  ...over,
});

const line = (cost: number, over: Record<string, unknown> = {}) =>
  EstimateLine.parse({
    task_id: 't1',
    component: 'prompt_input',
    quantity: { p50: 1000, p90: 1000, p99: null },
    unit: 'tokens',
    rate_record_id: 'r1',
    cost: { p50: cost, p90: cost, p99: null },
    context_safety_quantity: null,
    method: 'PROVIDER_FORMULA',
    tier: 1,
    tokenizer_proxy: null,
    cache: null,
    confidence: 'HIGH',
    note: null,
    ...over,
  });

const refusal = (over: Record<string, unknown> = {}) =>
  EstimateLine.parse({
    task_id: 't1',
    component: 'completion_output',
    quantity: null,
    unit: null,
    rate_record_id: null,
    cost: null,
    context_safety_quantity: null,
    method: 'UNAVAILABLE',
    tier: null,
    tokenizer_proxy: null,
    cache: null,
    confidence: 'NONE',
    note: null,
    ...over,
  });

const candidate = (model_id: string, cost: number, over: Record<string, unknown> = {}) =>
  Candidate.parse({
    model_id,
    provider_id: 'p',
    deployment_mode: 'API_MANAGED',
    lines: [line(cost)],
    total_tokens: null,
    total_cost: { p50: cost, p90: cost, p99: null },
    currency: 'USD',
    confidence: 'HIGH',
    ...over,
  });

/** A candidate that refused everything. Its total is 0 — that is the trap. */
const refusedCandidate = (model_id: string) =>
  Candidate.parse({
    model_id,
    provider_id: 'p',
    deployment_mode: 'API_MANAGED',
    lines: [refusal()],
    total_tokens: null,
    total_cost: { p50: 0, p90: 0, p99: null },
    currency: 'USD',
    confidence: 'NONE',
  });

/* ══════════════ THE TRAP — a refused candidate totals $0.00 ══════════════ */

describe('an unfinished estimate is never the cheapest', () => {
  it('the trap is real: a candidate that refused everything totals zero', () => {
    // assembleCandidate sums a null line cost as 0. Sorting on p50 alone would put
    // the model nothing could price first, at $0.00, and it would look like a win.
    const broken = refusedCandidate('unpriceable');
    expect(broken.total_cost.p50).toBe(0);
    expect(broken.total_cost.p50).toBeLessThan(candidate('real', 0.5).total_cost.p50);
  });

  it('and the router excludes it instead of recommending it', () => {
    const r = rank({ candidates: [refusedCandidate('unpriceable'), candidate('real', 0.5)] });
    expect(r.cheapest!.model_id).toBe('real');
    expect(r.excluded.map((e) => e.model_id)).toEqual(['unpriceable']);
    expect(r.excluded[0]!.reason).toBe('ESTIMATE_INCOMPLETE');
    expect(r.excluded[0]!.detail).toMatch(/lower bound, not a price/);
  });

  it('a PARTIALLY refused candidate is also incomplete — the total is still short', () => {
    const partial = Candidate.parse({
      model_id: 'partial', provider_id: 'p', deployment_mode: 'API_MANAGED',
      lines: [line(0.1), refusal()],
      total_tokens: null, total_cost: { p50: 0.1, p90: 0.1, p99: null },
      currency: 'USD', confidence: 'NONE',
    });
    expect(isRankable(partial)).toBe(false);
    const r = rank({ candidates: [partial, candidate('real', 0.5)] });
    expect(r.cheapest!.model_id).toBe('real');
  });

  it('a candidate with no lines at all is not free either', () => {
    const empty = Candidate.parse({
      model_id: 'empty', provider_id: 'p', deployment_mode: 'API_MANAGED',
      lines: [], total_tokens: null, total_cost: { p50: 0, p90: 0, p99: null },
      currency: 'USD', confidence: 'NONE',
    });
    const r = rank({ candidates: [empty] });
    expect(r.cheapest).toBeNull();
    expect(r.excluded[0]!.detail).toMatch(/No estimate lines/);
  });
});

/* ══════════════ comparability ══════════════ */

describe('rank refuses to compare things that are not comparable', () => {
  it('two currencies stop the ranking rather than being converted', () => {
    const r = rank({
      candidates: [candidate('usd-model', 1), candidate('cny-model', 0.5, { currency: 'CNY' })],
    });
    expect(r.cheapest).toBeNull();
    expect(r.unrankable.map((u) => u.why).join(' ')).toMatch(/native currency|FX record/);
  });

  it('breaks ties deterministically, so re-sorting the registry cannot move the answer', () => {
    const a = rank({ candidates: [candidate('zeta', 1), candidate('alpha', 1)] });
    const b = rank({ candidates: [candidate('alpha', 1), candidate('zeta', 1)] });
    expect(a.cheapest!.model_id).toBe('alpha');
    expect(b.cheapest!.model_id).toBe('alpha');
  });

  it('names the runner-up in the rationale, so the margin is visible', () => {
    const r = rank({ candidates: [candidate('cheap', 0.2), candidate('dear', 0.9)] });
    expect(r.cheapest!.rationale.triggering_metric).toBe('total_cost.p50');
    expect(r.cheapest!.rationale.observed_value).toBe(0.2);
    expect(String(r.cheapest!.rationale.threshold)).toMatch(/dear.*0\.9/);
  });

  it('points the rationale at the rate behind the biggest line', () => {
    const c = Candidate.parse({
      model_id: 'm', provider_id: 'p', deployment_mode: 'API_MANAGED',
      lines: [line(0.1, { rate_record_id: 'small' }), line(0.9, { rate_record_id: 'dominant' })],
      total_tokens: null, total_cost: { p50: 1, p90: 1, p99: null },
      currency: 'USD', confidence: 'HIGH',
    });
    expect(rank({ candidates: [c] }).cheapest!.rationale.evidence_ref).toBe('dominant');
  });
});

/* ══════════════ §A6 — the objective that cannot be answered ══════════════ */

describe('best_capability and balanced refuse without a sourced quality score', () => {
  it('returns null rather than substituting price or context size', () => {
    // §A6: "do NOT invent benchmark scores. Null unless sourced." Both registry
    // rows today have quality_score: null, so this is the real-world outcome.
    const r = rank({ candidates: [candidate('a', 1), candidate('b', 2)] });
    expect(r.cheapest).not.toBeNull();
    expect(r.best_capability).toBeNull();
    expect(r.balanced).toBeNull();
    expect(r.unrankable.map((u) => u.objective)).toEqual(['best_capability', 'balanced']);
    expect(r.unrankable[0]!.why).toMatch(/forbids inventing benchmark scores/);
  });

  it('ranks on quality once scores are sourced', () => {
    const r = rank({
      candidates: [candidate('a', 1), candidate('b', 2)],
      quality_by_model: { a: 60, b: 90 },
    });
    expect(r.best_capability!.model_id).toBe('b');
    expect(r.best_capability!.rationale.triggering_metric).toBe('quality_score');
  });

  it('balanced trades cost against quality, and can differ from both others', () => {
    // a: 1.0 / 60 = 0.0167   b: 2.0 / 90 = 0.0222   -> a wins on ratio
    const r = rank({
      candidates: [candidate('a', 1), candidate('b', 2)],
      quality_by_model: { a: 60, b: 90 },
    });
    expect(r.cheapest!.model_id).toBe('a');
    expect(r.best_capability!.model_id).toBe('b');
    expect(r.balanced!.model_id).toBe('a');
    expect(r.balanced!.rationale.triggering_metric).toBe('cost_per_quality_point');
  });

  it('says when it ranked over only some of the candidates', () => {
    const r = rank({
      candidates: [candidate('a', 1), candidate('b', 2)],
      quality_by_model: { a: 60 },
    });
    expect(r.best_capability!.model_id).toBe('a');
    expect(r.unrankable.map((u) => u.why).join(' ')).toMatch(/1 of 2/);
  });
});

/* ══════════════ §A7 — split routing ══════════════ */

describe('splitRoute measures against a baseline that actually exists', () => {
  const cheapModel = 'lite';
  const frontier = 'frontier';

  it('assigns per task and reports the saving versus the best single model', () => {
    // §A7's own example: a cheap model for the many READs, a frontier one for the
    // few WRITEs. Here lite wins t1 and frontier wins t2.
    const r = splitRoute([
      { task_id: 't1', candidates: [candidate(cheapModel, 1), candidate(frontier, 10)] },
      { task_id: 't2', candidates: [candidate(cheapModel, 8), candidate(frontier, 4)] },
    ]);
    expect(r.split!.assignments).toEqual([
      expect.objectContaining({ task_id: 't1', model_id: cheapModel }),
      expect.objectContaining({ task_id: 't2', model_id: frontier }),
    ]);
    expect(r.split!.total_cost_p50).toBe(5);
    // Best single model: lite = 9, frontier = 14. Baseline 9, split 5 -> 44.4%.
    expect(r.split!.saving_vs_single_model_pct).toBeCloseTo(((9 - 5) / 9) * 100, 10);
  });

  it('the baseline is the cheapest model that can serve EVERY task, not the cheapest per task', () => {
    // If the baseline were the sum of per-task minima it would equal the split and
    // the saving would always be zero — the comparison has to be against a real
    // single-model arrangement.
    const r = splitRoute([
      { task_id: 't1', candidates: [candidate('a', 1), candidate('b', 5)] },
      { task_id: 't2', candidates: [candidate('a', 9), candidate('b', 2)] },
    ]);
    // a = 10, b = 7 -> baseline 7; split = 1 + 2 = 3.
    expect(r.split!.total_cost_p50).toBe(3);
    expect(r.split!.saving_vs_single_model_pct).toBeCloseTo(((7 - 3) / 7) * 100, 10);
  });

  it('reports NO saving when no single model can serve every task', () => {
    // Splitting is then the only arrangement that works. Claiming a saving against
    // an option that does not exist would be a fabrication.
    const r = splitRoute([
      { task_id: 't1', candidates: [candidate('vision-only', 1)] },
      { task_id: 't2', candidates: [candidate('text-only', 2)] },
    ]);
    expect(r.split!.total_cost_p50).toBe(3);
    expect(r.split!.saving_vs_single_model_pct).toBeNull();
    expect(r.notes.join(' ')).toMatch(/only arrangement that covers the workflow/);
  });

  it('says so when one model is cheapest everywhere and there is nothing to split', () => {
    const r = splitRoute([
      { task_id: 't1', candidates: [candidate('a', 1), candidate('b', 5)] },
      { task_id: 't2', candidates: [candidate('a', 1), candidate('b', 5)] },
    ]);
    expect(r.split!.saving_vs_single_model_pct).toBe(0);
    expect(r.notes.join(' ')).toMatch(/nothing to split/);
  });

  it('never assigns a task to a model whose estimate refused', () => {
    const r = splitRoute([
      { task_id: 't1', candidates: [refusedCandidate('broken'), candidate('real', 5)] },
    ]);
    expect(r.split!.assignments[0]!.model_id).toBe('real');
  });

  it('withholds the total when a task has no complete estimate at all', () => {
    const r = splitRoute([
      { task_id: 't1', candidates: [candidate('a', 1)] },
      { task_id: 't2', candidates: [refusedCandidate('broken')] },
    ]);
    expect(r.split!.total_cost_p50).toBeNull();
    expect(r.notes.join(' ')).toMatch(/would read as a workflow total/);
  });

  it('a split is never more expensive than the best single model', () => {
    // Structural: the split picks the cheapest option per task and the single model
    // is one of those options. A negative saving is a bug, not a finding.
    const r = splitRoute([
      { task_id: 't1', candidates: [candidate('a', 3), candidate('b', 7)] },
      { task_id: 't2', candidates: [candidate('a', 6), candidate('b', 2)] },
    ]);
    expect(r.split!.saving_vs_single_model_pct!).toBeGreaterThanOrEqual(0);
  });
});

/* ══════════════ the capability gate ══════════════ */

const task = (over: Record<string, unknown> = {}): Task =>
  ({
    task_id: 't1',
    sequence_index: 0,
    label: null,
    type: 'READ',
    sub_kind: null,
    volume: 1,
    expands_from: null,
    execution_probability: 1,
    text_metrics: null,
    image_metrics: null,
    media_metrics: null,
    expected_output_band: null,
    max_tokens: null,
    flags: {
      requires_reasoning: false,
      requires_vision: false,
      requires_tool_calling: false,
      requires_long_context: false,
      requires_structured_output: false,
      is_conversational: false,
      has_stable_prefix: false,
      latency_sensitive: false,
      data_residency_constraint: null,
      ...(over.flags as object ?? {}),
    },
    ...over,
  }) as Task;

const model = (over: Record<string, unknown> = {}): ModelRow =>
  ({
    model_id: 'm',
    display_name: 'M',
    provider: 'p',
    provider_origin: 'US',
    tier: 'MID',
    pricing_model: 'usage',
    modalities_in: ['text'],
    modalities_out: ['text'],
    context_window: s(200_000),
    max_output: s(8192),
    is_reasoning_model: false,
    supports_tools: true,
    supports_caching: false,
    supports_vision: false,
    open_weights: false,
    license: null,
    served_quantization: 'unknown',
    tokenizer: {
      availability: 'REMOTE_API', identifier: null, revision_hash: null,
      proxy_for: null, proxy_basis: null, measured_delta_pct: null,
      tokenizer_multiplier: s(1), framing_tokens_per_message: s(3),
      conversation_preamble_tokens: s(7),
    },
    text_rates: [{
      variant: 'standard',
      currency: 'USD',
      input_rate_by_modality: { text: rate(3), image: null, audio: null, video: null },
      output_rate: rate(15),
      reasoning_output_rate: null,
      per_request_fee: null,
      context_tiers: null,
      cache: null,
      tool_use_system_prompt_tokens: [],
      server_tool_fees: [],
    }],
    service_tiers: [],
    vision: null, image_gen: null, video_gen: null, video_in: null, audio_in: null, hardware: null,
    compliance: {
      data_residency_region: ['us'], is_prc_hosted: false,
      contractual_dpa_available: true, residency_uplift_pct: s(0), notes: null,
    },
    quality_score: null, quality_score_source_url: null,
    effective_from: '2026-01-01T00:00:00.000Z', effective_to: null, deprecation_date: null,
    ...over,
  }) as unknown as ModelRow;

describe('capabilityGate drops loudly, never silently', () => {
  it('drops a text-only model when the workflow needs vision, and names the reason', () => {
    const r = capabilityGate({
      models: [model({ model_id: 'text-only' })],
      tasks: [task({ flags: { requires_vision: true } })],
    });
    expect(r.eligible).toHaveLength(0);
    expect(r.excluded[0]!.reason).toBe('MISSING_MODALITY');
    expect(r.excluded[0]!.detail).toMatch(/image/);
  });

  it('drops a model with no tool support when a task needs tools', () => {
    const r = capabilityGate({
      models: [model({ supports_tools: false })],
      tasks: [task({ flags: { requires_tool_calling: true } })],
    });
    expect(r.excluded[0]!.reason).toBe('NO_TOOL_SUPPORT');
  });

  it('drops on a stated residency constraint the model does not serve', () => {
    const r = capabilityGate({
      models: [model({ model_id: 'us-only' })],
      tasks: [task({ flags: { data_residency_constraint: 'eu' } })],
    });
    expect(r.excluded[0]!.reason).toBe('DATA_RESIDENCY_BLOCKED');
    expect(r.excluded[0]!.detail).toMatch(/'eu'/);
  });

  it('drops a request that cannot fit the context window', () => {
    const r = capabilityGate({
      models: [model({ context_window: s(1_000) })],
      tasks: [task()],
      input_tokens_by_task: { t1: 5_000 },
    });
    expect(r.excluded[0]!.reason).toBe('CONTEXT_TOO_SMALL');
  });

  it('an UNKNOWN context window is an UNVERIFIED check, not a pass', () => {
    // The Gemini row is exactly this: Google's spec tables are JS-rendered and the
    // window was never fetched. Passing it silently would claim a fit nobody checked.
    const r = capabilityGate({
      models: [model({ context_window: s(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })) })],
      tasks: [task()],
      input_tokens_by_task: { t1: 5_000 },
    });
    expect(r.eligible).toHaveLength(1);
    expect(r.unverified[0]!.check).toBe('context_window');
    expect(r.unverified[0]!.why).toMatch(/nothing here can tell/);
  });

  it('a missing token estimate is also unverified rather than assumed to fit', () => {
    const r = capabilityGate({ models: [model()], tasks: [task()] });
    expect(r.eligible).toHaveLength(1);
    expect(r.unverified[0]!.why).toMatch(/the fit was not checked/);
  });

  it('a vision-geometry refusal only excludes when the workflow needs vision', () => {
    const visionless = model({
      model_id: 'no-geometry',
      supports_vision: true,
      modalities_in: ['text', 'image'],
      vision: {
        geometry: { geometry: 'UNAVAILABLE', reason: 'undocumented', probe_candidate: true },
        low_detail: { kind: 'UNSUPPORTED' },
        constraints: {
          max_edge_px: s(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
          min_edge_px: s(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
          shortest_edge_target_px: s(null),
          max_bytes: s(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
          max_pages: s(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
          allowed_mime: [], provider_auto_normalizes: false, min_legible_edge_px: [],
          max_context_tokens: s(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
        },
        provenance: prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }),
      },
    });
    const textOnly = capabilityGate({ models: [visionless], tasks: [task()] });
    const withVision = capabilityGate({
      models: [visionless],
      tasks: [task({ flags: { requires_vision: true } })],
    });
    expect(textOnly.eligible).toHaveLength(1);
    expect(withVision.excluded).toHaveLength(1);
  });
});

/* ══════════ a model you cannot call is not a cheap model ══════════ */

describe('the lifecycle fields nothing was reading', () => {
  const AT = new Date('2026-09-09T00:00:00.000Z');
  const gate = (over: Record<string, unknown>) =>
    capabilityGate({ models: [model(over)], tasks: [task()], at: AT });

  it('IN_SERVICE by default — no dates set is not a reason to drop anything', () => {
    const r = gate({});
    expect(r.eligible.map((m) => m.model_id)).toEqual(['m']);
    expect(r.warnings).toEqual([]);
  });

  it('WITHDRAWN is excluded, and the reason names the date rather than the symptom', () => {
    // Before this, `effective_to` was read by nothing: the router would rank a
    // shut-down model at a price that is correct for something you cannot call.
    const r = gate({ effective_to: '2026-03-01T00:00:00.000Z' });
    expect(r.eligible).toEqual([]);
    expect(r.excluded[0]!.reason).toBe('MODEL_NOT_IN_SERVICE');
    expect(r.excluded[0]!.detail).toMatch(/Withdrawn/);
    expect(r.excluded[0]!.detail).toContain('2026-03-01');
  });

  it('NOT_YET_AVAILABLE is excluded too — an announced model is not a callable one', () => {
    const r = gate({ effective_from: '2027-01-01T00:00:00.000Z' });
    expect(r.eligible).toEqual([]);
    expect(r.excluded[0]!.reason).toBe('MODEL_NOT_IN_SERVICE');
    expect(r.excluded[0]!.detail).toMatch(/Not yet available/);
  });

  it('DEPRECATED is NOT excluded — it still answers, and may still be cheapest', () => {
    // The distinction that matters. Dropping it would hide a model that works;
    // ranking it silently would hand somebody a migration they never agreed to.
    const r = gate({ deprecation_date: '2026-06-01T00:00:00.000Z' });
    expect(r.eligible.map((m) => m.model_id)).toEqual(['m']);
    expect(r.warnings.map((w) => w.code)).toEqual(['MODEL_DEPRECATED']);
    expect(r.warnings[0]!.message).toContain('2026-06-01');
  });

  it('withdrawn beats deprecated — a shut-down model is not merely deprecated', () => {
    const r = gate({
      deprecation_date: '2026-06-01T00:00:00.000Z',
      effective_to: '2026-08-01T00:00:00.000Z',
    });
    expect(r.excluded[0]!.reason).toBe('MODEL_NOT_IN_SERVICE');
    expect(r.warnings).toEqual([]);
  });

  it('the lifecycle check runs BEFORE capability, so the reason is the useful one', () => {
    // A shut-down model also lacks vision, lacks tools, and fails every other
    // check. "Migrate off this model" is the sentence that helps; "it lacks
    // vision" sends the reader to fix the wrong thing.
    const r = capabilityGate({
      models: [model({ effective_to: '2026-03-01T00:00:00.000Z', supports_tools: false })],
      tasks: [task({ flags: { ...task().flags, requires_tool_calling: true } })],
      at: AT,
    });
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]!.reason).toBe('MODEL_NOT_IN_SERVICE');
  });

  it('route() carries the deprecation warning out to the caller', () => {
    const r = route({
      models: [model({ deprecation_date: '2026-06-01T00:00:00.000Z' })],
      tasks: [task()],
      candidates: [],
      at: AT,
    });
    expect(r.warnings.map((w) => w.code)).toContain('MODEL_DEPRECATED');
  });
});


/* ══════════════ end to end ══════════════ */

describe('route gates before it ranks', () => {
  it('never recommends a model the gate removed, even if a candidate exists for it', () => {
    const r = route({
      models: [model({ model_id: 'text-only' })],
      tasks: [task({ flags: { requires_vision: true } })],
      candidates: [candidate('text-only', 0.01)],
    });
    expect(r.recommendations.cheapest).toBeNull();
    expect(r.excluded[0]!.reason).toBe('MISSING_MODALITY');
  });

  it('keeps gate exclusions and ranking exclusions separate', () => {
    const r = route({
      models: [model({ model_id: 'ok' }), model({ model_id: 'no-tools', supports_tools: false })],
      tasks: [task({ flags: { requires_tool_calling: true } })],
      candidates: [candidate('ok', 1), refusedCandidate('no-tools')],
    });
    const reasons = r.excluded.map((e) => e.reason);
    expect(reasons).toContain('NO_TOOL_SUPPORT');
    expect(reasons).not.toContain('ESTIMATE_INCOMPLETE'); // it never reached ranking
    expect(r.recommendations.cheapest!.model_id).toBe('ok');
  });

  it('surfaces every null objective with a reason', () => {
    const r = route({
      models: [model({ model_id: 'ok' })],
      tasks: [task()],
      candidates: [candidate('ok', 1)],
    });
    expect(r.recommendations.cheapest).not.toBeNull();
    expect(r.recommendations.best_capability).toBeNull();
    expect(r.notes.join(' ')).toMatch(/best_capability:.*quality_score/);
  });
});
