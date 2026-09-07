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
      'per_1m_tokens_per_hour', // §A5.10 cache storage
      'per_gpu_hour',
    ]),
    list_currency: Currency.default('USD'),
    fx_rate_used: z.number().positive().nullable().default(null),
    fx_rate_date: z.string().datetime().nullable().default(null),
    fx_source_url: z.string().url().nullable().default(null),
    effective_from: z.string().datetime(),
    effective_to: z.string().datetime().nullable(),
    /** §14.9 — peak/off-peak exists in the market; a single amount cannot express it. */
    time_of_day_variant: z.enum(['all_hours', 'peak', 'offpeak']).default('all_hours'),
    provenance: Provenance,
  })
  .refine(
    (r) => r.list_currency === 'USD' || (r.fx_rate_used !== null && r.fx_rate_date !== null),
    { message: 'A non-USD list price requires fx_rate_used + fx_rate_date (§A4.2).', path: ['fx_rate_used'] },
  );
export type Rate = z.infer<typeof Rate>;

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
