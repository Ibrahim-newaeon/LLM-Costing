import { describe, it, expect } from 'vitest';
import {
  Range,
  EstimateLine,
  Candidate,
  EstimateOutput,
  Optimization,
  Evidence,
  ExclusionReason,
  billableQuantity,
} from './estimate';
import { Method, Confidence } from './provenance';

const line = (over: Record<string, unknown> = {}) => ({
  task_id: 't1',
  component: 'prompt_input' as const,
  quantity: { p50: 1000, p90: 1400 },
  unit: 'tokens' as const,
  rate_record_id: 'rate-1',
  cost: { p50: 0.003, p90: 0.0042 },
  method: 'EXACT_TOKENIZER' as const,
  confidence: 'HIGH' as const,
  ...over,
});

const candidate = (over: Record<string, unknown> = {}) => ({
  model_id: 'model-a',
  provider_id: 'provider-a',
  deployment_mode: 'API_MANAGED' as const,
  lines: [line()],
  total_cost: { p50: 0.003, p90: 0.0042 },
  currency: 'USD',
  confidence: 'HIGH' as const,
  ...over,
});

const estimate = (over: Record<string, unknown> = {}) => ({
  estimate_id: 'e1',
  generated_at: '2026-09-07T12:00:00.000Z',
  pricing_snapshot_id: 'snap-1',
  candidates: [candidate()],
  assumptions: [],
  evidence: [],
  confidence: 'HIGH' as const,
  needs_human_review: false,
  missing_data: [],
  ...over,
});

describe('the enums that had drifted', () => {
  it('Method is the full eleven, not the six the old schema carried', () => {
    expect(Method.options).toHaveLength(11);
    for (const m of ['PROVIDER_FORMULA', 'TOKENIZER_SCALED', 'EXACT_PROXY', 'DERIVED', 'MEASURED_PROBE']) {
      expect(Method.options).toContain(m);
    }
  });

  it('Confidence carries NONE, which the old schema omitted', () => {
    expect(Confidence.options).toContain('NONE');
  });

  it('ExclusionReason is about the pairing, not the row', () => {
    // Overlaps registry.ts's Ineligibility on exactly one member. Keeping them
    // separate is deliberate: residency, context size and asset limits are
    // properties of THIS request, not of the model.
    const ineligibility = [
      'SUBSCRIPTION_NON_COMPARABLE',
      'VISION_GEOMETRY_UNAVAILABLE',
      'NO_USABLE_RATE',
      'TOKENIZER_UNAVAILABLE',
    ];
    const shared = ExclusionReason.options.filter((r) => ineligibility.includes(r));
    expect(shared).toEqual(['TOKENIZER_UNAVAILABLE']);
  });
});

describe('Range (rule 3)', () => {
  it('rejects an inverted band', () => {
    expect(Range.safeParse({ p50: 10, p90: 4 }).success).toBe(false);
    expect(Range.safeParse({ p50: 10, p90: 14 }).success).toBe(true);
  });

  it('rejects a p99 below p90', () => {
    expect(Range.safeParse({ p50: 10, p90: 14, p99: 12 }).success).toBe(false);
    expect(Range.safeParse({ p50: 10, p90: 14, p99: 20 }).success).toBe(true);
  });
});

describe('EstimateLine', () => {
  it('ties NONE to UNAVAILABLE in both directions', () => {
    expect(EstimateLine.safeParse(line({ method: 'UNAVAILABLE' })).success).toBe(false);
    expect(EstimateLine.safeParse(line({ confidence: 'NONE' })).success).toBe(false);
    const refusal = EstimateLine.safeParse({
      task_id: 't1',
      component: 'prompt_input',
      method: 'UNAVAILABLE',
      confidence: 'NONE',
    });
    expect(refusal.success).toBe(true);
  });

  it('lets only a refusal omit the rate it priced against', () => {
    expect(EstimateLine.safeParse(line({ rate_record_id: null })).success).toBe(false);
  });

  it('requires a cost on anything that is not a refusal', () => {
    expect(EstimateLine.safeParse(line({ cost: null })).success).toBe(false);
  });

  it('rejects a quantity with no unit', () => {
    expect(EstimateLine.safeParse(line({ unit: null })).success).toBe(false);
  });

  describe('the safety pad never becomes a price', () => {
    it('rejects padding below the quantity it pads', () => {
      expect(EstimateLine.safeParse(line({ context_safety_quantity: 900 })).success).toBe(false);
    });

    it('lets tier 3 pad past the band', () => {
      expect(
        EstimateLine.safeParse(
          line({ tier: 3, method: 'CALIBRATED_HEURISTIC', confidence: 'MEDIUM', context_safety_quantity: 1610 }),
        ).success,
      ).toBe(true);
    });

    it('refuses to let a measured tier inflate what it counted', () => {
      expect(
        EstimateLine.safeParse(line({ tier: 1, context_safety_quantity: 1610 })).success,
      ).toBe(false);
      expect(EstimateLine.safeParse(line({ tier: 1, context_safety_quantity: 1400 })).success).toBe(
        true,
      );
    });

    it('billableQuantity returns the measured quantity, never the pad', () => {
      const l = EstimateLine.parse(line({ tier: 3, method: 'CALIBRATED_HEURISTIC', confidence: 'MEDIUM', context_safety_quantity: 1610 }));
      expect(billableQuantity(l)).toEqual(expect.objectContaining({ p50: 1000, p90: 1400 }));
      expect(billableQuantity(l)).not.toHaveProperty('context_safety_quantity');
    });
  });

  it('refuses a cache key that omits the tokenizer revision', () => {
    expect(
      EstimateLine.safeParse(line({ cache: { hit: true, key_includes_tokenizer_revision: false } }))
        .success,
    ).toBe(false);
    expect(
      EstimateLine.safeParse(line({ cache: { hit: true, key_includes_tokenizer_revision: true } }))
        .success,
    ).toBe(true);
  });

  it('forces LOW when an unvalidated proxy produced the count', () => {
    const proxy = { target_model: 'closed-a', proxy_model: 'open-b', basis: 'ARCHITECTURE_ONLY' };
    expect(
      EstimateLine.safeParse(line({ method: 'EXACT_PROXY', tokenizer_proxy: proxy })).success,
    ).toBe(false);
    expect(
      EstimateLine.safeParse(
        line({ method: 'EXACT_PROXY', confidence: 'LOW', tokenizer_proxy: proxy }),
      ).success,
    ).toBe(true);
    expect(
      EstimateLine.safeParse(
        line({
          method: 'EXACT_PROXY',
          tokenizer_proxy: { ...proxy, measured_delta_pct: 3.2 },
        }),
      ).success,
    ).toBe(true);
  });
});

describe('Candidate — §A3.7 confidence is computed, never typed in', () => {
  it('rejects a candidate that claims more than its weakest line', () => {
    const c = candidate({
      lines: [line(), line({ task_id: 't2', method: 'CALIBRATED_HEURISTIC', confidence: 'MEDIUM' })],
      confidence: 'HIGH',
    });
    expect(Candidate.safeParse(c).success).toBe(false);
    expect(Candidate.safeParse({ ...c, confidence: 'MEDIUM' }).success).toBe(true);
  });

  it('a HIGH count against an UNAVAILABLE rate is not an estimate', () => {
    const c = candidate({
      lines: [
        line(),
        { task_id: 't2', component: 'completion_output', method: 'UNAVAILABLE', confidence: 'NONE' },
      ],
      confidence: 'NONE',
    });
    expect(Candidate.safeParse(c).success).toBe(true);
    expect(Candidate.safeParse({ ...c, confidence: 'LOW' }).success).toBe(false);
  });

  it('a candidate with no lines is NONE, not HIGH by vacuity', () => {
    expect(Candidate.safeParse(candidate({ lines: [], confidence: 'HIGH' })).success).toBe(false);
    expect(Candidate.safeParse(candidate({ lines: [], confidence: 'NONE' })).success).toBe(true);
  });

  it('requires a dated fx ref when the display currency differs', () => {
    expect(Candidate.safeParse(candidate({ display_currency: 'SAR' })).success).toBe(false);
    expect(
      Candidate.safeParse(candidate({ display_currency: 'SAR', fx_rate_ref: 'fx-2026-09-07' }))
        .success,
    ).toBe(true);
    expect(Candidate.safeParse(candidate({ display_currency: 'USD' })).success).toBe(true);
  });

  it('will not compare a self-hosted candidate without its VRAM detail', () => {
    expect(Candidate.safeParse(candidate({ deployment_mode: 'SELF_HOSTED' })).success).toBe(false);
    expect(
      Candidate.safeParse(
        candidate({
          deployment_mode: 'SELF_HOSTED',
          self_hosted_detail: { vram_feasible: true, utilization_factor: 0.6, rate_basis: 'ON_DEMAND' },
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects self-hosted detail on an API_MANAGED candidate', () => {
    expect(
      Candidate.safeParse(
        candidate({
          self_hosted_detail: { vram_feasible: true, utilization_factor: 0.6, rate_basis: 'SPOT' },
        }),
      ).success,
    ).toBe(false);
  });
});

describe('Optimization', () => {
  const rationale = { triggering_metric: 'cache_hit_rate', observed_value: 0.1, threshold: 0.5 };

  it('makes a projected saving state what gets worse', () => {
    expect(
      Optimization.safeParse({
        lever: 'USE_LOW_DETAIL_VISION',
        projected_saving_pct: 40,
        rationale,
      }).success,
    ).toBe(false);
    expect(
      Optimization.safeParse({
        lever: 'USE_LOW_DETAIL_VISION',
        projected_saving_pct: 40,
        tradeoff: 'Small text in scanned Arabic pages becomes unreadable to the model.',
        rationale,
      }).success,
    ).toBe(true);
  });
});

describe('Evidence', () => {
  it('rejects a vendor doc with no URL', () => {
    expect(Evidence.safeParse({ ref: 'e1', kind: 'VENDOR_DOC', source_url: null, verified_at: null }).success).toBe(false);
  });
});

describe('EstimateOutput', () => {
  it('accepts a coherent estimate', () => {
    expect(EstimateOutput.safeParse(estimate()).success).toBe(true);
  });

  it('propagates confidence by minimum over candidates', () => {
    const e = estimate({
      candidates: [
        candidate(),
        candidate({
          model_id: 'model-b',
          lines: [line({ method: 'CALIBRATED_HEURISTIC', confidence: 'LOW' })],
          confidence: 'LOW',
        }),
      ],
      confidence: 'HIGH',
    });
    expect(EstimateOutput.safeParse(e).success).toBe(false);
    expect(EstimateOutput.safeParse({ ...e, confidence: 'LOW' }).success).toBe(true);
  });

  it('will not ship a refusal without flagging it', () => {
    const e = estimate({ candidates: [], confidence: 'NONE', needs_human_review: false });
    expect(EstimateOutput.safeParse(e).success).toBe(false);
    expect(EstimateOutput.safeParse({ ...e, needs_human_review: true }).success).toBe(true);
  });

  it('requires review behind a BLOCKING warning', () => {
    const e = estimate({
      warnings: [{ code: 'RATE_CONFLICT_UNRESOLVED', message: 'two sources disagree', severity: 'BLOCKING' }],
    });
    expect(EstimateOutput.safeParse(e).success).toBe(false);
  });

  it('rejects a recommendation for a model that was never costed', () => {
    const e = estimate({
      recommendations: {
        cheapest: {
          model_id: 'model-never-priced',
          rationale: { triggering_metric: 'total_cost', observed_value: 1, threshold: 2 },
        },
      },
    });
    expect(EstimateOutput.safeParse(e).success).toBe(false);
  });

  it('rejects a model that is both a candidate and excluded', () => {
    const e = estimate({
      excluded_models: [{ model_id: 'model-a', reason: 'RATE_STALE' }],
    });
    expect(EstimateOutput.safeParse(e).success).toBe(false);
  });

  it('rejects duplicate evidence refs, which make a rationale ambiguous', () => {
    const ev = { ref: 'e1', kind: 'PRICING_RECORD' as const, source_url: null, verified_at: null };
    expect(EstimateOutput.safeParse(estimate({ evidence: [ev, ev] })).success).toBe(false);
  });
});
