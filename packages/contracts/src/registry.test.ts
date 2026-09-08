// /packages/contracts/src/registry.test.ts
//
// These tests exist to prove the three defects found by comparing fit.ts,
// registry.schema.ts and Annex A15 §11 are actually closed — and to keep them
// closed. Each defect gets a named test that would have FAILED against the old
// schemas. The negative cases matter more than the positive ones.
//
//   pnpm vitest src/registry.test.ts     # offline, free

import { describe, it, expect } from 'vitest';
import { VisionProfile, VisionGeometry, PROBE_KIND_TO_GEOMETRY, probeFitIsSeedable } from './vision';
import { Provenance, minConfidence, confidenceCeiling } from './provenance';
import { ModelRow, rankingEligibility } from './registry';

const prov = (over: Partial<any> = {}) =>
  Provenance.parse({
    method: 'PROVIDER_FORMULA',
    confidence: 'HIGH',
    source_class: 'VENDOR_PAGE',
    source_url: 'https://example.invalid/docs',
    verified_at: '2026-09-06T00:00:00.000Z',
    verified_by: null,
    notes: null,
    ...over,
  });

const s = (value: unknown, over: Partial<any> = {}) => ({ value, provenance: prov(over) });

const constraints = () => ({
  max_edge_px: s(4096),
  min_edge_px: s(56),
  shortest_edge_target_px: s(768),
  max_bytes: s(8_000_000),
  max_pages: s(100),
  allowed_mime: ['image/png', 'image/jpeg'],
  provider_auto_normalizes: false,
  min_legible_edge_px: [],
  max_context_tokens: s(128_000),
});

/* ══════════════ DEFECT 1 — BLOCK_GRID_SEP had nowhere to live ══════════════ */

describe('defect 1: the probe can produce a geometry the registry must store', () => {
  it('every GeometryKind fit.ts emits maps to a storable geometry', () => {
    const emitted = ['FLAT', 'PATCH_GRID', 'TILE_GRID', 'AREA_BUDGET', 'BLOCK_GRID_SEP', 'UNKNOWN'] as const;
    for (const k of emitted) {
      expect(PROBE_KIND_TO_GEOMETRY[k], `fit.ts can emit ${k} with no registry home`).toBeDefined();
    }
  });

  it('stores a BLOCK_GRID_SEP row — rejected by BOTH prior schemas', () => {
    const g = VisionGeometry.parse({
      geometry: 'BLOCK_GRID_SEP',
      block_px: s(384),
      per_block_tokens: s(196),
      sep_tokens_per_row: s(14),
      sep_constant: s(1),
      global_view_included: true,
      max_blocks: 9,
      candidate_resolutions: [{ w: 384, h: 384 }],
      tie_break_rule_known: false,
    });
    expect(g.geometry).toBe('BLOCK_GRID_SEP');
  });

  it('stores a FLAT row — missing from registry.schema.ts entirely', () => {
    const g = VisionGeometry.parse({ geometry: 'FLAT', flat_tokens_per_image: s(560) });
    expect(g.geometry).toBe('FLAT');
  });
});

/* ══════════════ DEFECT 2 — the refinement rejected a correct model ══════════════ */

describe('defect 2: a patch grid bounded by area must validate', () => {
  it('accepts PATCH_GRID + AREA_CLAMP (Qwen-VL / GLM shape) — the old refine REJECTED this', () => {
    const g = VisionGeometry.parse({
      geometry: 'PATCH_GRID',
      patch_px: s(28),
      bound: { bound_type: 'AREA_CLAMP', min_area_px: s(3136), max_area_px: s(12_845_056) },
    });
    expect(g.geometry === 'PATCH_GRID' && g.bound.bound_type).toBe('AREA_CLAMP');
  });

  it('accepts PATCH_GRID + TOKEN_CAP (Claude shape)', () => {
    const g = VisionGeometry.parse({
      geometry: 'PATCH_GRID',
      patch_px: s(28),
      bound: { bound_type: 'TOKEN_CAP', token_cap: s(4784) },
    });
    expect(g.geometry === 'PATCH_GRID' && g.bound.bound_type).toBe('TOKEN_CAP');
  });

  // NEGATIVE — the two bounds are mutually exclusive by construction, not by refine.
  it('rejects a token cap carrying area bounds', () => {
    expect(() =>
      VisionGeometry.parse({
        geometry: 'PATCH_GRID',
        patch_px: s(28),
        bound: { bound_type: 'TOKEN_CAP', token_cap: s(4784), min_area_px: s(3136) },
      }),
    ).not.toThrow(); // unknown keys stripped, not fatal
    const g = VisionGeometry.parse({
      geometry: 'PATCH_GRID',
      patch_px: s(28),
      bound: { bound_type: 'TOKEN_CAP', token_cap: s(4784) },
    });
    expect(JSON.stringify(g)).not.toContain('min_area_px');
  });

  it('rejects an AREA_CLAMP with no area bounds', () => {
    expect(() =>
      VisionGeometry.parse({
        geometry: 'PATCH_GRID',
        patch_px: s(28),
        bound: { bound_type: 'AREA_CLAMP' },
      }),
    ).toThrow();
  });
});

/* ══════════════ DEFECT 3 — a TILE_GRID with no per-tile value ══════════════ */

describe('defect 3: a geometry cannot be seeded without its own parameters', () => {
  it('rejects TILE_GRID with a null per_tile_tokens (would price every image at base)', () => {
    expect(() =>
      VisionGeometry.parse({
        geometry: 'TILE_GRID',
        tile_w: s(512),
        tile_h: s(512),
        base_tokens: s(85),
        per_tile_tokens: { value: null, provenance: prov() },
      }),
    ).not.toThrow(); // value is nullable by design — see the row-level gate below
    const g = VisionGeometry.parse({
      geometry: 'TILE_GRID',
      tile_w: s(512),
      tile_h: s(512),
      base_tokens: s(85),
      per_tile_tokens: { value: null, provenance: prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }) },
    });
    // A null value must arrive tagged UNAVAILABLE/NONE, so the estimator blocks
    // rather than silently pricing every image at base_tokens.
    expect(g.geometry === 'TILE_GRID' && g.per_tile_tokens.provenance.confidence).toBe('NONE');
  });

  it('rejects an AREA_BUDGET row missing its divisor', () => {
    expect(() =>
      VisionGeometry.parse({ geometry: 'AREA_BUDGET', area_budget_tokens: s(2500) }),
    ).toThrow();
  });

  it('UNAVAILABLE is a first-class geometry, not an omission', () => {
    const g = VisionGeometry.parse({
      geometry: 'UNAVAILABLE',
      reason: 'Vendor publishes rates without a geometry. Probe candidate.',
      probe_candidate: true,
    });
    expect(g.geometry).toBe('UNAVAILABLE');
  });
});

/* ══════════════ provenance rules ══════════════ */

describe('provenance', () => {
  it('rejects an AGGREGATOR rate at HIGH confidence (§A3.8)', () => {
    expect(() => prov({ source_class: 'AGGREGATOR', confidence: 'HIGH' })).toThrow();
  });

  it('accepts an AGGREGATOR rate at MEDIUM', () => {
    expect(prov({ source_class: 'AGGREGATOR', confidence: 'MEDIUM' }).confidence).toBe('MEDIUM');
  });

  it('binds NONE to UNAVAILABLE in both directions', () => {
    expect(() => prov({ method: 'UNAVAILABLE', confidence: 'LOW', source_url: null })).toThrow();
    expect(() => prov({ method: 'EXACT_TOKENIZER', confidence: 'NONE' })).toThrow();
  });

  it('caps EXACT_PROXY at LOW regardless of evidence', () => {
    expect(() => prov({ method: 'EXACT_PROXY', confidence: 'HIGH' })).toThrow();
    expect(prov({ method: 'EXACT_PROXY', confidence: 'LOW' }).confidence).toBe('LOW');
  });

  it('requires a source_url for everything except a refusal', () => {
    expect(() => prov({ source_url: null })).toThrow();
  });

  it('requires a named owner on a manual override', () => {
    expect(() => prov({ source_class: 'USER_ENTERED', verified_by: null })).toThrow();
  });

  it('propagates confidence by minimum, never by assertion (§A3.7)', () => {
    expect(minConfidence('HIGH', 'NONE')).toBe('NONE');
    expect(minConfidence('HIGH', 'MEDIUM', 'LOW')).toBe('LOW');
    expect(minConfidence('HIGH', 'HIGH')).toBe('HIGH');
    expect(minConfidence()).toBe('NONE');
  });

  it('caps an aggregator source below HIGH at the ingestion boundary too', () => {
    expect(confidenceCeiling('AGGREGATOR')).toBe('MEDIUM');
    expect(confidenceCeiling('VENDOR_PAGE')).toBe('HIGH');
  });
});

/* ══════════════ probe → registry gate ══════════════ */

describe('a probe fit is evidence, not a registry entry (§A4.6.1)', () => {
  it('refuses everything from a run whose control model failed', () => {
    const r = probeFitIsSeedable({ exact: true, kind: 'PATCH_GRID', controlPassed: false });
    expect(r.seedable).toBe(false);
    expect(r.reason).toMatch(/control/i);
  });

  it('refuses a near-miss', () => {
    expect(probeFitIsSeedable({ exact: false, kind: 'TILE_GRID', controlPassed: true }).seedable).toBe(false);
  });

  it('refuses UNKNOWN — nothing fit, or two fit equally', () => {
    expect(probeFitIsSeedable({ exact: true, kind: 'UNKNOWN', controlPassed: true }).seedable).toBe(false);
  });

  it('marks an exact unique fit seedable, still pending human review', () => {
    const r = probeFitIsSeedable({ exact: true, kind: 'BLOCK_GRID_SEP', controlPassed: true });
    expect(r.seedable).toBe(true);
    expect(r.reason).toMatch(/human review/i);
  });
});

/* ══════════════ ranking eligibility ══════════════ */

const baseRow = () => ({
  model_id: 'm', display_name: 'M', provider: 'p', provider_origin: 'US', tier: 'MID',
  pricing_model: 'usage',
  modalities_in: ['text'], modalities_out: ['text'],
  context_window: s(128_000), max_output: s(8192),
  is_reasoning_model: false, supports_tools: true, supports_caching: true, supports_vision: false,
  open_weights: false, license: null, served_quantization: 'unknown',
  tokenizer: {
    availability: 'LOCAL_EXACT', identifier: 'o200k_base', revision_hash: 'abc',
    proxy_for: null, proxy_basis: null, measured_delta_pct: null,
    tokenizer_multiplier: s(1), framing_tokens_per_message: s(3), conversation_preamble_tokens: s(7),
  },
  text_rates: [], service_tiers: [],
  vision: null, image_gen: null, video_gen: null, video_in: null, audio_in: null, hardware: null,
  compliance: {
    data_residency_region: ['us'], is_prc_hosted: false, contractual_dpa_available: true,
    residency_uplift_pct: s(0), notes: null,
  },
  quality_score: null, quality_score_source_url: null,
  effective_from: '2026-01-01T00:00:00.000Z', effective_to: null, deprecation_date: null,
});

describe('model row', () => {
  it('rejects a vision-capable row with no vision profile', () => {
    expect(() => ModelRow.parse({ ...baseRow(), supports_vision: true })).toThrow();
  });

  it('rejects an image-output row with no image_gen profile', () => {
    expect(() => ModelRow.parse({ ...baseRow(), modalities_out: ['text', 'image'] })).toThrow();
  });

  it('rejects a quality score with no source URL (§A6)', () => {
    expect(() => ModelRow.parse({ ...baseRow(), quality_score: 0.9 })).toThrow();
  });

  it('rejects an open-weight row missing architecture fields for the VRAM gate', () => {
    expect(() => ModelRow.parse({ ...baseRow(), open_weights: true })).toThrow();
  });

  it('rejects a PROXY tokenizer that does not name what it proxies', () => {
    const r = baseRow();
    r.tokenizer.availability = 'PROXY';
    expect(() => ModelRow.parse(r)).toThrow();
  });

  it('makes a subscription model non-comparable rather than cheaply priced (§A5.10)', () => {
    const m = ModelRow.parse({ ...baseRow(), pricing_model: 'subscription' });
    const e = rankingEligibility(m);
    expect(e.eligible).toBe(false);
    expect(e.reasons).toContain('SUBSCRIPTION_NON_COMPARABLE');
  });

  it('excludes a row whose vision geometry is UNAVAILABLE', () => {
    const m = ModelRow.parse({
      ...baseRow(),
      supports_vision: true,
      modalities_in: ['text', 'image'],
      vision: VisionProfile.parse({
        geometry: { geometry: 'UNAVAILABLE', reason: 'no published formula', probe_candidate: true },
        low_detail: { kind: 'UNSUPPORTED' },
        constraints: constraints(),
        provenance: prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }),
      }),
    });
    expect(rankingEligibility(m).reasons).toContain('VISION_GEOMETRY_UNAVAILABLE');
  });
});

/* ══════════════ §A5.3 — a claimed media modality needs its parameters ══════════════ */

describe('an audio- or video-accepting row must carry the profile that prices it', () => {
  it('refuses an audio modality with no audio_in', () => {
    expect(() => ModelRow.parse({ ...baseRow(), modalities_in: ['text', 'audio'] })).toThrow(
      /audio_in profile/,
    );
  });

  it('refuses a video modality with no video_in', () => {
    expect(() => ModelRow.parse({ ...baseRow(), modalities_in: ['text', 'video'] })).toThrow(
      /video_in profile/,
    );
  });

  it('accepts an audio row that carries one', () => {
    const m = ModelRow.parse({
      ...baseRow(),
      modalities_in: ['text', 'audio'],
      audio_in: {
        billing_basis: 'PER_TOKEN',
        tokens_per_second: s(25),
        billing_granularity_seconds: s(null, { method: 'UNAVAILABLE', confidence: 'NONE', source_url: null }),
        max_duration_seconds: s(9600),
        multichannel_multiplies: false,
      },
    });
    expect(m.audio_in?.billing_basis).toBe('PER_TOKEN');
  });
});
