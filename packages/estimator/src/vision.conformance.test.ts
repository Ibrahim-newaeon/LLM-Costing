// Conformance against a provider's OWN published worked examples.
//
// Everything in vision.test.ts checks that the implementation does what this repo
// intends. This file checks something different and stronger: that it agrees with
// numbers Anthropic published. A worked example is the only trustworthy point on a
// geometry — it is the vendor stating, for specific pixels, exactly what they bill.
//
// Source, retrieved 2026-09-07 (neither page displays a publication date):
//   https://platform.claude.com/docs/en/build-with-claude/vision
//   https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
//
// These fixtures are NOT a registry seed. Rule 1 says a constant enters the
// registry through ingestion, recorded with source_url and verified_at. They are
// here to pin arithmetic, and the provenance below records where they came from so
// nobody mistakes them for data.
//
// This file is what caught the off-by-one: the search compared patch rows against
// an unrounded short edge, so example 2 returned 924x1306 where the documentation
// says 924x1307.

import { describe, it, expect } from 'vitest';
import { VisionProfile } from '@tokenomics/contracts';
import { countVisionTokens } from './vision';

const SOURCE = 'https://platform.claude.com/docs/en/build-with-claude/vision';

const prov = {
  method: 'PROVIDER_FORMULA',
  confidence: 'HIGH',
  source_class: 'VENDOR_DOCS',
  source_url: SOURCE,
  verified_at: '2026-09-07T00:00:00.000Z',
  verified_by: null,
  notes: null,
};
const src = (value: unknown) => ({ value, provenance: prov });

/**
 * "Claude views images in patches, where each patch is a 28x28-pixel block", and
 * resizes to "the largest aspect-preserving size" satisfying BOTH the edge limit
 * and the visual-token budget. Two separate limits that happen to share the number
 * 1568 on the standard tier — one in pixels, one in tokens. Conflating them is
 * exactly the error docs/external-brief-review.md 5 recorded.
 */
const claudeTier = (maxEdge: number, maxTokens: number) =>
  VisionProfile.parse({
    geometry: {
      geometry: 'PATCH_GRID',
      patch_px: src(28),
      bound: { bound_type: 'TOKEN_CAP', token_cap: src(maxTokens) },
    },
    low_detail: { kind: 'UNSUPPORTED' },
    constraints: {
      max_edge_px: src(maxEdge),
      min_edge_px: src(1),
      shortest_edge_target_px: src(null),
      max_bytes: src(20_000_000),
      max_pages: src(100),
      allowed_mime: ['image/png', 'image/jpeg'],
      // "Images larger than either limit are downscaled before processing."
      provider_auto_normalizes: true,
      min_legible_edge_px: [],
      max_context_tokens: src(200_000),
    },
    provenance: prov,
  });

const STANDARD = claudeTier(1568, 1568);
const HIGH_RES = claudeTier(2576, 4784);

const count = (p: ReturnType<typeof claudeTier>, w: number, h: number) => {
  const r = countVisionTokens(p, { width_px: w, height_px: h, detail_mode: null });
  if (r.status !== 'COUNTED') throw new Error(`expected COUNTED, got: ${r.reason}`);
  return r;
};

describe('Anthropic published worked examples', () => {
  it('example 1 — 1000x1000 costs 36 x 36 = 1296 visual tokens, unresized', () => {
    const r = count(STANDARD, 1000, 1000);
    expect(r.tokens).toBe(1296);
    expect(r.scaled).toBe(false);
    expect(r.rung).toBe('FITS_AS_IS');
  });

  it('example 2 — an A4 page at 130 DPI, 1075x1520, resizes to 924x1307 on the standard tier', () => {
    // Documented: raw cost is ceil(1075/28) x ceil(1520/28) = 39 x 55 = 2145,
    // which exceeds the 1568-token budget, so it is resized to 924x1307.
    expect(Math.ceil(1075 / 28) * Math.ceil(1520 / 28)).toBe(2145);

    const r = count(STANDARD, 1075, 1520);
    expect(r.effective_width_px).toBe(924);
    expect(r.effective_height_px).toBe(1307);
    expect(r.scaled).toBe(true);
    expect(r.rung).toBe('PROVIDER_NORMALIZED');
    // And the resized dimensions really do fit the budget.
    expect(r.tokens).toBe(Math.ceil(924 / 28) * Math.ceil(1307 / 28));
    expect(r.tokens).toBeLessThanOrEqual(1568);
  });

  it('example 2 on the high-resolution tier — 2145 tokens fits 4784, so no resize', () => {
    const r = count(HIGH_RES, 1075, 1520);
    expect(r.tokens).toBe(2145);
    expect(r.scaled).toBe(false);
    expect(r.effective_width_px).toBe(1075);
    expect(r.effective_height_px).toBe(1520);
  });
});

describe('the resize is bounded by BOTH limits, not just the edge', () => {
  // "The token limit, not the edge limit, determines final size for most photos
  // and screenshots." A square at exactly the edge limit is already over budget.
  it('a 1568x1568 image is at the edge limit and still over the token budget', () => {
    expect(Math.ceil(1568 / 28) ** 2).toBe(3136);
    const r = count(STANDARD, 1568, 1568);
    expect(r.scaled).toBe(true);
    expect(r.tokens).toBeLessThanOrEqual(1568);
  });

  it('never exceeds the budget, across a spread of aspect ratios', () => {
    for (const [w, h] of [
      [8000, 8000], [8000, 1000], [1000, 8000], [1075, 1520], [3000, 2000], [4096, 2160], [1600, 900],
    ] as const) {
      const r = count(STANDARD, w, h);
      expect(r.tokens).toBeLessThanOrEqual(1568);
      // and the reported dimensions must be the ones that produce the reported count
      expect(r.tokens).toBe(
        Math.ceil(r.effective_width_px / 28) * Math.ceil(r.effective_height_px / 28),
      );
    }
  });

  it('the reported dimensions always reproduce the reported token count', () => {
    // The off-by-one this file caught was exactly a violation of this invariant:
    // tokens computed from an unrounded short edge, dimensions reported rounded.
    for (const [w, h] of [[1075, 1520], [1520, 1075], [4000, 2250], [999, 3001]] as const) {
      const r = count(STANDARD, w, h);
      expect(r.tokens).toBe(
        Math.ceil(r.effective_width_px / 28) * Math.ceil(r.effective_height_px / 28),
      );
    }
  });
});

describe('only downscaling', () => {
  // "Only downscaling occurs — there is no upscaling for small images. Images
  // already within limits are returned unchanged."
  it('leaves a small image alone', () => {
    const r = count(STANDARD, 64, 48);
    expect(r.scaled).toBe(false);
    expect(r.effective_width_px).toBe(64);
    expect(r.effective_height_px).toBe(48);
    expect(r.tokens).toBe(Math.ceil(64 / 28) * Math.ceil(48 / 28));
  });
});

describe('the reading the external brief proposed is not what Anthropic documents', () => {
  // docs/external-brief-review.md 5 recorded a conflict: an external document
  // claimed ceil(w*h / 750) after clamping the long edge to 1568px. Resolved
  // against the vendor page — the divisor is the patch AREA, 28^2 = 784, and 1568
  // is two different limits in two different units.
  it('28^2 is 784, not 750', () => {
    expect(28 ** 2).toBe(784);
  });

  it('the area formula disagrees with the published 1000x1000 example', () => {
    expect(Math.ceil((1000 * 1000) / 750)).toBe(1334); // the brief's reading
    expect(count(STANDARD, 1000, 1000).tokens).toBe(1296); // what Anthropic publishes
  });
});
