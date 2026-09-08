import { describe, it, expect } from 'vitest';
import { TextCalibration, findCalibration, bootstrapForbidden } from './calibration';

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

const row = (over: Record<string, unknown> = {}) => ({
  model_id: 'm1',
  bucket: { script: 'latin', content_type: 'prose' },
  tokens_per_char: { p50: 0.25, p90: 0.29 },
  n_samples: 500,
  seed_provenance: 'CALIBRATED_FROM_OBSERVED',
  provenance: prov(),
  ...over,
});

describe('§A4.5.4 — the constant you may not generalize', () => {
  it('permits an English prose bootstrap', () => {
    const r = TextCalibration.safeParse(
      row({
        bucket: { script: 'latin', content_type: 'prose' },
        n_samples: 0,
        seed_provenance: 'SEED_UNCALIBRATED',
        provenance: prov({ confidence: 'LOW' }),
      }),
    );
    expect(r.success).toBe(true);
  });

  it.each(['ar_msa', 'ar_dialect', 'ar_vocalized', 'zh_hans', 'zh_hant', 'mixed'])(
    'makes a bootstrap row for %s unconstructible',
    (script) => {
      const r = TextCalibration.safeParse(
        row({
          bucket: { script, content_type: 'prose' },
          n_samples: 0,
          seed_provenance: 'SEED_UNCALIBRATED',
          provenance: prov({ confidence: 'LOW' }),
        }),
      );
      expect(r.success).toBe(false);
      expect(bootstrapForbidden(script as never)).toBe(true);
    },
  );

  it('accepts those scripts once they are MEASURED — the ban is on seeds, not on Arabic', () => {
    const r = TextCalibration.safeParse(
      row({ bucket: { script: 'ar_vocalized', content_type: 'prose' }, n_samples: 1200 }),
    );
    expect(r.success).toBe(true);
  });
});

describe('a seed is a seed whatever it calls itself', () => {
  it('rejects zero samples with no declared seed_provenance', () => {
    expect(TextCalibration.safeParse(row({ n_samples: 0, seed_provenance: null })).success).toBe(false);
  });

  it('rejects CALIBRATED_FROM_OBSERVED with nothing observed', () => {
    expect(TextCalibration.safeParse(row({ n_samples: 0 })).success).toBe(false);
  });

  it('holds seeds at LOW — confidence rises when samples replace them, not by assertion', () => {
    const asserted = row({
      bucket: { script: 'latin', content_type: 'code' },
      n_samples: 0,
      seed_provenance: 'SEED_UNCALIBRATED',
      provenance: prov({ confidence: 'HIGH' }),
    });
    expect(TextCalibration.safeParse(asserted).success).toBe(false);
  });
});

describe('tokens_per_char is stored in the direction of the risk', () => {
  it('rejects a p90 below p50 — p90 is the expensive end', () => {
    expect(
      TextCalibration.safeParse(row({ tokens_per_char: { p50: 0.29, p90: 0.25 } })).success,
    ).toBe(false);
  });

  it('the human "~4 characters per token" is ~0.25 tokens per character', () => {
    const parsed = TextCalibration.parse(row());
    expect(1 / parsed.tokens_per_char.p50).toBeCloseTo(4, 5);
  });
});

describe('findCalibration never interpolates', () => {
  const table = [
    TextCalibration.parse(row()),
    TextCalibration.parse(row({ bucket: { script: 'latin', content_type: 'code' } })),
  ];

  it('matches an exact bucket', () => {
    expect(findCalibration(table, 'm1', { script: 'latin', content_type: 'prose' })).not.toBeNull();
  });

  it('returns null rather than the nearest row', () => {
    expect(findCalibration(table, 'm1', { script: 'latin', content_type: 'tabular' })).toBeNull();
    expect(findCalibration(table, 'm1', { script: 'ar_msa', content_type: 'prose' })).toBeNull();
  });

  it('does not cross models — a ratio is per model', () => {
    expect(findCalibration(table, 'm2', { script: 'latin', content_type: 'prose' })).toBeNull();
  });
});
