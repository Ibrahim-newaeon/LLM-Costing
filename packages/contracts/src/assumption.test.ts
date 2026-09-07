import { describe, it, expect } from 'vitest';
import {
  Assumption,
  Ambiguity,
  MissingDatum,
  Impact,
  ImpactIfWrong,
  SeedProvenance,
  DEFAULT_APPLIED,
  assumptionConfidenceCeiling,
  stackedAssumptionCeiling,
} from './assumption';

const base = {
  field: 'page_count',
  value: 12,
  basis: 'measured from the uploaded PDF',
  impact_if_wrong: 'MEDIUM' as const,
};

const seed = (over: Record<string, unknown> = {}) =>
  Assumption.parse({
    field: 'page_count',
    value: 10,
    basis: DEFAULT_APPLIED,
    seed_provenance: 'SEED_UNCALIBRATED',
    impact_if_wrong: 'HIGH',
    ...over,
  });

describe('the two impact scales stay separate', () => {
  // Guard against a future "reconciliation". They share ORDER_OF_MAGNITUDE and
  // nothing else, and they attach to different objects.
  it('Impact is the ambiguity scale, three values', () => {
    expect(Impact.options).toEqual(['COSMETIC', 'MATERIAL', 'ORDER_OF_MAGNITUDE']);
  });

  it('ImpactIfWrong is the assumption scale, four values', () => {
    expect(ImpactIfWrong.options).toEqual(['LOW', 'MEDIUM', 'HIGH', 'ORDER_OF_MAGNITUDE']);
  });

  it('overlap is exactly one member', () => {
    const shared = Impact.options.filter((v) => (ImpactIfWrong.options as string[]).includes(v));
    expect(shared).toEqual(['ORDER_OF_MAGNITUDE']);
  });

  it('rejects an ambiguity impact used as an assumption impact', () => {
    expect(Assumption.safeParse({ ...base, impact_if_wrong: 'COSMETIC' }).success).toBe(false);
  });
});

describe('Assumption', () => {
  it('accepts a minimal assumption and applies the defaults', () => {
    const a = Assumption.parse(base);
    expect(a.user_editable).toBe(true);
    expect(a.sensitivity_rank).toBeNull();
    expect(a.seed_provenance).toBeNull();
    expect(a.id).toBeNull();
    expect(a.task_id).toBeNull();
  });

  it('requires the value that was assumed', () => {
    const { value, ...withoutValue } = base;
    void value;
    const r = Assumption.safeParse(withoutValue);
    expect(r.success).toBe(false);
  });

  it('accepts a falsy value — 0 pages assumed is still an assumption', () => {
    expect(Assumption.safeParse({ ...base, value: 0 }).success).toBe(true);
    expect(Assumption.safeParse({ ...base, value: false }).success).toBe(true);
    expect(Assumption.safeParse({ ...base, value: null }).success).toBe(true);
  });

  it('forces a SEED_UNCALIBRATED assumption to declare itself in basis', () => {
    const r = Assumption.safeParse({
      ...base,
      seed_provenance: 'SEED_UNCALIBRATED',
      basis: 'typical for this document class',
    });
    expect(r.success).toBe(false);
  });

  it('allows a calibrated seed to carry a descriptive basis', () => {
    const r = Assumption.safeParse({
      ...base,
      seed_provenance: 'CALIBRATED_FROM_OBSERVED',
      basis: 'median of 412 observed runs',
    });
    expect(r.success).toBe(true);
  });

  it('rejects sensitivity_rank 0 — ranks are 1-based', () => {
    expect(Assumption.safeParse({ ...base, sensitivity_rank: 0 }).success).toBe(false);
    expect(Assumption.safeParse({ ...base, sensitivity_rank: 1 }).success).toBe(true);
  });

  it('rejects an empty basis', () => {
    expect(Assumption.safeParse({ ...base, basis: '' }).success).toBe(false);
  });

  it('carries all three seed provenances', () => {
    expect(SeedProvenance.options).toHaveLength(3);
  });
});

describe('assumptionConfidenceCeiling', () => {
  it('caps an uncalibrated seed at LOW', () => {
    expect(assumptionConfidenceCeiling(seed())).toBe('LOW');
  });

  it('caps a plain applied default at MEDIUM', () => {
    const a = Assumption.parse({ ...base, basis: DEFAULT_APPLIED });
    expect(assumptionConfidenceCeiling(a)).toBe('MEDIUM');
  });

  it('imposes no ceiling on a measured value', () => {
    expect(assumptionConfidenceCeiling(Assumption.parse(base))).toBe('HIGH');
  });
});

describe('stackedAssumptionCeiling (§A4.4.4)', () => {
  it('imposes no ceiling when nothing was supplied', () => {
    expect(stackedAssumptionCeiling([Assumption.parse(base)])).toBe('HIGH');
    expect(stackedAssumptionCeiling([])).toBe('HIGH');
  });

  it('passes a single default through at its own ceiling', () => {
    const one = Assumption.parse({ ...base, basis: DEFAULT_APPLIED });
    expect(stackedAssumptionCeiling([one])).toBe('MEDIUM');
  });

  it('drops two stacked defaults to LOW even though each alone is MEDIUM', () => {
    const a = Assumption.parse({ ...base, basis: DEFAULT_APPLIED });
    const b = Assumption.parse({ ...base, field: 'doc_class', basis: DEFAULT_APPLIED });
    expect(assumptionConfidenceCeiling(a)).toBe('MEDIUM');
    expect(assumptionConfidenceCeiling(b)).toBe('MEDIUM');
    expect(stackedAssumptionCeiling([a, b])).toBe('LOW');
  });

  it('ignores measured assumptions when counting the stack', () => {
    const measured = Assumption.parse(base);
    const one = Assumption.parse({ ...base, basis: DEFAULT_APPLIED });
    expect(stackedAssumptionCeiling([measured, one, measured])).toBe('MEDIUM');
  });
});

describe('Ambiguity', () => {
  it('needs at least two readings, or it is not ambiguous', () => {
    expect(
      Ambiguity.safeParse({ field: 'volume', readings: ['500 docs'], impact: 'MATERIAL' }).success,
    ).toBe(false);
    expect(
      Ambiguity.safeParse({
        field: 'volume',
        readings: ['500 docs', '500 pages'],
        impact: 'MATERIAL',
      }).success,
    ).toBe(true);
  });
});

describe('MissingDatum', () => {
  it('must either ask a question or say why it matters', () => {
    expect(
      MissingDatum.safeParse({ field: 'pdf_has_text_layer', blocks_estimate: true }).success,
    ).toBe(false);
  });

  it('accepts the analyzer shape — a question', () => {
    const r = MissingDatum.safeParse({
      field: 'pdf_has_text_layer',
      question: 'Is the PDF scanned, or does it have a text layer?',
      blocks_estimate: true,
    });
    expect(r.success).toBe(true);
  });

  it('accepts the estimator shape — why it matters, scoped to a model', () => {
    const r = MissingDatum.safeParse({
      field: 'cache_write_rate',
      model_id: 'some-model',
      why_it_matters: 'Without it the caching lever cannot be priced.',
      blocks_estimate: false,
    });
    expect(r.success).toBe(true);
  });
});
