// /packages/contracts/src/vision.ts
//
// CANONICAL vision geometry. Fixes three defects found when fit.ts,
// registry.schema.ts and Annex A15 §11 were compared:
//
//   1. BLOCK_GRID_SEP is produced by fit.ts and documented as a verified
//      PROVIDER_FORMULA in A15 §3, and was storable by NEITHER Zod file.
//      DeepSeek-VL2's geometry had nowhere to live.
//   2. FLAT was in A15 §11 but missing from registry.schema.ts, so a flat
//      per-image model could not be seeded there at all.
//   3. A15 §11 refined `PATCH_GRID requires patch_px AND token_cap`, which
//      REJECTS Qwen-VL and GLM-4.1V — verified patch grids bounded by pixel
//      AREA, not by a token cap. The schema actively refused a correct row.
//
// The fix for (3) is structural rather than another refinement: a patch grid is
// a discriminated union on `bound_type`, so a TOKEN_CAP row carries token_cap and
// cannot carry area bounds, and an AREA_CLAMP row is the mirror. Neither can be
// null-filled into the other's shape.
//
// Spec anchors: §A5.2 (geometry families) · §A5.2.0b (detail before geometry) ·
// §A5.2.1 (disposition ladder) · §A4.6.1 (probe output maps 1:1 to these kinds).

import { z } from 'zod';
import { sourced, Provenance } from './provenance';

/* ─────────────────────── shared constraint envelope ─────────────────────── */

export const Script = z.enum([
  'latin',
  'ar_msa',
  'ar_dialect',
  'ar_vocalized',
  'zh_hans',
  'zh_hant',
  'mixed',
]);
export type Script = z.infer<typeof Script>;

export const ContentDensity = z.enum(['sparse', 'normal', 'dense']);

/**
 * §A5.2.1 fidelity floor. Mixed or unknown script takes the STRICTEST floor
 * present, never the average — Arabic dot placement and CJK stroke separation
 * fail at reductions Latin prose survives.
 */
export const LegibilityFloor = z.object({
  script: Script,
  content_density: ContentDensity,
  px: sourced(z.number().int().positive()),
});

/** Applies to every geometry. The disposition ladder (§A5.2.1) reads these. */
export const VisionConstraints = z.object({
  max_edge_px: sourced(z.number().int().positive()),
  min_edge_px: sourced(z.number().int().positive()),
  shortest_edge_target_px: sourced(z.number().int().positive()),
  max_bytes: sourced(z.number().int().positive()),
  max_pages: sourced(z.number().int().positive()),
  allowed_mime: z.array(z.string()).default([]),
  /** true ⇒ tile on POST-normalization dimensions (ladder rung 2). */
  provider_auto_normalizes: z.boolean().default(false),
  min_legible_edge_px: z.array(LegibilityFloor).default([]),
  /**
   * §A5.9.1 — a short-context VLM can be blocked by ONE image. Carried here so
   * the context gate can be raised from the VISUAL token count, not only text.
   */
  max_context_tokens: sourced(z.number().int().positive()),
});
export type VisionConstraints = z.infer<typeof VisionConstraints>;

/* ─────────────────────── low-detail branch (§A5.2.0b) ─────────────────────── */

/**
 * `detail: low` is a FLAT rate on every Chinese VLM checked — a constant,
 * regardless of dimensions. So low-detail mode IS geometry FLAT on those models,
 * and it must be resolved BEFORE the geometry branch. Modelled as a union so
 * "flat on low" cannot be expressed as a stray nullable field on the main shape.
 */
export const LowDetailBehaviour = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('FLAT'),
    flat_tokens: sourced(z.number().int().nonnegative()),
  }),
  z.object({
    kind: z.literal('INHERIT'), // runs the main geometry at reduced resolution
  }),
  z.object({
    kind: z.literal('UNSUPPORTED'), // provider has no low-detail mode
  }),
]);
export type LowDetailBehaviour = z.infer<typeof LowDetailBehaviour>;

/* ─────────────────────── the geometry union ─────────────────────── */

const tok = () => sourced(z.number().int().nonnegative());
const px = () => sourced(z.number().int().positive());

/**
 * G1a / G1b — patch grid. Same patch size, two incompatible bounds.
 *
 * Per A15 §3 (vendor pages, 2026-09-06) Claude, Qwen-VL and GLM-4.1V all use a
 * 28px patch grid. Claude bounds on a TOKEN CAP — cost saturates, so an oversized
 * image is cheap and lossy. Qwen and GLM bound on a pixel AREA range — cost does
 * not saturate, so the same image is expensive and faithful. Order-of-magnitude
 * divergence from a formula identical on paper.
 *
 * A router comparing the two on price alone, without the source dimensions, will
 * be wrong about which is cheaper.
 */
const PatchBound = z.discriminatedUnion('bound_type', [
  z.object({
    bound_type: z.literal('TOKEN_CAP'),
    /** Binary-search a scale factor until patches ≤ cap. */
    token_cap: tok(),
  }),
  z.object({
    bound_type: z.literal('AREA_CLAMP'),
    /** Clamp total pixel area into [min,max], preserving the patch multiple. */
    min_area_px: sourced(z.number().int().positive()),
    max_area_px: sourced(z.number().int().positive()),
  }),
]);

export const VisionGeometry = z.discriminatedUnion('geometry', [
  /** tokens = ⌈w/P⌉ × ⌈h/P⌉, subject to bound */
  z.object({
    geometry: z.literal('PATCH_GRID'),
    patch_px: px(),
    bound: PatchBound,
  }),

  /** tokens = base + per_tile × ⌈w/tw⌉ × ⌈h/th⌉ */
  z.object({
    geometry: z.literal('TILE_GRID'),
    tile_w: px(),
    tile_h: px(),
    base_tokens: tok(),
    /** A null here silently priced every image at base_tokens in the old schema. */
    per_tile_tokens: sourced(z.number().int().positive()),
    /** Some tile grids flat-rate anything small in both dimensions. */
    small_image_flat_tokens: tok().nullable().default(null),
    small_image_max_edge_px: px().nullable().default(null),
  }),

  /**
   * tokens = min(budget, area_px / divisor)
   * SMOOTH in pixels — no ceiling behaviour, so resize savings are continuous
   * here and discrete under PATCH_GRID / TILE_GRID. §A5.2.1 rung 4 must branch.
   */
  z.object({
    geometry: z.literal('AREA_BUDGET'),
    area_divisor: sourced(z.number().positive()),
    area_budget_tokens: sourced(z.number().int().positive()),
  }),

  /**
   * tokens = flat, regardless of dimensions.
   * Resize proposals must be SUPPRESSED ENTIRELY — they save nothing by
   * construction, and offering one teaches the user to ignore all of them.
   */
  z.object({
    geometry: z.literal('FLAT'),
    flat_tokens_per_image: sourced(z.number().int().positive()),
  }),

  /**
   * tokens = (h·w + 1) × per_block + (w + 1) × sep_per_row + constant
   *
   * The shape fit.ts recovers and neither prior schema could store. Two terms
   * have no analogue in any Western geometry:
   *   · the +1 in (h·w + 1) is a GLOBAL VIEW billed on top of the local blocks
   *   · (w + 1) × sep depends on WIDTH ALONE, not area
   *
   * Consequence: token cost is NOT MONOTONIC in pixel count. A15 §3 records a
   * larger image costing fewer tokens than a smaller one, because block selection
   * lands on a cheaper grid. Any "smaller is cheaper" shortcut gives wrong advice.
   */
  z.object({
    geometry: z.literal('BLOCK_GRID_SEP'),
    block_px: px(),
    per_block_tokens: sourced(z.number().int().positive()),
    sep_tokens_per_row: tok(),
    sep_constant: tok(),
    global_view_included: z.boolean().default(true),
    max_blocks: z.number().int().positive(),
    /**
     * Where selection is a bounded lookup rather than a free search, enumerate it.
     * A15 §14.7 found 23 allowed shapes exposed in one model's config; the
     * tie-break rule is still unstated, which is why worked examples remain the
     * only trustworthy points and unpublished sizes are left blank, not interpolated.
     */
    candidate_resolutions: z
      .array(z.object({ w: z.number().int().positive(), h: z.number().int().positive() }))
      .default([]),
    tie_break_rule_known: z.boolean().default(false),
  }),

  /**
   * Explicit refusal. §A3.2 — a model whose geometry is unknown is UNAVAILABLE,
   * never defaulted to the familiar tile grid. Wire compatibility predicts
   * nothing about billing geometry: every Chinese VLM checked speaks the OpenAI
   * protocol and not one uses OpenAI's geometry.
   */
  z.object({
    geometry: z.literal('UNAVAILABLE'),
    reason: z.string().min(1),
    probe_candidate: z.boolean().default(true), // eligible for §A4.6.1
  }),
]);
export type VisionGeometry = z.infer<typeof VisionGeometry>;

/* ─────────────────────── the profile ─────────────────────── */

export const VisionProfile = z.object({
  geometry: VisionGeometry,
  low_detail: LowDetailBehaviour,
  constraints: VisionConstraints,
  provenance: Provenance,
});
export type VisionProfile = z.infer<typeof VisionProfile>;

/* ─────────────────────── probe → registry bridge ─────────────────────── */

/**
 * fit.ts emits GeometryKind. This is the total mapping, so a probe result can
 * never land on a kind the registry cannot hold — the defect this file fixes.
 *
 * UNKNOWN maps to UNAVAILABLE deliberately: the fitter returns UNKNOWN both when
 * nothing fits and when two candidates fit equally, and neither is a result.
 */
export const PROBE_KIND_TO_GEOMETRY = {
  FLAT: 'FLAT',
  PATCH_GRID: 'PATCH_GRID',
  TILE_GRID: 'TILE_GRID',
  AREA_BUDGET: 'AREA_BUDGET',
  BLOCK_GRID_SEP: 'BLOCK_GRID_SEP',
  UNKNOWN: 'UNAVAILABLE',
} as const satisfies Record<string, VisionGeometry['geometry']>;

/**
 * A probe fit is EVIDENCE, not a registry entry (§A4.6.1 rule 6). This asserts the
 * two conditions a human reviewer must see before seeding, and it is intentionally
 * not a function that writes anything.
 */
export function probeFitIsSeedable(fit: {
  exact: boolean;
  kind: keyof typeof PROBE_KIND_TO_GEOMETRY;
  controlPassed: boolean;
}): { seedable: boolean; reason: string } {
  if (!fit.controlPassed) {
    return {
      seedable: false,
      reason:
        'Control model did not recover its published geometry. Every result in this run is suspect (§A4.6.1 rule 2).',
    };
  }
  if (!fit.exact) {
    return {
      seedable: false,
      reason: 'Fit was not exact on every observation. A near-miss is a coincidence with counterexamples.',
    };
  }
  if (fit.kind === 'UNKNOWN') {
    return { seedable: false, reason: 'UNKNOWN — nothing fit, or two candidates fit equally.' };
  }
  return { seedable: true, reason: 'Exact unique fit with a passing control. Requires human review before seeding.' };
}

/* ─────────────────────── inferred types ───────────────────────
 * Companions for the schemas above that were defined without one. Every schema in
 * this package should export both: a consumer that can only import the value has to
 * write `z.infer<typeof X>` at its own use sites, which is the same shape spelled
 * out in two places and one edit away from disagreeing.
 */
export type ContentDensity = z.infer<typeof ContentDensity>;
export type LegibilityFloor = z.infer<typeof LegibilityFloor>;
