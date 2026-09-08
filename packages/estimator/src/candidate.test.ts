import { describe, it, expect } from 'vitest';
import { Candidate } from '@tokenomics/contracts';
import { buildLine, assembleCandidate, contextOverflow } from './candidate';

const line = (over: Record<string, unknown> = {}) =>
  buildLine({
    task_id: 't1',
    component: 'prompt_input',
    quantity: { p50: 1000, p90: 1400, p99: null },
    unit: 'tokens',
    rate_amount: 0.000003,
    rate_record_id: 'rate-1',
    method: 'EXACT_TOKENIZER',
    confidence: 'HIGH',
    tier: 2,
    ...over,
  } as never);

describe('buildLine', () => {
  it('prices both ends of the band', () => {
    const l = line();
    expect(l.cost).toEqual({ p50: 1000 * 0.000003, p90: 1400 * 0.000003, p99: null });
  });

  it('produces a valid refusal — no rate, no cost, NONE confidence', () => {
    const l = line({ method: 'UNAVAILABLE', quantity: null, unit: null, rate_amount: null });
    expect(l.method).toBe('UNAVAILABLE');
    expect(l.confidence).toBe('NONE');
    expect(l.cost).toBeNull();
    expect(l.rate_record_id).toBeNull();
  });
});

describe('assembleCandidate — §A5.8', () => {
  it('sums the lines and computes confidence from them', () => {
    const c = assembleCandidate({
      model_id: 'm1',
      provider_id: 'p1',
      deployment_mode: 'API_MANAGED',
      currency: 'USD',
      lines: [line(), line({ task_id: 't2', component: 'completion_output', confidence: 'MEDIUM', method: 'CALIBRATED_HEURISTIC', tier: 3 })],
    });
    expect(c.total_cost.p50).toBeCloseTo(2 * 1000 * 0.000003, 12);
    // The weakest line governs, and the contract itself rejects anything else.
    expect(c.confidence).toBe('MEDIUM');
  });

  it('a candidate with no lines is NONE, not HIGH by vacuity', () => {
    const c = assembleCandidate({
      model_id: 'm1', provider_id: 'p1', deployment_mode: 'API_MANAGED', currency: 'USD', lines: [],
    });
    expect(c.confidence).toBe('NONE');
  });

  it('an UNAVAILABLE line drags the whole candidate to NONE', () => {
    const c = assembleCandidate({
      model_id: 'm1', provider_id: 'p1', deployment_mode: 'API_MANAGED', currency: 'USD',
      lines: [
        line(),
        line({ task_id: 't2', component: 'completion_output', method: 'UNAVAILABLE', quantity: null, unit: null, rate_amount: null }),
      ],
    });
    expect(c.confidence).toBe('NONE');
    // and it still parses — the contract's NONE <-> UNAVAILABLE rule is satisfied
    expect(() => Candidate.parse(c)).not.toThrow();
  });

  it('subtotals input tokens across every input-side component', () => {
    const c = assembleCandidate({
      model_id: 'm1', provider_id: 'p1', deployment_mode: 'API_MANAGED', currency: 'USD',
      lines: [
        line(),
        line({ task_id: 't1', component: 'framing_overhead', quantity: { p50: 19, p90: 19, p99: null } }),
        line({ task_id: 't1', component: 'tool_schema', quantity: { p50: 400, p90: 450, p99: null } }),
      ],
    });
    expect(c.total_tokens?.input).toEqual({ p50: 1419, p90: 1869, p99: null });
  });
});

describe('the cache decomposition is algebraically the §A5.8 credit', () => {
  it('uncached x input + cached x read == total x input - cached x (input - read)', () => {
    const inputRate = 0.000003;
    const readRate = 0.0000003;
    const cached = 9000;
    const uncached = 1000;

    const decomposed = uncached * inputRate + cached * readRate;
    const credited = (uncached + cached) * inputRate - cached * (inputRate - readRate);
    expect(decomposed).toBeCloseTo(credited, 15);
  });

  it('and the decomposition is what the contract can represent', () => {
    // EstimateLine.cost is a nonnegative Range, so a credit line is unrepresentable.
    expect(() =>
      buildLine({
        task_id: 't1', component: 'cache_read', quantity: { p50: -9000, p90: -9000, p99: null },
        unit: 'tokens', rate_amount: 0.0000003, rate_record_id: 'r', method: 'PROVIDER_FORMULA',
        confidence: 'HIGH',
      } as never),
    ).toThrow();
  });
});

describe('contextOverflow — the only consumer of the padded number', () => {
  it('uses the padded quantity where one exists', () => {
    const lines = [
      // tier 3: only the heuristic tier may pad past the measured band
      line({ tier: 3, method: 'CALIBRATED_HEURISTIC', confidence: 'MEDIUM', context_safety_quantity: 1610 }),
      line({ task_id: 't1', component: 'tool_schema', quantity: { p50: 400, p90: 450, p99: null } }),
    ];
    const r = contextOverflow(lines, 4000);
    expect(r.safety_tokens).toBe(1610 + 450);
    expect(r.fits).toBe(true);
  });

  it('reports a request that does not fit', () => {
    const r = contextOverflow(
      [line({ tier: 3, method: 'CALIBRATED_HEURISTIC', confidence: 'MEDIUM', quantity: { p50: 400_000, p90: 450_000, p99: null }, context_safety_quantity: 500_000 })],
      200_000,
    );
    expect(r.fits).toBe(false);
    expect(r.headroom_tokens).toBeLessThan(0);
  });
});
