// /packages/contracts/src/instance.ts
//
// The machine you rent, and the plan you run on it.
//
// ── Why this file exists, stated plainly ──────────────────────────────────────
//
// PR #3 deleted /schemas/pricing-record.schema.json with the note that its payload
// "duplicated TextRateProfile, ContextTier, CacheProfile, VisionProfile and
// HardwareProfile". That claim was too strong, and pricing.ts repeated it. The
// record's `self_hosted_profile` block had two halves:
//
//   measured_ttft_seconds, measured_prefill_tps, measured_decode_tps,
//   benchmark_source_url, benchmark_batch_size   → DID duplicate HardwareProfile
//
//   instance_type, cloud_provider, gpu_model, gpu_count, vram_per_gpu_gb,
//   hourly_rate_on_demand, hourly_rate_spot, regional_tax_rate, storage_monthly,
//   egress_per_gb, concurrency_efficiency_factor
//                                                → had NO counterpart anywhere
//
// The second half was lost, not superseded. §A5.9 cannot be implemented without it:
// HardwareProfile answers "how fast does this model run and how much memory does it
// need", and nothing answered "on what, for how much". This file is that half,
// restored deliberately rather than by reviving the record type — the separation is
// the point. A model row describes a model; an instance row describes a rented
// machine; one model runs on many instances and one instance serves many models.
// Folding them together is what made the old record duplicate four other shapes.
//
// Spec anchors: §A5.9 (self-hosted cost formula, the VRAM gate, the four errors) ·
// §A5.9.1 (the VLM chain) · §A4.2 (native currency) · §A3.1 (nothing unsourced)

import { z } from 'zod';
import { sourced } from './provenance';
import { Rate } from './pricing';

/* ─────────────────────────── rate basis ─────────────────────────── */

/**
 * Which price you are being charged.
 *
 * Stored, never blended. Spot and on-demand are not two quotes for one thing —
 * they are different risk products, and averaging them produces a number that
 * describes no purchasable arrangement. `estimate.ts` imports this rather than
 * declaring its own copy.
 */
export const RateBasis = z.enum(['ON_DEMAND', 'SPOT']);
export type RateBasis = z.infer<typeof RateBasis>;

/* ─────────────────────────── the rented machine ─────────────────────────── */

/**
 * A specific instance type, in a specific region, at a specific price.
 *
 * Nothing here is a model fact. Everything here goes stale — hourly rates move,
 * regions get repriced, tax rates change — which is why every money field is a
 * `Rate` and inherits the staleness gate rather than being a bare number.
 */
export const InstanceProfile = z
  .object({
    instance_id: z.string().min(1),
    cloud_provider: z.string().min(1),
    instance_type: z.string().min(1),
    /** Rates differ by region by more than the tax does. Null = not region-scoped. */
    region: z.string().min(1).nullable().default(null),

    gpu_model: z.string().min(1),
    gpu_count: z.number().int().positive(),

    /**
     * VRAM per GPU in **GiB (2^30 bytes), as the runtime reports it** — i.e.
     * `nvidia-smi` total ÷ 1024 — NOT the marketing figure on the spec sheet.
     *
     * The two differ in the direction that matters: a card sold as "80GB" reports
     * roughly 79.6 GiB. Recording 80 here hands the feasibility gate memory the
     * machine does not have, and a gate that is optimistic fails as an
     * out-of-memory crash under load rather than as a wrong number on a screen.
     */
    vram_per_gpu_gib: z.number().positive(),

    /**
     * ⚠️ §A5.9 error 4. This caps the engine's **total** footprint — weights plus
     * KV cache plus activations, together — and the remainder covers CUDA context
     * and fragmentation. It is NOT a reserve earmarked for the KV cache, and it is
     * NOT a fraction applied to weights alone.
     *
     * Read as: available_bytes = gpu_count × vram_per_gpu_gib × this. Everything the
     * engine holds is compared against that one figure. (§A5.9 writes the same lever
     * as `usable_fraction` in the feasibility formula; it is this field.)
     */
    gpu_memory_utilization: z.number().gt(0).max(1),

    /**
     * The two prices, stored side by side and never merged.
     *
     * The `unit` on each Rate carries the per-GPU / per-instance distinction —
     * `per_gpu_hour` or `per_instance_hour`. That is deliberately not a separate
     * field: a second field could disagree with the unit, and on an 8-GPU box the
     * disagreement is an 8× error in the direction that makes self-hosting look
     * cheap. Use `instanceHourlyAmount()` rather than reading `.amount` by hand.
     */
    hourly_rate_on_demand: Rate.nullable().default(null),
    hourly_rate_spot: Rate.nullable().default(null),

    /** §A5.9 — applied to the compute line. Not folded into the hourly rate. */
    regional_tax_rate: sourced(z.number().min(0).max(1)),

    /**
     * Weights have to live somewhere between runs.
     *
     * Named `storage_rate`, not `storage_monthly`, because the PERIOD lives on the
     * Rate's `unit` and a name that also claims a period is a second place for it to
     * be wrong. Required unit: `per_gb_day`.
     */
    storage_rate: Rate.nullable().default(null),
    weights_storage_gb: z.number().positive().nullable().default(null),

    /** Required unit: `per_gb`. Egress is volume-metered with no period. */
    egress_rate: Rate.nullable().default(null),
    /** Null = unmeasured. Absent this, the egress line is UNAVAILABLE, not zero. */
    egress_gb_per_1k_requests: sourced(z.number().nonnegative()),

    /**
     * §A5.9 — the divisor on `request_seconds`.
     *
     * MEASURED under load on this instance type, or it is an assumption and must be
     * carried as one. A serving engine batching well runs many requests in less than
     * the sum of their solo latencies; how much less is a property of the engine, the
     * batch size and the workload shape, and no published figure transfers.
     */
    concurrency_efficiency_factor: sourced(z.number().gt(0).max(1)),
    /** The batch size the throughput and efficiency figures were measured at. */
    benchmark_batch_size: z.number().int().positive().nullable().default(null),

    /** Scale-to-zero only: GPU seconds billed before the first token after an idle gap. */
    cold_start_seconds: sourced(z.number().nonnegative()),

    /**
     * §A5.9 — "an ops-labour line item (a flat, user-editable monthly figure —
     * labelled as an assumption, since it is one)". `sourced()` is what labels it:
     * a figure typed in by an operator arrives as USER_ENTERED and carries their
     * name; a figure nobody supplied stays null and the line reports UNAVAILABLE.
     * There is no house default, because there is no honest one.
     */
    ops_labour_monthly: sourced(z.number().nonnegative()),

    instance_source_url: z.string().url().nullable(),
  })
  .superRefine((i, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    if (i.hourly_rate_on_demand === null && i.hourly_rate_spot === null) {
      err(
        'An instance with neither an on-demand nor a spot rate cannot be costed at all (§A3.2).',
        ['hourly_rate_on_demand'],
      );
    }
    // The unit is load-bearing: it decides whether the amount is multiplied by
    // gpu_count. Any other unit on an instance rate is a category error, and a
    // per_1m_tokens rate landing here would price GPU hours as tokens.
    const hourly = new Set(['per_gpu_hour', 'per_instance_hour']);
    if (i.hourly_rate_on_demand && !hourly.has(i.hourly_rate_on_demand.unit)) {
      err('An instance hourly rate must be per_gpu_hour or per_instance_hour.', [
        'hourly_rate_on_demand',
        'unit',
      ]);
    }
    if (i.hourly_rate_spot && !hourly.has(i.hourly_rate_spot.unit)) {
      err('An instance hourly rate must be per_gpu_hour or per_instance_hour.', [
        'hourly_rate_spot',
        'unit',
      ]);
    }
    // A rate with nothing to multiply it by is the mirror of rule 2's failure mode.
    if (i.storage_rate !== null && i.weights_storage_gb === null) {
      err('A storage rate needs weights_storage_gb, or there is nothing to multiply it by.', [
        'weights_storage_gb',
      ]);
    }
    // The unit is how the period and the basis are carried, so a wrong one is not a
    // labelling slip — it silently reinterprets the amount.
    if (i.storage_rate !== null && i.storage_rate.unit !== 'per_gb_day') {
      err('storage_rate must be per_gb_day; the period belongs to the unit.', ['storage_rate', 'unit']);
    }
    if (i.egress_rate !== null && i.egress_rate.unit !== 'per_gb') {
      err('egress_rate must be per_gb.', ['egress_rate', 'unit']);
    }
  });
export type InstanceProfile = z.infer<typeof InstanceProfile>;

/**
 * The hourly amount for the WHOLE instance, in the rate's own currency.
 *
 * Exists so that `gpu_count` is applied in exactly one place. Returns null when the
 * requested basis has no rate — the caller must treat that as UNAVAILABLE and not
 * silently fall back to the other basis, which would quote a spot price as though
 * it were guaranteed capacity.
 */
export function instanceHourlyAmount(
  i: InstanceProfile,
  basis: RateBasis,
): { amount: number; rate: Rate } | null {
  const rate = basis === 'SPOT' ? i.hourly_rate_spot : i.hourly_rate_on_demand;
  if (rate === null) return null;
  const amount = rate.unit === 'per_gpu_hour' ? rate.amount * i.gpu_count : rate.amount;
  return { amount, rate };
}

export const BYTES_PER_GIB = 1024 ** 3;

/**
 * Total VRAM the serving engine may occupy, in bytes.
 *
 * §A5.9 error 4 lives here and nowhere else: one figure, covering weights + KV +
 * activations together. Anything that wants to know "is there room" compares
 * against this, so there is no second place to get the semantics wrong.
 */
export function availableVramBytes(i: InstanceProfile): number {
  return i.gpu_count * i.vram_per_gpu_gib * BYTES_PER_GIB * i.gpu_memory_utilization;
}

/* ─────────────────────────── the plan you run ─────────────────────────── */

/**
 * §A5.9 — "Force the user to state `expected_requests_per_day` and
 * `utilization_factor`."
 *
 * Utilization is the honest lever: a GPU billed around the clock at 8% busy has a
 * per-token cost orders of magnitude worse than the same GPU saturated, and every
 * self-hosting comparison that flatters itself does so here. So it sits on the plan,
 * where the user can see and change it, rather than buried in a constant.
 *
 * It is nullable because it is DERIVABLE — requests × seconds-per-request ÷ the
 * billed seconds in a day. When the user states it anyway, the estimator compares
 * the two and reports the divergence instead of picking one (rule 5's habit,
 * applied to a quantity rather than a rate).
 */
export const DeploymentPlan = z
  .object({
    instance_id: z.string().min(1),
    rate_basis: RateBasis,
    expected_requests_per_day: z.number().nonnegative(),
    /** Null ⇒ derive it from the workload and label the result an assumption. */
    utilization_factor: z.number().gt(0).max(1).nullable().default(null),
    /**
     * Always-on bills the instance whether or not it serves anything; scale-to-zero
     * trades that for a cold start on every idle gap. They are alternatives, not
     * settings that combine, and a row asserting both describes no deployment.
     */
    always_on: z.boolean().default(true),
    scale_to_zero: z.boolean().default(false),
    /** Idle gaps per day — what scale-to-zero actually pays for in cold starts. */
    cold_starts_per_day: z.number().nonnegative().nullable().default(null),
    /** Serving batch size. Multiplies the KV cache; leave at 1 if unbatched. */
    batch_size: z.number().int().positive().default(1),
    /**
     * The context length the deployment is CONFIGURED for, which sizes the KV cache
     * reservation. Not the model's maximum, and not the average request — a serving
     * engine reserves for what it was told to allow.
     */
    planned_context_tokens: z.number().int().positive(),
  })
  .superRefine((p, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    if (p.always_on === p.scale_to_zero) {
      err(
        'A deployment is either always-on or scale-to-zero. Both or neither describes no deployment.',
        ['scale_to_zero'],
      );
    }
    if (p.scale_to_zero && p.cold_starts_per_day === null) {
      err(
        'Scale-to-zero without a cold-start count hides the cost it trades the idle time for (§A5.9).',
        ['cold_starts_per_day'],
      );
    }
  });
export type DeploymentPlan = z.infer<typeof DeploymentPlan>;
