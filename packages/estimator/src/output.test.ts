import { describe, it, expect } from 'vitest';
import { OutputPrior } from '@tokenomics/contracts';
import { estimateOutputTokens } from './output';

const prov = (over: Record<string, unknown> = {}) => ({
  method: 'CALIBRATED_HEURISTIC',
  confidence: 'MEDIUM',
  source_class: 'MEASURED',
  source_url: 'https://example.invalid/calibration',
  verified_at: '2026-09-01T00:00:00.000Z',
  verified_by: null,
  notes: null,
  ...over,
});

const prior = (over: Record<string, unknown> = {}) =>
  OutputPrior.parse({
    model_id: 'm1',
    band: 'medium',
    output_tokens: { p50: 400, p90: 900 },
    reasoning_tokens: null,
    n_samples: 250,
    seed_provenance: 'CALIBRATED_FROM_OBSERVED',
    provenance: prov(),
    ...over,
  });

const base = {
  model_id: 'm1',
  band: 'medium' as const,
  is_reasoning_model: false,
  max_tokens: null,
  max_tokens_includes_reasoning: false,
};

const ok = (r: ReturnType<typeof estimateOutputTokens>) => {
  if (r.status !== 'ESTIMATED') throw new Error(r.reason);
  return r;
};

describe('a prior is required — §A5.4 forbids inventing one', () => {
  it('refuses when the band has no calibrated prior', () => {
    const r = estimateOutputTokens({ ...base, priors: [prior({ band: 'short' })] });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.missing_data.field).toContain('medium');
  });

  it('estimates from a matching prior', () => {
    const r = ok(estimateOutputTokens({ ...base, priors: [prior()] }));
    expect(r.billable_output).toEqual({ p50: 400, p90: 900, p99: null });
  });
});

describe('reasoning tokens are invisible but billed', () => {
  it('REFUSES a reasoning model whose prior has no reasoning term', () => {
    const r = estimateOutputTokens({ ...base, is_reasoning_model: true, priors: [prior()] });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') {
      expect(r.missing_data.field).toContain('reasoning_tokens');
      expect(r.reason).toContain('invisible');
    }
  });

  it('adds reasoning to the bill when the prior carries it', () => {
    const r = ok(
      estimateOutputTokens({
        ...base,
        is_reasoning_model: true,
        priors: [prior({ reasoning_tokens: { p50: 1200, p90: 4000 } })],
      }),
    );
    // The invisible half is over four times the visible one here.
    expect(r.visible_output.p90).toBe(900);
    expect(r.reasoning?.p90).toBe(4000);
    expect(r.billable_output.p90).toBe(4900);
  });

  it('flags that the reasoning term is an estimate of something unobservable', () => {
    const r = ok(
      estimateOutputTokens({
        ...base,
        is_reasoning_model: true,
        priors: [prior({ reasoning_tokens: { p50: 100, p90: 200 } })],
      }),
    );
    expect(r.warnings).toContain('REASONING_TOKENS_ESTIMATED');
  });
});

describe('max_tokens is a clamp, not a forecast', () => {
  it('warns when the cap is below p90 and says truncation, not savings', () => {
    const r = ok(estimateOutputTokens({ ...base, priors: [prior()], max_tokens: 500 }));
    expect(r.warnings).toContain('MAX_TOKENS_BELOW_P90');
    expect(r.truncation_likely).toBe(true);
    expect(r.visible_output.p90).toBe(500);
    expect(r.notes.join(' ')).toContain('lowers the BILL, not the risk');
  });

  it('does not warn when the cap is comfortably above p90', () => {
    const r = ok(estimateOutputTokens({ ...base, priors: [prior()], max_tokens: 4000 }));
    expect(r.warnings).not.toContain('MAX_TOKENS_BELOW_P90');
    expect(r.truncation_likely).toBe(false);
    expect(r.visible_output.p90).toBe(900);
  });

  it('squeezes visible output when reasoning counts against the cap', () => {
    const withReasoning = prior({ reasoning_tokens: { p50: 1200, p90: 4000 } });
    const counts = ok(
      estimateOutputTokens({
        ...base, is_reasoning_model: true, priors: [withReasoning],
        max_tokens: 4200, max_tokens_includes_reasoning: true,
      }),
    );
    const separate = ok(
      estimateOutputTokens({
        ...base, is_reasoning_model: true, priors: [withReasoning],
        max_tokens: 4200, max_tokens_includes_reasoning: false,
      }),
    );
    // Same cap, same prior, materially different answer — which is why the flag has
    // no default. Reasoning eats 4000 of 4200, leaving 200 for the visible answer.
    expect(counts.visible_output.p90).toBe(200);
    expect(separate.visible_output.p90).toBe(900);
    expect(counts.notes.join(' ')).toContain('counts against max_tokens');
  });

  it('refuses an unbounded band with no cap — that is an open cheque', () => {
    const r = estimateOutputTokens({
      ...base,
      band: 'unbounded',
      priors: [prior({ band: 'unbounded', output_tokens: { p50: 2000, p90: 16000 } })],
      max_tokens: null,
    });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.missing_data.field).toBe('max_tokens');
  });

  it('prices an unbounded band once a cap exists', () => {
    const r = ok(
      estimateOutputTokens({
        ...base,
        band: 'unbounded',
        priors: [prior({ band: 'unbounded', output_tokens: { p50: 2000, p90: 16000 } })],
        max_tokens: 8000,
      }),
    );
    expect(r.visible_output.p90).toBe(8000);
    expect(r.warnings).toContain('MAX_TOKENS_BELOW_P90');
  });
});

describe('the prior carries its own honesty', () => {
  it('reports a seed as a seed', () => {
    const r = ok(
      estimateOutputTokens({
        ...base,
        priors: [prior({ n_samples: 0, seed_provenance: 'SEED_UNCALIBRATED', provenance: prov({ confidence: 'LOW' }) })],
      }),
    );
    expect(r.confidence).toBe('LOW');
    expect(r.notes.join(' ')).toContain('seed');
  });
});

describe('OutputPrior contract', () => {
  it('rejects an unbounded band with a zero-width distribution', () => {
    const r = OutputPrior.safeParse({
      model_id: 'm1', band: 'unbounded',
      output_tokens: { p50: 500, p90: 500 },
      n_samples: 100, seed_provenance: 'CALIBRATED_FROM_OBSERVED', provenance: prov(),
    });
    expect(r.success).toBe(false);
  });

  it('rejects an inverted distribution', () => {
    expect(
      OutputPrior.safeParse({
        model_id: 'm1', band: 'short', output_tokens: { p50: 900, p90: 400 },
        n_samples: 10, seed_provenance: 'CALIBRATED_FROM_OBSERVED', provenance: prov(),
      }).success,
    ).toBe(false);
  });

  it('holds a seeded prior at LOW', () => {
    expect(
      OutputPrior.safeParse({
        model_id: 'm1', band: 'short', output_tokens: { p50: 100, p90: 200 },
        n_samples: 0, seed_provenance: 'SEED_UNCALIBRATED', provenance: prov({ confidence: 'HIGH' }),
      }).success,
    ).toBe(false);
  });
});
