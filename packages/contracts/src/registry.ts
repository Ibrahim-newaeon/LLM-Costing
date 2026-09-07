// /packages/contracts/src/registry.ts
//
// CANONICAL model row. Replaces registry.schema.ts and Annex A15 §11 — delete both
// rather than syncing them; two sources of truth is how this drift happened.
//
// /schemas/*.json are GENERATED from this file by scripts/generate-schemas.ts and
// CI fails on drift (§A2). Do not hand-edit the JSON.

import { z } from 'zod';
import { sourced, Provenance, Confidence, minConfidence } from './provenance';
import { VisionProfile } from './vision';
import {
  TextRateProfile,
  ImageGenProfile,
  VideoGenProfile,
  VideoInputProfile,
  ServiceTierProfile,
  Currency,
} from './pricing';

export const Modality = z.enum(['text', 'code', 'image', 'video', 'audio', 'embedding']);
export const Tier = z.enum(['FRONTIER', 'MID', 'LIGHTWEIGHT']);
export const TokenizerAvailability = z.enum(['LOCAL_EXACT', 'REMOTE_API', 'PROXY', 'NONE']);

/* ─────────────────────── tokenizer ─────────────────────── */

export const TokenizerProfile = z
  .object({
    availability: TokenizerAvailability,
    identifier: z.string().nullable(),
    /** §A4.1 vendoring rule — pin by revision hash at build; a silent bump is a silent invoice. */
    revision_hash: z.string().nullable(),
    /**
     * §A4.5.3 — a proxy must match the SCRIPT, not just the architecture. Proxying
     * a Chinese model to a Western-trained vocabulary is wrong in a CONSISTENT
     * direction, which makes it look stable and keeps it from being noticed.
     */
    proxy_for: z.string().nullable().default(null),
    proxy_basis: z
      .enum(['SCRIPT_AND_ARCHITECTURE_MATCH', 'ARCHITECTURE_ONLY', 'UNVALIDATED'])
      .nullable()
      .default(null),
    /** From Tier-1 drift capture. Null = unvalidated ⇒ LOW. */
    measured_delta_pct: z.number().nullable().default(null),
    /** Calibrated, never published. A vendor's "~30%" is not a number you bill against. */
    tokenizer_multiplier: sourced(z.number().positive()),
    framing_tokens_per_message: sourced(z.number().int().nonnegative()),
    conversation_preamble_tokens: sourced(z.number().int().nonnegative()),
  })
  .refine((t) => t.availability !== 'PROXY' || t.proxy_for !== null, {
    message: 'A PROXY tokenizer must declare proxy_for — the UI has to say what stood in for what.',
    path: ['proxy_for'],
  });

/* ─────────────────────── hardware / self-hosting ─────────────────────── */

export const HardwareProfile = z.object({
  /** §A5.9 — MoE weights use TOTAL params. Active params understate VRAM badly. */
  params_b_total: z.number().positive().nullable(),
  params_b_active: z.number().positive().nullable(),
  is_moe: z.boolean().default(false),
  layers: z.number().int().positive().nullable(),
  /** ⚠️ KV heads, NOT attention heads. Under GQA the query count can overstate KV ~7×. */
  kv_heads: z.number().int().positive().nullable(),
  attention_heads: z.number().int().positive().nullable(),
  head_dim: z.number().int().positive().nullable(),
  max_context_tokens: z.number().int().positive().nullable(),
  /** KV can be quantised independently of weights — the one real KV reduction. */
  kv_dtype: z.enum(['bf16', 'fp16', 'fp8', 'int8']).nullable().default(null),
  weight_dtype: z.enum(['bf16', 'fp16', 'fp8', 'int8', 'int4']).nullable().default(null),
  /**
   * ⚠️ Affects ACTIVATIONS, not kv_cache. Named here deliberately far from the KV
   * fields so the next person to touch this does not wire it to the wrong term.
   */
  supports_flash_attention: z.boolean().default(false),
  supports_paged_attention: z.boolean().default(false),
  image_activation_buffer_gb: sourced(z.number().positive()),
  /** §A5.9.1 — the dominant term on document VLM work, unlike chat. */
  prefill_throughput_tps: sourced(z.number().positive()),
  decode_throughput_tps: sourced(z.number().positive()),
  ttft_seconds: sourced(z.number().nonnegative()),
  architecture_source_url: z.string().url().nullable(),
});

/* ─────────────────────── compliance (§A6, §A5.10) ─────────────────────── */

export const ComplianceProfile = z.object({
  data_residency_region: z.array(z.string()).min(1),
  is_prc_hosted: z.boolean(),
  contractual_dpa_available: z.boolean(),
  /**
   * §A5.10 — regional endpoints carry an uplift on ALL categories, cache included.
   * Binds directly on Gulf routing: the compliant option is not the same price as
   * the default, and filtering on residency without applying this understates it.
   */
  residency_uplift_pct: sourced(z.number().min(0).max(1)),
  notes: z.string().nullable().default(null),
});

/* ─────────────────────── the model row ─────────────────────── */

export const ModelRow = z
  .object({
    model_id: z.string().min(1),
    display_name: z.string().min(1),
    provider: z.string().min(1),
    provider_origin: z.enum(['US', 'EU', 'CN', 'OTHER']),
    tier: Tier,

    /**
     * §A5.10 — 'subscription' makes the model NON-COMPARABLE in the router rather
     * than assigned a synthesized per-unit price. Averaging a monthly fee into a
     * per-image figure is exactly the invented number §A3 exists to prevent.
     */
    pricing_model: z.enum(['usage', 'subscription', 'hybrid']),

    modalities_in: z.array(Modality).min(1),
    modalities_out: z.array(Modality).min(1),

    context_window: sourced(z.number().int().positive()),
    max_output: sourced(z.number().int().positive()),

    is_reasoning_model: z.boolean(),
    supports_tools: z.boolean(),
    supports_caching: z.boolean(),
    supports_vision: z.boolean(),

    open_weights: z.boolean(),
    license: z.string().nullable(),
    /**
     * §A5.9.1 — a provider serving a model at FP8/INT4 is not serving the same
     * artifact as one serving it at BF16, even under the same model name. A price
     * comparison that ignores this compares different models.
     */
    served_quantization: z.enum(['bf16', 'fp16', 'fp8', 'int8', 'int4', 'unknown']).default('unknown'),

    tokenizer: TokenizerProfile,
    text_rates: z.array(TextRateProfile).default([]),
    service_tiers: z.array(ServiceTierProfile).default([]),
    vision: VisionProfile.nullable().default(null),
    image_gen: ImageGenProfile.nullable().default(null),
    video_gen: VideoGenProfile.nullable().default(null),
    video_in: VideoInputProfile.nullable().default(null),
    hardware: HardwareProfile.nullable().default(null),
    compliance: ComplianceProfile,

    /** §A6 — do NOT invent benchmark scores. Null unless sourced. */
    quality_score: z.number().nullable().default(null),
    quality_score_source_url: z.string().url().nullable().default(null),

    effective_from: z.string().datetime(),
    effective_to: z.string().datetime().nullable(),
    deprecation_date: z.string().datetime().nullable().default(null),
  })
  .superRefine((m, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // A vision-capable row needs a geometry. UNAVAILABLE is a legal geometry —
    // that is the point. What is illegal is claiming vision with no profile.
    if (m.supports_vision && m.vision === null) {
      err('supports_vision=true requires a vision profile (§A5.2).', ['vision']);
    }
    if (m.modalities_in.includes('image') && m.vision === null) {
      err('An image-accepting model requires a vision profile (§A5.2).', ['vision']);
    }
    if (m.modalities_out.includes('image') && m.image_gen === null) {
      err('Image output requires an image_gen profile — never fall back to per_token (§A7).', ['image_gen']);
    }
    if (m.modalities_out.includes('video') && m.video_gen === null) {
      err('Video output requires a video_gen profile (may be empty/UNAVAILABLE) (§A5.3).', ['video_gen']);
    }
    if (m.quality_score !== null && m.quality_score_source_url === null) {
      err('A quality score without a source URL is an invented benchmark (§A6).', ['quality_score_source_url']);
    }

    // §A5.9 feasibility gate needs architecture. Missing ⇒ UNAVAILABLE, not a guess.
    if (m.open_weights) {
      const h = m.hardware;
      if (!h || h.layers === null || h.kv_heads === null || h.head_dim === null) {
        err(
          'Open-weight models need layers, kv_heads and head_dim for the VRAM gate (§A5.9). Missing ⇒ UNAVAILABLE, not a guess.',
          ['hardware'],
        );
      }
      if (h?.is_moe && h.params_b_total === null) {
        err('An MoE row must carry params_b_total — every expert stays resident (§A5.9).', ['hardware', 'params_b_total']);
      }
    }

    // §A5.10 — a subscription model must not carry a per-unit rate that a router
    // could pick up and rank on.
    if (m.pricing_model === 'subscription' && m.text_rates.length > 0) {
      err(
        'A subscription model must not carry per-unit text rates — it is non-comparable, not cheaply priced (§A5.10).',
        ['text_rates'],
      );
    }
  });
export type ModelRow = z.infer<typeof ModelRow>;

export const Registry = z.object({
  schema_version: z.literal('2.0.0'),
  generated_at: z.string().datetime(),
  models: z.array(ModelRow),
});
export type Registry = z.infer<typeof Registry>;

/* ─────────────────────── ranking eligibility ─────────────────────── */

export type Ineligibility =
  | 'SUBSCRIPTION_NON_COMPARABLE'
  | 'VISION_GEOMETRY_UNAVAILABLE'
  | 'NO_USABLE_RATE'
  | 'TOKENIZER_UNAVAILABLE';

/**
 * §A3.7 + §A6 — what the router may rank. Separate from the capability gate:
 * this answers "can this row produce a number at all", before residency,
 * modality or context are considered.
 */
export function rankingEligibility(m: ModelRow): {
  eligible: boolean;
  reasons: Ineligibility[];
  ceiling: Confidence;
} {
  const reasons: Ineligibility[] = [];
  const confidences: Confidence[] = [];

  if (m.pricing_model === 'subscription') reasons.push('SUBSCRIPTION_NON_COMPARABLE');
  if (m.text_rates.length === 0 && m.image_gen === null && m.video_gen === null) {
    reasons.push('NO_USABLE_RATE');
  }
  if (m.vision?.geometry.geometry === 'UNAVAILABLE') reasons.push('VISION_GEOMETRY_UNAVAILABLE');
  if (m.tokenizer.availability === 'NONE') reasons.push('TOKENIZER_UNAVAILABLE');

  if (m.tokenizer.availability === 'PROXY') confidences.push('LOW');
  if (m.vision) confidences.push(m.vision.provenance.confidence);
  for (const r of m.text_rates) confidences.push(r.output_rate.provenance.confidence);

  return {
    eligible: reasons.length === 0,
    reasons,
    ceiling: confidences.length ? minConfidence(...confidences) : 'NONE',
  };
}
