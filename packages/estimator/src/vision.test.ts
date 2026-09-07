import { describe, it, expect } from 'vitest';
import { VisionProfile, UNAVAILABLE_PROVENANCE } from '@tokenomics/contracts';
import { countVisionTokens, evaluateResize, legibilityFloorPx } from './vision';
import { exactRange, isExact } from './range';

/* ─────────────────────────── fixtures ─────────────────────────── */

const prov = (over: Record<string, unknown> = {}) => ({
  method: 'PROVIDER_FORMULA',
  confidence: 'HIGH',
  source_class: 'VENDOR_DOCS',
  source_url: 'https://example.invalid/vision-docs',
  verified_at: '2026-09-01T00:00:00.000Z',
  verified_by: null,
  notes: null,
  ...over,
});

const src = (value: unknown, p: Record<string, unknown> = prov()) => ({ value, provenance: p });

const constraints = (over: Record<string, unknown> = {}) => ({
  max_edge_px: src(8000),
  min_edge_px: src(1),
  shortest_edge_target_px: src(null),
  max_bytes: src(20_000_000),
  max_pages: src(100),
  allowed_mime: ['image/png'],
  provider_auto_normalizes: true,
  min_legible_edge_px: [],
  max_context_tokens: src(200_000),
  ...over,
});

const profile = (geometry: unknown, over: Record<string, unknown> = {}) =>
  VisionProfile.parse({
    geometry,
    low_detail: { kind: 'UNSUPPORTED' },
    constraints: constraints(),
    provenance: prov(),
    ...over,
  });

// base 85 + 170 per 512px tile — the shape the prototype hardcoded for OpenAI.
const tileGrid = (over: Record<string, unknown> = {}) => ({
  geometry: 'TILE_GRID',
  tile_w: src(512),
  tile_h: src(512),
  base_tokens: src(85),
  per_tile_tokens: src(170),
  small_image_flat_tokens: null,
  small_image_max_edge_px: null,
  ...over,
});

// area / 1024, capped — the shape the prototype hardcoded for gpt-5.
const areaBudget = (over: Record<string, unknown> = {}) => ({
  geometry: 'AREA_BUDGET',
  area_divisor: src(1024),
  area_budget_tokens: src(2500),
  ...over,
});

// 28px patches under a token cap — the shape the prototype binary-searched.
const patchTokenCap = (cap = 1568) => ({
  geometry: 'PATCH_GRID',
  patch_px: src(28),
  bound: { bound_type: 'TOKEN_CAP', token_cap: src(cap) },
});

const blockGridSep = (over: Record<string, unknown> = {}) => ({
  geometry: 'BLOCK_GRID_SEP',
  block_px: src(336),
  per_block_tokens: src(10),
  sep_tokens_per_row: src(100),
  sep_constant: src(0),
  global_view_included: true,
  max_blocks: 64,
  candidate_resolutions: [],
  tie_break_rule_known: false,
  ...over,
});

const counted = (r: ReturnType<typeof countVisionTokens>) => {
  if (r.status !== 'COUNTED') throw new Error(`expected COUNTED, got: ${r.reason}`);
  return r;
};

/* ─────────────────────────── the arithmetic ─────────────────────────── */

describe('TILE_GRID', () => {
  it('counts base + per-tile over a ceiling grid', () => {
    const r = counted(countVisionTokens(profile(tileGrid()), { width_px: 1024, height_px: 1024, detail_mode: null }));
    expect(r.tokens).toBe(85 + 170 * 4);
    expect(r.scaled).toBe(false);
    expect(r.rung).toBe('FITS_AS_IS');
  });

  it('is a ceiling function — one pixel over adds a whole row of tiles', () => {
    const at = (w: number, h: number) =>
      counted(countVisionTokens(profile(tileGrid()), { width_px: w, height_px: h, detail_mode: null })).tokens;
    expect(at(512, 512)).toBe(85 + 170);
    expect(at(513, 512)).toBe(85 + 170 * 2);
  });

  it('flat-rates a small image when the model publishes that', () => {
    const p = profile(
      tileGrid({ small_image_flat_tokens: src(62), small_image_max_edge_px: src(384) }),
    );
    const r = counted(countVisionTokens(p, { width_px: 300, height_px: 200, detail_mode: null }));
    expect(r.tokens).toBe(62);
  });
});

describe('AREA_BUDGET', () => {
  it('divides area and caps at the budget', () => {
    const p = profile(areaBudget());
    expect(counted(countVisionTokens(p, { width_px: 1024, height_px: 1024, detail_mode: null })).tokens).toBe(1024);
    expect(counted(countVisionTokens(p, { width_px: 4000, height_px: 4000, detail_mode: null })).tokens).toBe(2500);
  });

  it('is smooth in pixels — unlike the ceiling geometries', () => {
    const at = (w: number, h: number) =>
      counted(countVisionTokens(profile(areaBudget()), { width_px: w, height_px: h, detail_mode: null })).tokens;
    // A one-pixel change moves the count by roughly one token, not a whole row.
    expect(at(1024, 1024) - at(1023, 1024)).toBe(1);
  });
});

describe('PATCH_GRID with a TOKEN_CAP', () => {
  it('counts patches directly when under the cap', () => {
    const r = counted(countVisionTokens(profile(patchTokenCap()), { width_px: 1000, height_px: 1000, detail_mode: null }));
    expect(r.tokens).toBe(36 * 36);
    expect(r.scaled).toBe(false);
  });

  it('saturates: an oversized image is cheap and lossy, not expensive', () => {
    const p = profile(patchTokenCap(1568));
    const small = counted(countVisionTokens(p, { width_px: 1000, height_px: 1000, detail_mode: null }));
    const huge = counted(countVisionTokens(p, { width_px: 8000, height_px: 8000, detail_mode: null }));
    expect(huge.tokens).toBeLessThanOrEqual(1568);
    expect(huge.scaled).toBe(true);
    expect(huge.rung).toBe('PROVIDER_NORMALIZED');
    // 64x the pixels for less than 1.3x the tokens.
    expect(huge.tokens / small.tokens).toBeLessThan(1.3);
  });

  it('reports the dimensions the provider actually billed', () => {
    const huge = counted(
      countVisionTokens(profile(patchTokenCap(1568)), { width_px: 8000, height_px: 4000, detail_mode: null }),
    );
    expect(huge.effective_width_px).toBeLessThan(8000);
    expect(huge.effective_width_px).toBeGreaterThan(huge.effective_height_px);
  });
});

describe('FLAT', () => {
  it('ignores dimensions entirely', () => {
    const p = profile({ geometry: 'FLAT', flat_tokens_per_image: src(1601) });
    const a = counted(countVisionTokens(p, { width_px: 64, height_px: 64, detail_mode: null }));
    const b = counted(countVisionTokens(p, { width_px: 4000, height_px: 3000, detail_mode: null }));
    expect(a.tokens).toBe(1601);
    expect(b.tokens).toBe(1601);
  });
});

describe('BLOCK_GRID_SEP', () => {
  it('bills a global view on top of the local blocks, and separators by WIDTH alone', () => {
    // 2000x336 -> 6x1 blocks: (6*1 + 1)*10 + (6+1)*100 + 0
    const r = counted(countVisionTokens(profile(blockGridSep()), { width_px: 2000, height_px: 336, detail_mode: null }));
    expect(r.tokens).toBe(7 * 10 + 7 * 100);
  });

  it('drops the global view when the model does not include one', () => {
    const p = profile(blockGridSep({ global_view_included: false }));
    const r = counted(countVisionTokens(p, { width_px: 2000, height_px: 336, detail_mode: null }));
    expect(r.tokens).toBe(6 * 10 + 7 * 100);
  });

  it('IS NOT MONOTONIC — a larger image can cost fewer tokens', () => {
    const p = profile(blockGridSep());
    const wide = counted(countVisionTokens(p, { width_px: 2000, height_px: 336, detail_mode: null }));
    const tall = counted(countVisionTokens(p, { width_px: 672, height_px: 2000, detail_mode: null }));
    expect(672 * 2000).toBeGreaterThan(2000 * 336); // tall is the BIGGER image
    expect(tall.tokens).toBeLessThan(wide.tokens); // and the CHEAPER one
  });

  it('refuses to interpolate between fixed resolutions with an unpublished tie-break', () => {
    const p = profile(
      blockGridSep({ candidate_resolutions: [{ w: 672, h: 672 }, { w: 1008, h: 672 }] }),
    );
    expect(countVisionTokens(p, { width_px: 800, height_px: 672, detail_mode: null }).status).toBe('UNAVAILABLE');
    expect(countVisionTokens(p, { width_px: 672, height_px: 672, detail_mode: null }).status).toBe('COUNTED');
  });

  it('refuses when the block grid exceeds max_blocks and the selection rule is unrecorded', () => {
    const p = profile(blockGridSep({ max_blocks: 4 }));
    const r = countVisionTokens(p, { width_px: 4000, height_px: 4000, detail_mode: null });
    expect(r.status).toBe('UNAVAILABLE');
  });
});

/* ─────────────────────────── refusals ─────────────────────────── */

describe('refusing rather than inventing (§A3.2)', () => {
  it('never defaults an unknown geometry to the familiar tile grid', () => {
    const p = profile({
      geometry: 'UNAVAILABLE',
      reason: 'Speaks the OpenAI wire protocol; billing geometry unpublished.',
      probe_candidate: true,
    });
    const r = countVisionTokens(p, { width_px: 1024, height_px: 1024, detail_mode: null });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toContain('unpublished');
  });

  it('blocks on a missing constant rather than treating it as zero', () => {
    const p = profile(tileGrid({ per_tile_tokens: { value: null, provenance: UNAVAILABLE_PROVENANCE } }));
    const r = countVisionTokens(p, { width_px: 1024, height_px: 1024, detail_mode: null });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toContain('per_tile_tokens');
  });

  it('rejects non-positive dimensions', () => {
    expect(countVisionTokens(profile(tileGrid()), { width_px: 0, height_px: 10, detail_mode: null }).status).toBe(
      'UNAVAILABLE',
    );
  });

  it('will not silently scale an oversized asset the provider does not normalize', () => {
    // The prototype's scaleToFit did this unconditionally, producing a confident
    // number for a request the provider would have rejected.
    const p = profile(tileGrid(), {
      constraints: constraints({ max_edge_px: src(2048), provider_auto_normalizes: false }),
    });
    const r = countVisionTokens(p, { width_px: 4000, height_px: 3000, detail_mode: null });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') {
      expect(r.rung).toBe('BLOCKED');
      expect(r.reason).toContain('does not auto-normalize');
    }
  });

  it('normalizes when the provider documents that it does', () => {
    const p = profile(tileGrid(), {
      constraints: constraints({ max_edge_px: src(2048), provider_auto_normalizes: true }),
    });
    const r = counted(countVisionTokens(p, { width_px: 4000, height_px: 3000, detail_mode: null }));
    expect(r.rung).toBe('PROVIDER_NORMALIZED');
    expect(r.scaled).toBe(true);
    expect(Math.max(r.effective_width_px, r.effective_height_px)).toBe(2048);
  });
});

/* ─────────────────────────── low detail (§A5.2.0b) ─────────────────────────── */

describe('low detail resolves before the geometry branch', () => {
  it('flat-rates without ever measuring the image', () => {
    const p = profile(tileGrid(), { low_detail: { kind: 'FLAT', flat_tokens: src(85) } });
    const a = counted(countVisionTokens(p, { width_px: 4000, height_px: 4000, detail_mode: 'low' }));
    const b = counted(countVisionTokens(p, { width_px: 64, height_px: 64, detail_mode: 'low' }));
    expect(a.tokens).toBe(85);
    expect(b.tokens).toBe(85);
    // and the geometry would have said something very different
    expect(counted(countVisionTokens(p, { width_px: 4000, height_px: 4000, detail_mode: 'high' })).tokens).toBeGreaterThan(85);
  });

  it('refuses INHERIT, because the reduction factor is not recorded anywhere', () => {
    const p = profile(tileGrid(), { low_detail: { kind: 'INHERIT' } });
    const r = countVisionTokens(p, { width_px: 1024, height_px: 1024, detail_mode: 'low' });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toContain('reduction factor');
  });

  it('counts at full detail, with a note, when the provider has no low-detail mode', () => {
    const p = profile(tileGrid(), { low_detail: { kind: 'UNSUPPORTED' } });
    const r = counted(countVisionTokens(p, { width_px: 1024, height_px: 1024, detail_mode: 'low' }));
    expect(r.tokens).toBe(85 + 170 * 4);
    expect(r.notes.join(' ')).toContain('no low-detail mode');
  });
});

/* ─────────────────────────── provenance (§A3.7) ─────────────────────────── */

describe('confidence and method are computed from the constants actually used', () => {
  it('takes the minimum confidence across the constants read', () => {
    const p = profile(tileGrid({ per_tile_tokens: src(170, prov({ confidence: 'MEDIUM' })) }));
    expect(counted(countVisionTokens(p, { width_px: 1024, height_px: 1024, detail_mode: null })).confidence).toBe('MEDIUM');
  });

  it('a LOW constant drags the whole count to LOW', () => {
    const p = profile(
      tileGrid({ base_tokens: src(85, prov({ method: 'EXACT_PROXY', confidence: 'LOW' })) }),
    );
    expect(counted(countVisionTokens(p, { width_px: 1024, height_px: 1024, detail_mode: null })).confidence).toBe('LOW');
  });

  it('keeps the tier when every constant shares it', () => {
    const p = profile(tileGrid());
    expect(counted(countVisionTokens(p, { width_px: 1024, height_px: 1024, detail_mode: null })).method).toBe(
      'PROVIDER_FORMULA',
    );
  });

  it('collapses mixed tiers to DERIVED rather than claiming the strongest', () => {
    const p = profile(
      tileGrid({ per_tile_tokens: src(170, prov({ method: 'MEASURED_PROBE', confidence: 'HIGH' })) }),
    );
    expect(counted(countVisionTokens(p, { width_px: 1024, height_px: 1024, detail_mode: null })).method).toBe('DERIVED');
  });
});

/* ─────────────────────────── legibility floor ─────────────────────────── */

describe('legibilityFloorPx', () => {
  const withFloors = constraints({
    min_legible_edge_px: [
      { script: 'latin', content_density: 'normal', px: src(480) },
      { script: 'ar_vocalized', content_density: 'dense', px: src(1400) },
      { script: 'zh_hans', content_density: 'normal', px: src(900) },
    ],
  });

  it('returns the exact floor when script and density are both known', () => {
    expect(legibilityFloorPx(withFloors as never, 'latin', 'normal')).toBe(480);
  });

  it('takes the STRICTEST floor for mixed script, never the average', () => {
    expect(legibilityFloorPx(withFloors as never, 'mixed', 'normal')).toBe(1400);
  });

  it('takes the strictest when the script is unknown', () => {
    expect(legibilityFloorPx(withFloors as never, null, null)).toBe(1400);
  });

  it('falls back within the script when that density is not tabulated', () => {
    expect(legibilityFloorPx(withFloors as never, 'zh_hans', 'dense')).toBe(900);
  });

  it('returns null when nothing is recorded — unknown, not "no floor"', () => {
    expect(legibilityFloorPx(constraints() as never, 'latin', 'normal')).toBeNull();
  });
});

/* ─────────────────────────── resize evaluation ─────────────────────────── */

describe('evaluateResize (§A5.2.1 rungs 3-5)', () => {
  it('suppresses the proposal entirely on FLAT geometry', () => {
    const p = profile({ geometry: 'FLAT', flat_tokens_per_image: src(1601) });
    const r = evaluateResize(p, { width_px: 4000, height_px: 4000, detail_mode: null }, { width_px: 1000, height_px: 1000 });
    expect(r.rung).toBe('RESIZE_SAVES_NOTHING');
    expect(r.reason).toContain('by construction');
    expect(r.recomputed_tile_delta).toBeNull();
  });

  it('blocks on fidelity_critical before doing any arithmetic', () => {
    const p = profile(tileGrid());
    const r = evaluateResize(
      p,
      { width_px: 4000, height_px: 4000, detail_mode: null },
      { width_px: 1000, height_px: 1000 },
      { fidelity_critical: true },
    );
    expect(r.rung).toBe('FIDELITY_LOCKED');
  });

  it('blocks a candidate below the legibility floor', () => {
    const p = profile(tileGrid(), {
      constraints: constraints({
        min_legible_edge_px: [{ script: 'ar_vocalized', content_density: 'dense', px: src(1400) }],
      }),
    });
    const r = evaluateResize(
      p,
      { width_px: 4000, height_px: 4000, detail_mode: null },
      { width_px: 1000, height_px: 1000 },
      { script: 'ar_vocalized', density: 'dense' },
    );
    expect(r.rung).toBe('FIDELITY_LOCKED');
    expect(r.reason).toContain('legibility floor');
  });

  it('proposes only when the recomputed grid is genuinely smaller', () => {
    const p = profile(tileGrid());
    const r = evaluateResize(p, { width_px: 2048, height_px: 2048, detail_mode: null }, { width_px: 512, height_px: 512 });
    expect(r.rung).toBe('RESIZE_PROPOSED');
    expect(r.recomputed_tile_delta).toBeLessThan(0);
  });

  it('declines when the resize crosses no tile boundary', () => {
    const p = profile(tileGrid());
    const r = evaluateResize(p, { width_px: 1024, height_px: 1024, detail_mode: null }, { width_px: 1000, height_px: 1000 });
    expect(r.rung).toBe('RESIZE_SAVES_NOTHING');
    expect(r.recomputed_tile_delta).toBe(0);
  });

  it('catches a shrink that RAISES the cost on a non-monotonic geometry', () => {
    const p = profile(blockGridSep());
    const r = evaluateResize(
      p,
      { width_px: 672, height_px: 2000, detail_mode: null }, // 1,344,000 px
      { width_px: 2000, height_px: 336 }, // 672,000 px — half the area
    );
    expect(r.rung).toBe('RESIZE_SAVES_NOTHING');
    expect(r.recomputed_tile_delta).toBeGreaterThan(0);
    expect(r.reason).toContain('HIGHER');
  });

  it('reports BLOCKED when either side cannot be counted', () => {
    const p = profile({ geometry: 'UNAVAILABLE', reason: 'unpublished', probe_candidate: true });
    const r = evaluateResize(p, { width_px: 2048, height_px: 2048, detail_mode: null }, { width_px: 512, height_px: 512 });
    expect(r.rung).toBe('BLOCKED');
  });
});

/* ─────────────────────────── ranges ─────────────────────────── */

describe('exactRange', () => {
  it('does not fabricate a spread for arithmetic', () => {
    const r = exactRange(765);
    expect(r.p50).toBe(765);
    expect(r.p90).toBe(765);
    expect(isExact(r)).toBe(true);
  });
});
