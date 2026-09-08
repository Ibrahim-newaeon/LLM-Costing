// /packages/contracts/src/pricing.ts
//
// Rates, tiers, caches, and the request-level layer that §A5.8's token identity
// does not cover. Reconciles the Rate/ContextTier/CacheProfile definitions that
// existed in two places with different shapes.
//
// Spec anchors: §A5.6 (caching) · §A5.7 (context tiers) · §A5.8 (identity) ·
// §A5.10 (request-level multipliers and non-token fees) · §A4.2 (FX, native currency)

import { z } from 'zod';
import { sourced, Provenance } from './provenance';

/* ─────────────────────────── money ─────────────────────────── */

export const Currency = z.string().length(3);

/* ─────────────────────── how a model is served ─────────────────────── */

/**
 * Sibling of ServiceTier: that says which lane a request takes, this says who runs
 * the hardware. It changes which cost terms exist at all — a SELF_HOSTED candidate
 * has gpu_seconds and idle_gpu lines and no per-token rate.
 */
export const DeploymentMode = z.enum(['API_MANAGED', 'SELF_HOSTED', 'DEDICATED_CAPACITY']);
export type DeploymentMode = z.infer<typeof DeploymentMode>;

/* ─────────────────────── conflicts and staleness ─────────────────────── */

/**
 * Rule 5 — conflicts are REPORTED, never merged, and never averaged.
 *
 * This is that rule's only home in the contracts. The prior
 * /schemas/pricing-record.schema.json carried it on a record type whose payload
 * duplicated TextRateProfile, ContextTier, CacheProfile and VisionProfile; that
 * record is not being recreated (2026-09-07 decision).
 *
 * ⚠️ CORRECTION (2026-09-08). The sentence that stood here — "what it had and the
 * contracts lacked was exactly three things: DeploymentMode, the staleness gate,
 * and this" — was wrong, and wrong in the direction that hides work. It was FOUR.
 * The record's `self_hosted_profile` also carried the instance economics
 * (gpu_count, vram_per_gpu, on-demand and spot hourly rates, regional tax, storage,
 * egress, concurrency_efficiency_factor), and only its throughput fields duplicated
 * HardwareProfile. That half had no counterpart in the contracts and was lost with
 * the file, which blocked §A5.9 until instance.ts restored it. See instance.ts for
 * the full accounting.
 *
 * The three named below still belong on the rate itself, where the disagreement
 * actually is.
 *
 * Field naming follows Rate: `competing_amount`, not the old `competing_value`.
 */
export const RateConflict = z.object({
  competing_record_id: z.string().min(1),
  competing_amount: z.number().nonnegative(),
  competing_source_url: z.string().url(),
  /** Signed, relative to this rate's amount. Kept for display, not for choosing. */
  delta_pct: z.number(),
  /**
   * A human decided which source is right. Until then BOTH are shown — an
   * unresolved conflict is a fact about the data, not a rendering problem to
   * smooth over.
   */
  resolved: z.boolean().default(false),
});
export type RateConflict = z.infer<typeof RateConflict>;

/**
 * Whether a rate is still usable. Four states, because "we never wrote down a
 * staleness policy" and "this rate is fresh" are not the same claim.
 */
export type Freshness = 'FRESH' | 'STALE' | 'UNVERIFIED' | 'NO_POLICY';

/**
 * §A4.2 — the vendor's NATIVE currency is the source of truth. A converted figure
 * is never stored as primary, because a CNY rate frozen at yesterday's USD is a
 * silent mispricing on every Chinese provider.
 */
export const Rate = z
  .object({
    amount: z.number().nonnegative(),
    unit: z.enum([
      'per_1m_tokens',
      'per_1k_tokens',
      'per_token',
      'per_image',
      'per_megapixel',
      'per_step',
      'per_second',
      'per_request',
      'per_1k_calls',
      'per_gb_day',
      'per_gb', // egress: charged by volume moved, with no period attached
      'per_1m_tokens_per_hour', // §A5.10 cache storage
      // §A5.9 — the two are NOT interchangeable. On an 8-GPU box, reading one as the
      // other is an 8× error, and it lands in the direction that makes self-hosting
      // look cheap. InstanceProfile refuses any other unit on an hourly rate.
      'per_gpu_hour',
      'per_instance_hour',
    ]),
    list_currency: Currency.default('USD'),
    fx_rate_used: z.number().positive().nullable().default(null),
    fx_rate_date: z.string().datetime().nullable().default(null),
    fx_source_url: z.string().url().nullable().default(null),
    effective_from: z.string().datetime(),
    effective_to: z.string().datetime().nullable(),
    /** §14.9 — peak/off-peak exists in the market; a single amount cannot express it. */
    time_of_day_variant: z.enum(['all_hours', 'peak', 'offpeak']).default('all_hours'),
    /**
     * Days after which this row is stale and must BLOCK rather than price.
     *
     * Null is not "never stale" — it is "no policy was recorded", which
     * `rateFreshness` reports as its own state rather than quietly passing. A
     * default here would be a hardcoded policy pretending to be a fact.
     */
    max_age_days: z.number().int().positive().nullable().default(null),
    /** Rule 5. Set when another source disagrees beyond tolerance. */
    conflict: RateConflict.nullable().default(null),
    provenance: Provenance,
  })
  .refine(
    (r) => r.list_currency === 'USD' || (r.fx_rate_used !== null && r.fx_rate_date !== null),
    { message: 'A non-USD list price requires fx_rate_used + fx_rate_date (§A4.2).', path: ['fx_rate_used'] },
  );
export type Rate = z.infer<typeof Rate>;

/**
 * The staleness gate. Deliberately returns four states rather than a boolean.
 *
 * A boolean would have to answer `false` for a rate with no recorded policy and
 * for a rate verified this morning, and those are opposite situations. The caller
 * decides what to do with NO_POLICY and UNVERIFIED — this function refuses to
 * decide for it, which is the same reason `Method` has UNAVAILABLE.
 *
 * STALE must block estimation, not annotate it (§A3.2).
 */
export function rateFreshness(r: Rate, now: Date = new Date()): Freshness {
  if (r.provenance.verified_at === null) return 'UNVERIFIED';
  if (r.max_age_days === null) return 'NO_POLICY';
  const verifiedAt = Date.parse(r.provenance.verified_at);
  if (Number.isNaN(verifiedAt)) return 'UNVERIFIED';
  const ageDays = (now.getTime() - verifiedAt) / 86_400_000;
  return ageDays > r.max_age_days ? 'STALE' : 'FRESH';
}

/** True only for the one state that may be priced against. */
export const isPriceable = (f: Freshness): boolean => f === 'FRESH';

/* ─────────────────────── validity, which is not freshness ─────────────────────── */

/**
 * Which rate is IN FORCE at a given moment.
 *
 * `rateFreshness` asks whether a row was checked recently enough to trust. This asks
 * something different and independent: whether the row applies to the date being
 * priced. A rate can be verified this morning and still be the wrong rate for the
 * estimate, because vendors publish price changes in advance.
 *
 * That is not hypothetical. Google's pricing page carries entries of the form
 * "$0.75 through December 31, 2026. $1.50 starting January 1, 2027" — two rates for
 * one model, distinguished only by these fields (retrieved 2026-09-08 from
 * https://ai.google.dev/gemini-api/docs/pricing; the page shows no publication date).
 *
 * ⚠️ `effective_from` and `effective_to` have been on `Rate` since the contract was
 * written and, until this function, **nothing read them**. A registry holding both
 * halves of a scheduled change would have priced whichever row the caller happened
 * to reach first, and been silently 2x out from a fixed date onward with no warning.
 *
 * Ambiguity is reported, never resolved. Two rates covering the same instant is a
 * data defect — picking the cheaper flatters the estimate, picking the newer assumes
 * an ordering nobody published, and picking either hides the defect (rule 5).
 */
export type RateValidity =
  | { status: 'IN_FORCE'; rate: Rate }
  | { status: 'NONE_IN_FORCE'; reason: string }
  | { status: 'AMBIGUOUS'; reason: string; candidates: Rate[] };

export function rateInForce(rates: readonly Rate[], at: Date = new Date()): RateValidity {
  if (rates.length === 0) {
    return { status: 'NONE_IN_FORCE', reason: 'No rates supplied.' };
  }
  const t = at.getTime();
  const covering = rates.filter((r) => {
    const from = Date.parse(r.effective_from);
    if (Number.isNaN(from) || t < from) return false;
    if (r.effective_to === null) return true;
    const to = Date.parse(r.effective_to);
    // `effective_to` is the END of the window. A rate published as "through
    // December 31" is recorded with an exclusive bound at the following midnight,
    // so the comparison is strict and the two halves of a scheduled change never
    // both cover the boundary instant.
    return !Number.isNaN(to) && t < to;
  });

  if (covering.length === 0) {
    return {
      status: 'NONE_IN_FORCE',
      reason: `No rate covers ${at.toISOString()}. A gap in the schedule blocks the estimate — the alternative is pricing a date at a rate the vendor did not publish for it.`,
    };
  }
  if (covering.length > 1) {
    return {
      status: 'AMBIGUOUS',
      reason: `${covering.length} rates cover ${at.toISOString()}. Overlapping windows are a data defect: choosing between them would either flatter the estimate or assume an ordering nobody published (rule 5).`,
      candidates: covering,
    };
  }
  return { status: 'IN_FORCE', rate: covering[0]! };
}

/**
 * True when a scheduled change is close enough that a quote for work starting later
 * would be priced wrong. The UI warns; it does not silently switch rates.
 */
export function ratePriceChangeAhead(
  rates: readonly Rate[],
  at: Date = new Date(),
): { changes_at: string; from_amount: number; to_amount: number } | null {
  const current = rateInForce(rates, at);
  if (current.status !== 'IN_FORCE' || current.rate.effective_to === null) return null;
  const next = rateInForce(rates, new Date(Date.parse(current.rate.effective_to)));
  if (next.status !== 'IN_FORCE') return null;
  return {
    changes_at: current.rate.effective_to,
    from_amount: current.rate.amount,
    to_amount: next.rate.amount,
  };
}

/* ─────────────────────── context tiers (§A5.7) ─────────────────────── */

export const ContextTier = z.object({
  /** null = unbounded top tier. */
  upper_bound_tokens: z.number().int().positive().nullable(),
  input_rate: Rate,
  output_rate: Rate,
  cache_read_rate: Rate.nullable().default(null),
  /**
   * TRUE where crossing the threshold reprices EVERY token in the request rather
   * than the overflow. The step is then far larger than a marginal reading
   * suggests, and the near-threshold warning must use this to size the saving.
   */
  applies_to_whole_request: z.boolean().default(true),
});
export type ContextTier = z.infer<typeof ContextTier>;

/* ─────────────────────── caching (§A5.6, §A5.10) ─────────────────────── */

export const CacheProfile = z.object({
  write_rate: Rate.nullable(),
  read_rate: Rate.nullable(),
  /** Multiplier on base input per TTL bucket, where the vendor publishes it that way. */
  write_multipliers_by_ttl: z.record(z.string(), z.number().positive()).default({}),
  min_cacheable_tokens: sourced(z.number().int().positive()),
  ttl_seconds: sourced(z.number().int().positive()),
  is_automatic: z.boolean().nullable().default(null),
  /**
   * §A5.10 — at least one provider bills cached content BY THE HOUR whether or not
   * you call the model. Per-provider, nullable: every cache model in this spec
   * before v2.0 assumed write+read only. A long-lived cache on a low-traffic
   * workload can cost more than it saves, and the estimator must be able to show it.
   */
  storage_rate_per_hour: Rate.nullable().default(null),
});
export type CacheProfile = z.infer<typeof CacheProfile>;

/* ─────────────────── service tier & residency (§A5.10) ─────────────────── */

export const ServiceTier = z.enum(['standard', 'batch', 'flex', 'priority', 'fast', 'provisioned']);
export type ServiceTier = z.infer<typeof ServiceTier>;

/**
 * ⚠️ These multipliers are NOT shared across vendors. A15 §9.1 records one
 * provider's premium tier at 1.8× where two others use 2×. Store PER PROVIDER —
 * a shared constant here is a hardcoded rate wearing a config's clothes (§A3.1).
 */
export const ServiceTierProfile = z.object({
  tier: ServiceTier,
  multiplier: sourced(z.number().positive()),
  available: z.boolean().default(true),
  /** Some tiers are unavailable in combination — e.g. fast excluded with batch. */
  excludes: z.array(ServiceTier).default([]),
  /** And some are unavailable under a residency constraint. */
  unavailable_in_regions: z.array(z.string()).default([]),
});

export const ServerToolFee = z.object({
  tool: z.string().min(1), // 'web_search' | 'file_search' | 'code_container' | vendor label
  rate: Rate,
  free_allowance_per_month: z.number().int().nonnegative().nullable().default(null),
});

/* ─────────────────────── text / code rates ─────────────────────── */

export const TextRateProfile = z.object({
  variant: ServiceTier.default('standard'),
  currency: Currency,
  /**
   * §A5.10 — audio is frequently a SEPARATE input rate, often a multiple of text.
   * One input_rate per model is not enough; key by modality.
   *
   * ⚠️ ALL FOUR KEYS ARE REQUIRED. `z.record` over an enum key is exhaustive, so a
   * text-and-image model must write `audio: null, video: null` rather than omit
   * them. That is deliberate and worth the noise: an omitted key is
   * indistinguishable from a modality nobody thought about, and this record is
   * where a missing audio rate would otherwise read as "no audio charge" instead of
   * "we never looked". Documented here because it was undocumented until the first
   * real registry row failed to parse against it (2026-09-08).
   *
   * The four are a deliberate subset of `Modality`, which also has `code` (priced as
   * text everywhere seen so far) and `embedding` (a different endpoint with its own
   * rate shape, not an input modality of a chat model).
   */
  input_rate_by_modality: z.record(
    z.enum(['text', 'image', 'audio', 'video']),
    Rate.nullable(),
  ),
  output_rate: Rate,
  /**
   * Null means UNPUBLISHED, which inherits NONE confidence — it does NOT mean
   * free and it must never render as "n/a". `n/a` reads as zero to a user, and
   * that is a silent pricing error.
   */
  reasoning_output_rate: Rate.nullable().default(null),
  per_request_fee: Rate.nullable().default(null),
  /**
   * NULL where the provider includes its full long context at the standard rate.
   * Not a single-entry array, and not an assumed surcharge (§A5.10).
   */
  context_tiers: z.array(ContextTier).nullable().default(null),
  cache: CacheProfile.nullable().default(null),
  /**
   * §A5.10 — published per-model tokens for merely ENABLING tools. Separate from
   * and additional to the tool-schema JSON counted in §A5.1. Two meters, both real.
   */
  tool_use_system_prompt_tokens: z
    .array(z.object({ tool_choice_mode: z.string(), tokens: sourced(z.number().int().nonnegative()) }))
    .default([]),
  /** Not token-priced at all. A token-only estimator returns zero for these. */
  server_tool_fees: z.array(ServerToolFee).default([]),
});
export type TextRateProfile = z.infer<typeof TextRateProfile>;

/* ─────────────────────── image generation (§A7, §A5.10) ─────────────────────── */

/**
 * §A5.10 adds the fourth dimension. Some providers meter image OUTPUT in tokens
 * and the per-image figure is DERIVED (tokens_for_resolution × output_rate);
 * render the derived per-image figure as authoritative with the token figure as
 * the explanation.
 */
export const ImagePricingDimension = z.enum([
  'per_image',
  'per_megapixel',
  'per_step',
  'per_output_token',
]);

export const ImageGenProfile = z.object({
  pricing_dimension: ImagePricingDimension,
  supported_classes: z
    .array(z.enum(['TEXT_TO_IMAGE', 'IMAGE_TO_IMAGE', 'MASK_INPAINT', 'UPSCALE']))
    .min(1),
  price_matrix: z
    .array(z.object({ size: z.string(), quality: z.string(), rate: Rate }))
    .default([]),
  /** For per_output_token models: resolution → output tokens. */
  output_tokens_by_resolution: z
    .array(z.object({ resolution: z.string(), tokens: sourced(z.number().int().positive()) }))
    .default([]),
  output_token_rate: Rate.nullable().default(null),
  /** §A7 — an edit bills the source image as vision input FIRST. */
  bills_source_as_vision_input: z.boolean(),
  /** Some providers bill the full canvas on inpaint regardless of mask area. */
  inpaint_bills_full_canvas: z.boolean(),
  upscale_multiplier: sourced(z.number().positive()),
  max_reference_images: z.number().int().nonnegative().nullable().default(null),
  /** Self-hosted only — MEASURED on your hardware, never a vendor marketing figure. */
  steps_per_second: sourced(z.number().positive()),
});
export type ImageGenProfile = z.infer<typeof ImageGenProfile>;

/* ─────────────────────── video ─────────────────────── */

export const VideoGenProfile = z.object({
  pricing_dimension: z.enum(['per_second', 'per_clip']),
  rate_matrix: z
    .array(
      z.object({
        resolution_tier: z.string(),
        fps: z.number().int().positive().nullable(),
        audio_generated: z.boolean(),
        rate: Rate,
      }),
    )
    .default([]),
  max_duration_seconds: sourced(z.number().positive()),
  generates_native_audio: z.boolean(),
  /** §A5.10 — published on at least one model. Assuming either way is a guess. */
  bills_failed_generations: z.boolean().nullable().default(null),
  expected_retry_rate: z.number().min(0).max(1).nullable().default(null),
  per_request_fee: Rate.nullable().default(null),
  /** Credit-pack vendors: two SEPARATE sourced records, never collapsed. */
  credit_conversion: z
    .object({
      credits_per_unit: sourced(z.number().positive()),
      currency_per_credit: sourced(z.number().positive()),
    })
    .nullable()
    .default(null),
});

/**
 * §A5.3 audio INPUT — "duration-driven, not byte-driven".
 *
 *   audio_tokens = ceil(duration_seconds) x tokens_per_second[model]
 *
 * This profile exists because standalone audio had no home. `VideoInputProfile`
 * carries `audio_tokens_per_second`, but that is the audio TRACK OF A VIDEO —
 * a different quantity on a different asset, and reading it for a bare audio file
 * would price one model's video path as another model's audio path.
 *
 * The two billing bases below are both real and are not interchangeable. §A5.3
 * writes the token form; §A5.8's identity writes `audio_seconds x audio_rate`.
 * A provider does one or the other, and guessing which is a silent mispricing that
 * scales with the length of the recording.
 */
export const AudioInputProfile = z
  .object({
    /**
     * PER_TOKEN — duration converts to tokens at `tokens_per_second`, then bills at
     *             the audio input rate in tokens.
     * PER_SECOND — duration bills directly against a `per_second` rate; there is no
     *             token count and inventing one to display would be a fabricated
     *             figure with a plausible unit.
     */
    billing_basis: z.enum(['PER_TOKEN', 'PER_SECOND']),
    /** Required in practice for PER_TOKEN. Null there is a refusal, not a zero. */
    tokens_per_second: sourced(z.number().positive()),
    /**
     * §A5.3's ceiling. Null means the whole-second ceiling in the spec formula
     * applies; a published finer granularity (100 ms, say) overrides it. Not
     * defaulted to 1, because "the spec says round up to a second" and "this vendor
     * bills in whole seconds" are different claims and only one of them is sourced.
     */
    billing_granularity_seconds: sourced(z.number().positive()),
    max_duration_seconds: sourced(z.number().positive()),
    /** Whether a diarized/multichannel track multiplies the count. Unknown ⇒ null. */
    multichannel_multiplies: z.boolean().nullable().default(null),
  })
  .refine((a) => a.billing_basis !== 'PER_SECOND' || a.tokens_per_second.value === null, {
    message:
      'A PER_SECOND audio profile must not carry a token equivalence — two billing bases on one row is how the wrong one gets read (§A5.3).',
    path: ['tokens_per_second'],
  });
export type AudioInputProfile = z.infer<typeof AudioInputProfile>;

export const VideoInputProfile = z.object({
  /** §A5.3 — the whole cost. Often user-configurable, so surface it before upload. */
  frame_sample_rate_hz: sourced(z.number().positive()),
  user_configurable_fps: z.boolean().default(false),
  per_frame_uses_vision_geometry: z.boolean().default(true),
  audio_tokens_per_second: sourced(z.number().nonnegative()),
  audio_billed_separately: z.boolean(),
  max_duration_seconds: sourced(z.number().positive()),
  max_frames: sourced(z.number().int().positive()),
  /**
   * Hard gate. §A5.3 forces LOW absent a deterministic formula — and where a
   * provider offers an adaptive mode that loads only what it needs, the band can
   * span an order of magnitude on one input. That is P50/P90 or nothing.
   */
  has_deterministic_formula: z.boolean().default(false),
  adaptive_mode_available: z.boolean().default(false),
});

/* ─────────────────────── inferred types ───────────────────────
 * Companions for the schemas above that were defined without one. Every schema in
 * this package should export both: a consumer that can only import the value has to
 * write `z.infer<typeof X>` at its own use sites, which is the same shape spelled
 * out in two places and one edit away from disagreeing.
 */
export type Currency = z.infer<typeof Currency>;
export type ImagePricingDimension = z.infer<typeof ImagePricingDimension>;
export type ServerToolFee = z.infer<typeof ServerToolFee>;
export type ServiceTierProfile = z.infer<typeof ServiceTierProfile>;
export type VideoGenProfile = z.infer<typeof VideoGenProfile>;
export type VideoInputProfile = z.infer<typeof VideoInputProfile>;
