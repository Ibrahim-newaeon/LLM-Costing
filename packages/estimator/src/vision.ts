// /packages/estimator/src/vision.ts
//
// Visual token counting — the first thing in the estimator, because it is the one
// piece where a plausible-looking shortcut gives materially wrong answers.
//
// Ported from prototype/src/lib/images.js behind the contracts' geometry union,
// per docs/prototype-salvage.md. The prototype had three hardcoded functions
// (openAIVisionTokens, gpt5VisionTokens, claudeVisionTokens) with the constants
// inline and no provenance. Here the constants arrive from the registry, each
// carrying its own `Provenance`, and a missing one BLOCKS rather than defaulting.
//
// Spec anchors: §A5.2 (vision) · §A5.2.0b (low detail resolves first) ·
// §A5.2.1 (disposition ladder) · §A3.2 (refuse rather than invent) ·
// §A3.7 (confidence propagates by minimum)
//
// Three traps this file exists to avoid, all documented on the union itself:
//
//   1. FLAT geometry — a resize saves NOTHING by construction. Offering one
//      teaches the user to ignore every resize suggestion you ever make.
//   2. BLOCK_GRID_SEP — cost is NOT MONOTONIC in pixel count. A larger image can
//      cost fewer tokens because block selection lands on a cheaper grid, so
//      "smaller is cheaper" is not merely imprecise, it is wrong.
//   3. Tile and patch grids are CEILING functions, and several providers upscale
//      anything below their shortest-edge target. Shrinking can therefore RAISE
//      the count. A resize is only ever proposed after recomputing both sides.

import {
  minConfidence,
  type Confidence,
  type Method,
  type Provenance,
  type Sourced,
  type DispositionRung,
  type Script,
  type VisionConstraints,
  type VisionProfile,
} from '@tokenomics/contracts';

/* ─────────────────────────── inputs & results ─────────────────────────── */

export interface VisionRequest {
  width_px: number;
  height_px: number;
  /** null is treated as the provider's default, i.e. not a low-detail request. */
  detail_mode: 'low' | 'high' | 'auto' | null;
}

export interface VisionCounted {
  status: 'COUNTED';
  /** Exact. Deterministic given these dimensions and these constants. */
  tokens: number;
  effective_width_px: number;
  effective_height_px: number;
  /** True when the dimensions billed differ from the dimensions supplied. */
  scaled: boolean;
  rung: DispositionRung;
  method: Method;
  confidence: Confidence;
  notes: string[];
}

export interface VisionUnavailable {
  status: 'UNAVAILABLE';
  reason: string;
  rung: DispositionRung;
  method: 'UNAVAILABLE';
  confidence: 'NONE';
}

export type VisionCount = VisionCounted | VisionUnavailable;

const unavailable = (reason: string, rung: DispositionRung = 'BLOCKED'): VisionUnavailable => ({
  status: 'UNAVAILABLE',
  reason,
  rung,
  method: 'UNAVAILABLE',
  confidence: 'NONE',
});

/* ─────────────────────────── evidence collection ─────────────────────────── */

/**
 * Every constant read is recorded, so the result's confidence is the minimum over
 * the values that ACTUALLY produced it (§A3.7) rather than a number typed in.
 */
interface Evidence {
  confidences: Confidence[];
  methods: Method[];
  missing: string[];
}

const newEvidence = (): Evidence => ({ confidences: [], methods: [], missing: [] });

/** Read a sourced constant, recording its provenance. Null is recorded as missing. */
function need<T>(ev: Evidence, s: Sourced<T>, label: string): T | null {
  ev.confidences.push(s.provenance.confidence);
  ev.methods.push(s.provenance.method);
  if (s.value === null) ev.missing.push(label);
  return s.value;
}

/** Record a provenance that governs the result without supplying a number. */
function observe(ev: Evidence, p: Provenance): void {
  ev.confidences.push(p.confidence);
  ev.methods.push(p.method);
}

/**
 * The method of a computed figure.
 *
 * If every constant came from the same tier, the result is that tier — applying a
 * vendor-published formula to vendor-published constants is still
 * PROVIDER_FORMULA. Mixed inputs collapse to DERIVED, which the contract defines
 * as "computed; inherits the WEAKEST input's confidence". Claiming the strongest
 * input's tier for a mixed computation is the exact silent-upgrade the `method`
 * field exists to prevent.
 */
function resolveMethod(methods: Method[]): Method {
  const distinct = [...new Set(methods)];
  if (distinct.length === 0) return 'UNAVAILABLE';
  if (distinct.length === 1) return distinct[0]!;
  return 'DERIVED';
}

/* ─────────────────────────── geometry helpers ─────────────────────────── */

const scaleToLongEdge = (w: number, h: number, maxEdge: number) => {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h, changed: false };
  const f = maxEdge / long;
  return { width: Math.max(1, Math.round(w * f)), height: Math.max(1, Math.round(h * f)), changed: true };
};

const scaleToShortEdge = (w: number, h: number, target: number) => {
  const short = Math.min(w, h);
  if (short <= target) return { width: w, height: h, changed: false };
  const f = target / short;
  return { width: Math.max(1, Math.round(w * f)), height: Math.max(1, Math.round(h * f)), changed: true };
};

/* ─────────────────────────── legibility floor ─────────────────────────── */

/**
 * §A5.2.1 — the smallest edge a resize may target without destroying the content.
 *
 * Mixed or unknown script takes the STRICTEST floor present, never the average.
 * Arabic dot placement and the ي/ى distinction fail at reductions Latin prose
 * survives, and a document that is 70% Latin and 30% Arabic still has to keep the
 * Arabic legible.
 *
 * Returns null when no floor is recorded — which means "unknown", not "no floor".
 * A caller must not read null as permission to shrink.
 */
export function legibilityFloorPx(
  constraints: VisionConstraints,
  script: Script | null,
  density: 'sparse' | 'normal' | 'dense' | null,
): number | null {
  const floors = constraints.min_legible_edge_px.filter((f) => f.px.value !== null);
  if (floors.length === 0) return null;

  const strictest = Math.max(...floors.map((f) => f.px.value as number));

  if (script === null || script === 'mixed' || density === null) return strictest;

  const exact = floors.find((f) => f.script === script && f.content_density === density);
  if (exact) return exact.px.value as number;

  // Script known but this density not tabulated: fall back to the strictest floor
  // for that script rather than to the global one, and to the global one if the
  // script itself is absent. Never interpolate — a floor is a measured threshold.
  const sameScript = floors.filter((f) => f.script === script);
  if (sameScript.length > 0) return Math.max(...sameScript.map((f) => f.px.value as number));
  return strictest;
}

/* ─────────────────────────── the counter ─────────────────────────── */

/**
 * How many visual tokens this image bills, and on which rung of the ladder it
 * landed. Deterministic: same inputs, same integer.
 *
 * This function NEVER mutates or proposes changes to the asset. Where the provider
 * itself normalizes — a token cap, an area clamp, a documented auto-resize — that
 * is reported as PROVIDER_NORMALIZED with the dimensions actually billed. Where it
 * does not, an out-of-spec asset is BLOCKED and the decision goes to the caller.
 */
export function countVisionTokens(profile: VisionProfile, req: VisionRequest): VisionCount {
  const { width_px: w0, height_px: h0 } = req;
  if (!Number.isFinite(w0) || !Number.isFinite(h0) || w0 < 1 || h0 < 1) {
    return unavailable('Image dimensions must be positive integers.');
  }

  const ev = newEvidence();
  observe(ev, profile.provenance);
  const notes: string[] = [];

  // ── §A5.2.0b — low detail resolves BEFORE the geometry branch ──
  // On every Chinese VLM checked, `detail: low` is a flat rate regardless of
  // dimensions. So low-detail mode IS a geometry on those models, and running the
  // main geometry first would price an image the provider never measured.
  if (req.detail_mode === 'low') {
    const ld = profile.low_detail;
    if (ld.kind === 'FLAT') {
      const flat = need(ev, ld.flat_tokens, 'low_detail.flat_tokens');
      return finish(ev, flat, w0, h0, false, 'FITS_AS_IS', [
        'Low detail is a flat rate on this model; dimensions do not affect the count.',
      ]);
    }
    if (ld.kind === 'UNSUPPORTED') {
      notes.push(
        'Low detail was requested but this provider has no low-detail mode; counted at full detail.',
      );
    } else {
      // INHERIT — "runs the main geometry at reduced resolution". The reduction
      // factor is provider behaviour and is NOT modelled anywhere in
      // VisionConstraints, so there is nothing to reduce BY. Counting at full
      // resolution would overstate the cost and look authoritative doing it.
      // Refusing is the correct outcome (§A3.2); the gap is in the contracts.
      return unavailable(
        'Low detail is INHERIT on this model — the main geometry at reduced resolution — but the ' +
          'reduction factor is not recorded in the vision profile. Counting at full resolution ' +
          'would overstate the cost. Record the factor, or request a different detail mode.',
      );
    }
  }

  const g = profile.geometry;
  const c = profile.constraints;

  if (g.geometry === 'UNAVAILABLE') {
    // §A3.2 — an unknown geometry is UNAVAILABLE, never defaulted to the familiar
    // tile grid. Every Chinese VLM checked speaks the OpenAI wire protocol and not
    // one uses OpenAI's geometry, so wire compatibility predicts nothing.
    return unavailable(`Vision geometry is UNAVAILABLE for this model: ${g.reason}`);
  }

  // ── FLAT: dimensions are irrelevant, so no constraint scaling applies ──
  if (g.geometry === 'FLAT') {
    const flat = need(ev, g.flat_tokens_per_image, 'flat_tokens_per_image');
    return finish(ev, flat, w0, h0, false, 'FITS_AS_IS', [
      ...notes,
      'Flat geometry: the count does not vary with dimensions.',
    ]);
  }

  // ── constraint-driven normalization, gated on the provider actually doing it ──
  let w = w0;
  let h = h0;
  let scaled = false;
  let rung: DispositionRung = 'FITS_AS_IS';

  const maxEdge = need(ev, c.max_edge_px, 'constraints.max_edge_px');
  if (maxEdge !== null && Math.max(w, h) > maxEdge) {
    if (!c.provider_auto_normalizes) {
      // The prototype scaled unconditionally. That silently prices an asset the
      // provider would have rejected, which is worse than refusing: it produces a
      // number for a request that cannot be made.
      return unavailable(
        `Longest edge ${Math.max(w, h)}px exceeds the provider maximum of ${maxEdge}px, and this ` +
          'provider does not auto-normalize. Resolve on the §A5.2.1 ladder — propose a resize, ' +
          'reroute, or block — rather than pricing dimensions the provider will not accept.',
      );
    }
    const s = scaleToLongEdge(w, h, maxEdge);
    w = s.width;
    h = s.height;
    scaled = s.changed;
    rung = 'PROVIDER_NORMALIZED';
    notes.push(`Provider normalizes to a ${maxEdge}px long edge; billed at ${w}x${h}.`);
  }

  const shortTarget = c.shortest_edge_target_px.value;
  observe(ev, c.shortest_edge_target_px.provenance);
  if (shortTarget !== null && c.provider_auto_normalizes && Math.min(w, h) > shortTarget) {
    const s = scaleToShortEdge(w, h, shortTarget);
    if (s.changed) {
      w = s.width;
      h = s.height;
      scaled = true;
      rung = 'PROVIDER_NORMALIZED';
      notes.push(`Provider normalizes to a ${shortTarget}px short edge; billed at ${w}x${h}.`);
    }
  }

  switch (g.geometry) {
    case 'TILE_GRID': {
      const flatMaxEdge = g.small_image_max_edge_px?.value ?? null;
      if (g.small_image_max_edge_px) observe(ev, g.small_image_max_edge_px.provenance);
      if (flatMaxEdge !== null && Math.max(w, h) <= flatMaxEdge && g.small_image_flat_tokens) {
        const small = need(ev, g.small_image_flat_tokens, 'small_image_flat_tokens');
        return finish(ev, small, w, h, scaled, rung, [
          ...notes,
          `Both edges are within ${flatMaxEdge}px, which this model flat-rates.`,
        ]);
      }
      const tw = need(ev, g.tile_w, 'tile_w');
      const th = need(ev, g.tile_h, 'tile_h');
      const base = need(ev, g.base_tokens, 'base_tokens');
      const perTile = need(ev, g.per_tile_tokens, 'per_tile_tokens');
      if (tw === null || th === null || base === null || perTile === null) {
        return finish(ev, null, w, h, scaled, rung, notes);
      }
      const tiles = Math.ceil(w / tw) * Math.ceil(h / th);
      return finish(ev, base + perTile * tiles, w, h, scaled, rung, [
        ...notes,
        `${tiles} tile(s) of ${tw}x${th}, plus a ${base}-token base.`,
      ]);
    }

    case 'AREA_BUDGET': {
      const divisor = need(ev, g.area_divisor, 'area_divisor');
      const budget = need(ev, g.area_budget_tokens, 'area_budget_tokens');
      if (divisor === null || budget === null) return finish(ev, null, w, h, scaled, rung, notes);
      const raw = Math.ceil((w * h) / divisor);
      const tokens = Math.min(budget, raw);
      return finish(ev, tokens, w, h, scaled, rung, [
        ...notes,
        raw > budget
          ? `Area count ${raw} is capped at the ${budget}-token budget.`
          : `Area ${w * h}px / ${divisor}.`,
      ]);
    }

    case 'PATCH_GRID': {
      const patch = need(ev, g.patch_px, 'patch_px');
      if (patch === null) return finish(ev, null, w, h, scaled, rung, notes);

      if (g.bound.bound_type === 'TOKEN_CAP') {
        const cap = need(ev, g.bound.token_cap, 'bound.token_cap');
        if (cap === null) return finish(ev, null, w, h, scaled, rung, notes);

        const patchesAt = (long: number, ratio: number) =>
          Math.ceil(long / patch) * Math.ceil(long / ratio / patch);

        const long = Math.max(w, h);
        const short = Math.min(w, h);
        const ratio = long / short;
        const direct = Math.ceil(w / patch) * Math.ceil(h / patch);
        if (direct <= cap) {
          return finish(ev, direct, w, h, scaled, rung, [
            ...notes,
            `${direct} patch(es) of ${patch}px, within the ${cap}-token cap.`,
          ]);
        }

        // Largest long edge whose patch grid still fits under the cap. Ported from
        // the prototype's binary search — the provider does this itself, so it is
        // normalization rather than a proposal.
        let lo = 1;
        let hi = long;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi + 1) / 2);
          if (patchesAt(mid, ratio) <= cap) lo = mid;
          else hi = mid - 1;
        }
        const newLong = lo;
        const newShort = Math.max(1, Math.round(newLong / ratio));
        const outW = w >= h ? newLong : newShort;
        const outH = w >= h ? newShort : newLong;
        return finish(ev, patchesAt(newLong, ratio), outW, outH, true, 'PROVIDER_NORMALIZED', [
          ...notes,
          `Cost saturates at the ${cap}-token cap; the provider scales to ${outW}x${outH}. ` +
            'An oversized image here is cheap and lossy, not expensive.',
        ]);
      }

      const minArea = need(ev, g.bound.min_area_px, 'bound.min_area_px');
      const maxArea = need(ev, g.bound.max_area_px, 'bound.max_area_px');
      if (minArea === null || maxArea === null) return finish(ev, null, w, h, scaled, rung, notes);

      const area = w * h;
      let aw = w;
      let ah = h;
      let clamped = false;
      if (area > maxArea || area < minArea) {
        const target = area > maxArea ? maxArea : minArea;
        const f = Math.sqrt(target / area);
        aw = Math.max(patch, Math.round((w * f) / patch) * patch);
        ah = Math.max(patch, Math.round((h * f) / patch) * patch);
        clamped = true;
      }
      const patches = Math.ceil(aw / patch) * Math.ceil(ah / patch);
      return finish(
        ev,
        patches,
        aw,
        ah,
        scaled || clamped,
        clamped ? 'PROVIDER_NORMALIZED' : rung,
        [
          ...notes,
          clamped
            ? `Area clamped into [${minArea}, ${maxArea}] preserving the ${patch}px multiple; billed at ${aw}x${ah}. ` +
              'Cost does NOT saturate here, so an oversized image is expensive and faithful.'
            : `${patches} patch(es) of ${patch}px.`,
        ],
      );
    }

    case 'BLOCK_GRID_SEP': {
      const block = need(ev, g.block_px, 'block_px');
      const perBlock = need(ev, g.per_block_tokens, 'per_block_tokens');
      const sepPerRow = need(ev, g.sep_tokens_per_row, 'sep_tokens_per_row');
      const sepConst = need(ev, g.sep_constant, 'sep_constant');
      if (block === null || perBlock === null || sepPerRow === null || sepConst === null) {
        return finish(ev, null, w, h, scaled, rung, notes);
      }

      // Where selection is a bounded lookup and the tie-break rule is unstated,
      // picking among candidates is a guess. A15 §14.7 found 23 allowed shapes in
      // one model's config with no published rule, so only exact matches count.
      if (g.candidate_resolutions.length > 0 && !g.tie_break_rule_known) {
        const exact = g.candidate_resolutions.some((r) => r.w === w && r.h === h);
        if (!exact) {
          return unavailable(
            `This model selects from ${g.candidate_resolutions.length} fixed resolutions and its ` +
              'tie-break rule is unpublished. ' +
              `${w}x${h} is not one of them, and interpolating between published shapes is a guess.`,
          );
        }
      }

      const wBlocks = Math.ceil(w / block);
      const hBlocks = Math.ceil(h / block);
      if (wBlocks * hBlocks > g.max_blocks) {
        return unavailable(
          `${wBlocks}x${hBlocks} blocks exceeds the ${g.max_blocks}-block maximum, and the rule this ` +
            'model uses to choose a smaller grid is not recorded. Selecting one would be a guess.',
        );
      }

      const globalView = g.global_view_included ? 1 : 0;
      const tokens =
        (hBlocks * wBlocks + globalView) * perBlock + (wBlocks + 1) * sepPerRow + sepConst;
      return finish(ev, tokens, w, h, scaled, rung, [
        ...notes,
        `${wBlocks}x${hBlocks} blocks` +
          (globalView ? ' plus a global view billed on top of the local blocks' : '') +
          `, with (${wBlocks} + 1) separator rows.`,
        'Cost is NOT monotonic in pixel count on this geometry — do not assume a smaller image is cheaper.',
      ]);
    }
  }
}

/** Assemble the result, applying §A3.7 and the missing-constant block. */
function finish(
  ev: Evidence,
  tokens: number | null,
  w: number,
  h: number,
  scaled: boolean,
  rung: DispositionRung,
  notes: string[],
): VisionCount {
  if (tokens === null || ev.missing.length > 0) {
    return unavailable(
      `Vision geometry is incomplete — no published value for: ${ev.missing.join(', ') || 'a required constant'}. ` +
        'A missing constant blocks the estimate; it is not zero (rule 1).',
    );
  }
  const confidence = ev.confidences.length ? minConfidence(...ev.confidences) : 'NONE';
  if (confidence === 'NONE') {
    return unavailable(
      'One of the geometry constants is UNAVAILABLE, so the count would inherit NONE confidence. ' +
        'Refusing rather than reporting a number nobody should act on (§A3.7).',
    );
  }
  return {
    status: 'COUNTED',
    tokens,
    effective_width_px: w,
    effective_height_px: h,
    scaled,
    rung,
    method: resolveMethod(ev.methods),
    confidence,
    notes,
  };
}

/* ─────────────────────────── resize evaluation (§A5.2.1 rung 3-5) ─────────────────────────── */

export interface ResizeEvaluation {
  /** tokens(candidate) − tokens(original). Negative is the only case worth proposing. */
  recomputed_tile_delta: number | null;
  /** FITS_AS_IS is never returned here; this answers only "should we propose it". */
  rung: Extract<DispositionRung, 'RESIZE_PROPOSED' | 'RESIZE_SAVES_NOTHING' | 'FIDELITY_LOCKED' | 'BLOCKED'>;
  reason: string;
  from: VisionCount;
  to: VisionCount;
}

/**
 * Would resizing to these dimensions actually save anything?
 *
 * Both sides are recomputed. Nothing here reasons from "smaller is cheaper",
 * because on three of the five geometries that is false or vacuous:
 *
 *   FLAT            saves nothing, always — suppressed entirely
 *   BLOCK_GRID_SEP  non-monotonic; a larger image can be cheaper
 *   TILE / PATCH    ceiling functions, and providers upscale below their
 *                   shortest-edge target, so shrinking can raise the count
 *
 * `fidelity_critical` and the legibility floor both block the rung outright,
 * before any arithmetic — a cheaper unreadable image is not a saving.
 */
export function evaluateResize(
  profile: VisionProfile,
  req: VisionRequest,
  candidate: { width_px: number; height_px: number },
  opts: { fidelity_critical?: boolean; script?: Script | null; density?: 'sparse' | 'normal' | 'dense' | null } = {},
): ResizeEvaluation {
  const from = countVisionTokens(profile, req);
  const to = countVisionTokens(profile, { ...req, ...candidate });

  const blocked = (rung: ResizeEvaluation['rung'], reason: string): ResizeEvaluation => ({
    recomputed_tile_delta: null,
    rung,
    reason,
    from,
    to,
  });

  if (opts.fidelity_critical) {
    return blocked(
      'FIDELITY_LOCKED',
      'The user marked this asset OCR-critical, which blocks the resize rung regardless of the saving.',
    );
  }

  if (profile.geometry.geometry === 'FLAT') {
    return blocked(
      'RESIZE_SAVES_NOTHING',
      'Flat geometry: the count does not vary with dimensions, so a resize saves nothing by ' +
        'construction. Suppressed rather than offered — a proposal that saves nothing teaches the ' +
        'user to ignore the ones that do.',
    );
  }

  const floor = legibilityFloorPx(profile.constraints, opts.script ?? null, opts.density ?? null);
  if (floor !== null && Math.min(candidate.width_px, candidate.height_px) < floor) {
    return blocked(
      'FIDELITY_LOCKED',
      `Candidate short edge ${Math.min(candidate.width_px, candidate.height_px)}px is below the ` +
        `${floor}px legibility floor for this content. A cheaper unreadable image is not a saving.`,
    );
  }

  if (from.status !== 'COUNTED' || to.status !== 'COUNTED') {
    return blocked(
      'BLOCKED',
      'One side of the comparison could not be counted, so the saving is unknown. ' +
        (from.status === 'UNAVAILABLE' ? from.reason : (to as VisionUnavailable).reason),
    );
  }

  const delta = to.tokens - from.tokens;
  if (delta >= 0) {
    return {
      recomputed_tile_delta: delta,
      rung: 'RESIZE_SAVES_NOTHING',
      reason:
        delta === 0
          ? 'Recomputed count is identical; the resize crosses no boundary.'
          : `Recomputed count is ${delta} token(s) HIGHER. Shrinking raised the cost — ` +
            'a ceiling function, or the provider upscaling below its shortest-edge target.',
      from,
      to,
    };
  }

  return {
    recomputed_tile_delta: delta,
    rung: 'RESIZE_PROPOSED',
    reason: `Recomputed count is ${-delta} token(s) lower. Propose it; the estimator does not apply it.`,
    from,
    to,
  };
}
