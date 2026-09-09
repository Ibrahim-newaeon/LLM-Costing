// /packages/contracts/src/provenance.test.ts
//
// `sourced()` and `Sourced<T>` are two spellings of one shape — the only place in
// the contracts where that is tolerated, because a generic type cannot be inferred
// from a Zod factory. This file is what keeps them from drifting: a parsed
// `sourced()` value is assigned to `Sourced<T>` and a `Sourced<T>` literal is
// parsed by `sourced()`, so a field added to one and not the other fails to compile.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { sourced, SourcedConflict, type Sourced, type Provenance } from './provenance';

const PROV: Provenance = {
  method: 'PROVIDER_FORMULA',
  confidence: 'HIGH',
  source_class: 'VENDOR_DOCS',
  source_url: 'https://example.invalid/vendor-page',
  verified_at: '2026-09-09T00:00:00.000Z',
  verified_by: null,
  notes: null,
};

describe('sourced() and Sourced<T> are one shape', () => {
  it('a parsed sourced() value is a Sourced<T>, and back', () => {
    const parsed: Sourced<number> = sourced(z.number()).parse({ value: 3, provenance: PROV });
    expect(parsed.conflict).toBeNull();

    const literal: Sourced<number> = { value: 3, provenance: PROV, conflict: null };
    expect(sourced(z.number()).parse(literal)).toEqual(literal);
  });

  it('the conflict slot defaults to null — every existing registry row still parses', () => {
    const s = sourced(z.number()).parse({ value: null, provenance: PROV });
    expect(s.conflict).toBeNull();
  });
});

describe('SourcedConflict — rule 5 on a constant', () => {
  const page = 'https://example.invalid/tokens-page';
  const at = '2026-09-09T00:00:00.000Z';

  it('needs at least two candidates: one reading is a value, not a disagreement', () => {
    expect(() =>
      SourcedConflict.parse({ candidates: [{ value: 263, source_url: page, retrieved_at: at }] }),
    ).toThrow();
  });

  it('keeps every candidate side by side and starts unresolved', () => {
    const c = SourcedConflict.parse({
      candidates: [
        { value: 263, source_url: page, retrieved_at: at, locator: 'bullet: "263 tokens per second"' },
        { value: 100, source_url: page, retrieved_at: at, locator: 'table: "~100 tokens/second (low resolution)"' },
        { value: 300, source_url: page, retrieved_at: at, locator: 'table: "~300 tokens/second (high resolution)"' },
      ],
    });
    expect(c.resolved).toBe(false);
    expect(c.candidates.map((x) => x.value)).toEqual([263, 100, 300]);
  });

  it('a sourced value may carry the conflict while committing to no candidate', () => {
    const s = sourced(z.number()).parse({
      value: null,
      provenance: { ...PROV, method: 'UNAVAILABLE', confidence: 'NONE', source_url: null, verified_at: null },
      conflict: {
        candidates: [
          { value: 263, source_url: page, retrieved_at: at },
          { value: 300, source_url: page, retrieved_at: at },
        ],
      },
    });
    expect(s.value).toBeNull();
    expect(s.conflict?.candidates).toHaveLength(2);
  });
});
