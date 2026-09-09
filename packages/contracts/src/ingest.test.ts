// /packages/contracts/src/ingest.test.ts

import { describe, it, expect } from 'vitest';
import { Snapshot, Observation, PriceChangeEvent } from './ingest';
import type { Provenance } from './provenance';

const AGG: Provenance = {
  method: 'PROVIDER_FORMULA',
  confidence: 'MEDIUM',
  source_class: 'AGGREGATOR',
  source_url: 'https://example.invalid/aggregator.json',
  verified_at: '2026-09-09T00:00:00.000Z',
  verified_by: null,
  notes: null,
};

describe('Snapshot', () => {
  const ok = {
    snapshot_id: 'litellm@2026-09-09T10:37:59.000Z',
    source_id: 'litellm',
    source_class: 'AGGREGATOR',
    source_url: 'https://example.invalid/aggregator.json',
    retrieved_at: '2026-09-09T10:37:59.000Z',
    content_sha256: 'a'.repeat(64),
    byte_length: 10,
  };

  it('parses a complete record', () => {
    expect(Snapshot.parse(ok).snapshot_id).toBe(ok.snapshot_id);
  });

  it('refuses a hash that is not a sha256 hex digest', () => {
    expect(() => Snapshot.parse({ ...ok, content_sha256: 'deadbeef' })).toThrow();
    expect(() => Snapshot.parse({ ...ok, content_sha256: 'A'.repeat(64) })).toThrow();
  });
});

describe('Observation', () => {
  const base = { model_id: 'm', snapshot_id: 's', source_key: 'k', provenance: AGG };

  it('a RATE keeps the source unit and currency — no normalization at the record', () => {
    const o = Observation.parse({
      ...base,
      kind: 'RATE',
      key: { direction: 'input', modality: 'text' },
      amount: 0.000005,
      unit: 'per_token',
      currency: 'USD',
    });
    expect(o.kind).toBe('RATE');
    if (o.kind === 'RATE') {
      expect(o.unit).toBe('per_token');
      expect(o.key.variant).toBe('standard');
      expect(o.key.above_tokens).toBeNull();
    }
  });

  it('an aggregator observation cannot claim HIGH — §A3.8 holds at the record', () => {
    expect(() =>
      Observation.parse({
        ...base,
        provenance: { ...AGG, confidence: 'HIGH' },
        kind: 'LIMIT',
        which: 'context_window',
        value: 1_048_576,
      }),
    ).toThrow(/AGGREGATOR/);
  });

  it('a LIFECYCLE value is a datetime, not a bare date string', () => {
    expect(() =>
      Observation.parse({ ...base, kind: 'LIFECYCLE', which: 'deprecation_date', value: '2026-10-20' }),
    ).toThrow();
    const o = Observation.parse({
      ...base,
      kind: 'LIFECYCLE',
      which: 'deprecation_date',
      value: '2026-10-20T00:00:00.000Z',
    });
    expect(o.kind).toBe('LIFECYCLE');
  });
});

describe('PriceChangeEvent', () => {
  it('a CHANGED event carries both amounts and a signed delta', () => {
    const e = PriceChangeEvent.parse({
      model_id: 'm',
      key: { direction: 'output', modality: null },
      change: 'CHANGED',
      unit: 'per_token',
      currency: 'USD',
      previous_amount: 0.00001,
      current_amount: 0.000015,
      delta_pct: 50,
      previous_snapshot_id: 'a',
      current_snapshot_id: 'b',
    });
    expect(e.delta_pct).toBe(50);
  });

  it('an ADDED event has no previous amount and no delta', () => {
    const e = PriceChangeEvent.parse({
      model_id: 'm',
      key: { direction: 'output', modality: null },
      change: 'ADDED',
      unit: 'per_token',
      currency: 'USD',
      previous_amount: null,
      current_amount: 0.000015,
      delta_pct: null,
      previous_snapshot_id: null,
      current_snapshot_id: 'b',
    });
    expect(e.previous_amount).toBeNull();
  });
});
