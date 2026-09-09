// /packages/estimator/src/selfhosted.ts
//
// Self-hosted costing (§A5.9, §A5.9.1). Costing flips from per-token to per-second
// of GPU wall-clock, and the interesting part is not the arithmetic — it is the four
// errors §A5.9 names, each of which is available in a one-line change and none of
// which shows up as a wrong-looking number.
//
// Every one of them is guarded here by a TYPE or a control-flow path, not by a
// comment, because a comment is what the last four implementations had:
//
//   1. kv_heads, not attention heads.   `KvGeometry` has no `attention_heads` member,
//      and `kvGeometryFrom()` is the only way to build one from a HardwareProfile.
//      A caller who wants to pass the query count has to add a field to do it.
//
//   2. MoE weights use TOTAL params.    `weightsBytes()` reads `params_b_active` only
//      when `is_moe === false`, where the two are equal by definition. An MoE row
//      missing `params_b_total` returns UNAVAILABLE rather than falling back.
//
//   3. FlashAttention does NOT reduce   `supports_flash_attention` is never read in
//      the KV cache.                    this file. It cannot be: `KvGeometry` does
//                                       not carry it. It belongs to activations.
//
//   4. gpu_memory_utilization caps the  There is one available-VRAM figure, computed
//      TOTAL footprint.                 by `availableVramBytes()` in the contracts,
//                                       and all three terms are compared against it
//                                       together. No term gets its own budget.
//
// The gate has THREE states, not two. A deployment whose activation buffer has never
// been measured has a required-VRAM LOWER BOUND, and a lower bound that fits proves
// nothing. Reporting that as FEASIBLE is how a sizing table becomes an out-of-memory
// crash under load, so it reports INDETERMINATE and says which field would settle it.

import {
  availableVramBytes,
  BYTES_PER_GIB,
  instanceHourlyAmount,
  type DeploymentPlan,
  type HardwareProfile,
  type InstanceProfile,
  type Range,
  type RateBasis,
  type EstimateWarning,
} from '@tokenomics/contracts';
import { exactRange } from './range';

/* ─────────────────────────── number formats ─────────────────────────── */

type WeightDtype = NonNullable<HardwareProfile['weight_dtype']>;
type KvDtype = NonNullable<HardwareProfile['kv_dtype']>;

/**
 * Bytes per parameter, by number format.
 *
 * These are NOT rates and rule 1 does not reach them: the width of bf16 is two bytes
 * by the definition of bf16, not by a vendor's pricing decision, and it cannot go
 * stale. Nothing else in this file is a constant.
 *
 * ⚠️ `int4` at 0.5 is the payload only. Every practical 4-bit scheme also stores
 * per-group scales and zero-points, so a real int4 checkpoint occupies noticeably
 * more than half a byte per parameter — commonly cited around 4.5–5 effective bits,
 * but that is scheme-specific and this file does not know the scheme. The weights
 * figure for a sub-byte dtype is therefore a LOWER BOUND, and it is returned marked
 * as one rather than quietly used as if it were exact.
 */
const BYTES_PER_PARAM: Readonly<Record<WeightDtype, number>> = {
  bf16: 2,
  fp16: 2,
  fp8: 1,
  int8: 1,
  int4: 0.5,
};

const SUB_BYTE: ReadonlySet<WeightDtype> = new Set<WeightDtype>(['int4']);

const KV_BYTES_PER_ELEMENT: Readonly<Record<KvDtype, number>> = {
  bf16: 2,
  fp16: 2,
  fp8: 1,
  int8: 1,
};

/* ─────────────────────────── KV cache geometry ─────────────────────────── */

/**
 * Everything the KV term needs and NOTHING it does not.
 *
 * §A5.9 error 1 and error 3 are both closed by this type's field list. There is no
 * `attention_heads` here, so the ~7× GQA overstatement cannot be typed; there is no
 * `supports_flash_attention`, so the term that FlashAttention does not affect cannot
 * be wired to it. Widening this interface reopens both.
 */
export interface KvGeometry {
  layers: number;
  /** ⚠️ KV heads. Under GQA this is a small fraction of the query-head count. */
  kv_heads: number;
  head_dim: number;
  kv_dtype: KvDtype;
}

export type KvGeometryResult =
  | { status: 'OK'; geometry: KvGeometry }
  | { status: 'UNAVAILABLE'; missing: string[] };

/**
 * The only supported route from a model row into the KV arithmetic.
 *
 * Refuses rather than defaulting. §A5.9: "All model-architecture fields come from
 * the model card (config.json), stored in DB. If a field is missing → UNAVAILABLE,
 * not a guess." A guessed head count is not a slightly worse estimate — it is a
 * confident answer to a question nobody asked the model card.
 */
export function kvGeometryFrom(h: HardwareProfile): KvGeometryResult {
  const missing: string[] = [];
  if (h.layers === null) missing.push('layers');
  if (h.kv_heads === null) missing.push('kv_heads');
  if (h.head_dim === null) missing.push('head_dim');
  if (h.kv_dtype === null) missing.push('kv_dtype');
  if (missing.length > 0) return { status: 'UNAVAILABLE', missing };
  return {
    status: 'OK',
    geometry: {
      layers: h.layers!,
      kv_heads: h.kv_heads!,
      head_dim: h.head_dim!,
      kv_dtype: h.kv_dtype!,
    },
  };
}

/**
 * KV cache bytes.
 *
 *   2 (K and V) x layers x kv_heads x head_dim x bytes(kv_dtype) x tokens x batch
 *
 * `tokens` is clamped by the caller via `clampedContextTokens()` — §A5.9.1 requires
 * MIN(tokens, max_context), because a model cannot hold more than it can hold and an
 * unclamped figure reports a memory requirement the deployment would never reach.
 *
 * There is no rule of thumb in here on purpose. §A5.9: "GB per 32k tokens figures
 * are model-specific... Compute the term; never carry the constant across model
 * sizes." A deep model with few KV heads and a shallow one with many differ by an
 * order of magnitude at the same context length, and nothing in a parameter count
 * predicts which you have.
 */
export function kvCacheBytes(g: KvGeometry, tokens: number, batchSize: number): number {
  return (
    2 * g.layers * g.kv_heads * g.head_dim * KV_BYTES_PER_ELEMENT[g.kv_dtype] * tokens * batchSize
  );
}

/**
 * §A5.9.1 — the clamp, and the capability signal that comes with it.
 *
 * The annex records a VLM whose maximum context is small enough that a single
 * ordinary-resolution image consumes roughly half of it. That is a capability limit
 * wearing a cost limit's clothes: the KV cache clamps to a reassuringly small number
 * precisely when the request does not fit, which is exactly backwards. So the clamp
 * reports whether it bit, and the caller must treat that as CONTEXT_TOO_SMALL rather
 * than as a memory saving.
 */
export function clampedContextTokens(
  requestedTokens: number,
  maxContextTokens: number | null,
): { tokens: number; clamped: boolean; share_of_context: number | null } {
  if (maxContextTokens === null) {
    return { tokens: requestedTokens, clamped: false, share_of_context: null };
  }
  const clamped = requestedTokens > maxContextTokens;
  return {
    tokens: clamped ? maxContextTokens : requestedTokens,
    clamped,
    share_of_context: requestedTokens / maxContextTokens,
  };
}

/* ─────────────────────────── weights ─────────────────────────── */

export type WeightsResult =
  | { status: 'OK'; bytes: number; is_lower_bound: boolean; note: string | null }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * §A5.9 error 2. Every expert stays resident in VRAM; only THROUGHPUT reflects the
 * active subset. Sizing an MoE model on active params understates weight VRAM by
 * roughly the expert ratio, and the understatement is silent — the model loads fine
 * on paper and OOMs on the machine.
 *
 * `params_b_active` is read only where `is_moe === false`, i.e. where it equals the
 * total by definition. There is deliberately no path from an MoE row's active count
 * into this function's return value.
 */
export function weightsBytes(h: HardwareProfile): WeightsResult {
  if (h.weight_dtype === null) {
    return { status: 'UNAVAILABLE', reason: 'weight_dtype is unset — bytes per parameter is unknown.' };
  }
  let paramsB: number | null = h.params_b_total;
  if (paramsB === null) {
    if (h.is_moe) {
      return {
        status: 'UNAVAILABLE',
        reason:
          'An MoE model requires params_b_total — every expert stays resident, so active params understate weight VRAM by the expert ratio (§A5.9).',
      };
    }
    paramsB = h.params_b_active;
  }
  if (paramsB === null) {
    return { status: 'UNAVAILABLE', reason: 'No parameter count on the model row.' };
  }

  const perParam = BYTES_PER_PARAM[h.weight_dtype];
  const subByte = SUB_BYTE.has(h.weight_dtype);
  return {
    status: 'OK',
    bytes: paramsB * 1e9 * perParam,
    is_lower_bound: subByte,
    note: subByte
      ? `${h.weight_dtype} counts the payload only; group scales and zero-points are scheme-specific and not included, so this is a lower bound.`
      : null,
  };
}

/* ─────────────────────────── the feasibility gate ─────────────────────────── */

/**
 * ⚠️ UNIT BASES DIFFER BY FIELD, AND THAT IS DELIBERATE.
 *
 * `InstanceProfile.vram_per_gpu_gib` is GiB (2^30) because that is what the runtime
 * reports. `HardwareProfile.image_activation_buffer_gb` is GB (10^9) because SPEC
 * §A5.9.1 names the field that way and the spec is canonical for field names.
 *
 * Rather than reinterpret either — a 7.4% silent error at the exact point where the
 * answer is "does it fit" — every quantity is converted to BYTES at its own boundary
 * and only bytes are ever compared. Nothing in this module holds a GB or a GiB.
 */
const BYTES_PER_GB = 1e9;

export type VramVerdict = 'FEASIBLE' | 'INFEASIBLE' | 'INDETERMINATE';

export interface VramFeasibility {
  /**
   * INDETERMINATE is not a softer INFEASIBLE. It means the required figure is a
   * lower bound that happens to fit, which proves nothing — the unmeasured term
   * could be any size. `missing` says which field would settle it.
   */
  verdict: VramVerdict;
  required_bytes: number | null;
  /** True when a term was omitted or under-counted, so `required_bytes` is a floor. */
  required_is_lower_bound: boolean;
  available_bytes: number;
  weights_bytes: number | null;
  kv_cache_bytes: number | null;
  activation_bytes: number | null;
  /** §A5.9.1 — the clamp bit. True means the request does not fit the context at all. */
  context_clamped: boolean;
  /** Visual tokens as a fraction of max_context. Null when max_context is unknown. */
  image_share_of_context: number | null;
  missing: string[];
  notes: string[];
  warnings: EstimateWarning[];
}

export interface VramInput {
  hardware: HardwareProfile;
  instance: InstanceProfile;
  plan: DeploymentPlan;
  /** §A5.9.1 — visual tokens land in the SAME context as text and the same KV cache. */
  visual_tokens?: number;
}

/**
 * §A5.9's feasibility gate. Refuses to cost a deployment that cannot physically run.
 *
 *   required = weights + kv_cache + activations
 *   available = gpu_count x vram_per_gpu x gpu_memory_utilization        (error 4)
 *
 * The context sized here is the PLANNED one plus any visual tokens, not the model's
 * maximum — a serving engine reserves for what it was configured to allow. §A5.9.1's
 * clamp then caps that at `max_context_tokens`, and reports when it bit.
 */
export function vramFeasibility(input: VramInput): VramFeasibility {
  const { hardware, instance, plan } = input;
  const visual = input.visual_tokens ?? 0;
  const missing: string[] = [];
  const notes: string[] = [];

  const available = availableVramBytes(instance);

  const w = weightsBytes(hardware);
  const weights = w.status === 'OK' ? w.bytes : null;
  if (w.status === 'UNAVAILABLE') missing.push(`weights (${w.reason})`);
  if (w.status === 'OK' && w.note !== null) notes.push(w.note);

  const clamp = clampedContextTokens(
    plan.planned_context_tokens + visual,
    hardware.max_context_tokens,
  );
  if (clamp.clamped) {
    notes.push(
      'Planned context plus visual tokens exceeds the model maximum. The KV figure is clamped to what the model can hold, which makes it SMALLER — treat this as CONTEXT_TOO_SMALL, not as a memory saving (§A5.9.1).',
    );
  }

  const g = kvGeometryFrom(hardware);
  const kv =
    g.status === 'OK' ? kvCacheBytes(g.geometry, clamp.tokens, plan.batch_size) : null;
  if (g.status === 'UNAVAILABLE') missing.push(`kv_cache (${g.missing.join(', ')})`);

  // §A5.9 error 3 in negative space: `supports_flash_attention` belongs to THIS term
  // and only this one. It reduces the materialized attention matrix, not the cache.
  const activationGb = hardware.image_activation_buffer_gb.value;
  const activation = activationGb === null ? null : activationGb * BYTES_PER_GB;
  if (activation === null) {
    missing.push('image_activation_buffer_gb');
    notes.push(
      'The activation buffer has never been measured on a real deployment, so the requirement below is a lower bound and cannot support a FEASIBLE verdict.',
    );
  }

  const known = [weights, kv, activation].filter((x): x is number => x !== null);
  const required = known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
  const isLowerBound = activation === null || (w.status === 'OK' && w.is_lower_bound);

  // A weights or KV term we could not compute at all is not a lower bound — it is no
  // figure. Those cases fall through to INDETERMINATE via `missing`.
  const termsComplete = weights !== null && kv !== null;

  let verdict: VramVerdict;
  if (required === null || !termsComplete) {
    verdict = 'INDETERMINATE';
  } else if (required > available) {
    // A floor that already exceeds the budget settles it: adding the unmeasured
    // terms can only make it worse. This is the one direction a lower bound decides.
    verdict = 'INFEASIBLE';
  } else if (isLowerBound) {
    verdict = 'INDETERMINATE';
  } else {
    verdict = 'FEASIBLE';
  }

  const imageShare =
    hardware.max_context_tokens === null ? null : visual / hardware.max_context_tokens;

  // One of the eighteen §A11 found: the number was already computed and reported,
  // and nothing said it mattered. A context window mostly filled with image tokens
  // is a capability limit wearing a cost limit for cover — the text you meant to
  // send does not fit, and the bill does not show you why.
  const warnings: EstimateWarning[] = [];
  if (imageShare !== null && imageShare >= VISUAL_CONTEXT_DOMINANCE_THRESHOLD) {
    warnings.push({
      code: 'VISUAL_TOKENS_DOMINATE_CONTEXT',
      message: `Images occupy ${(imageShare * 100).toFixed(0)}% of the ${hardware.max_context_tokens}-token context. What is left is the room the prompt actually has.`,
      severity: 'WARN',
    });
  }

  return {
    verdict,
    required_bytes: required,
    required_is_lower_bound: isLowerBound,
    available_bytes: available,
    weights_bytes: weights,
    kv_cache_bytes: kv,
    activation_bytes: activation,
    context_clamped: clamp.clamped,
    image_share_of_context: imageShare,
    missing,
    notes,
    warnings,
  };
}

export const bytesToGib = (b: number): number => b / BYTES_PER_GIB;

/* ─────────────────────────── request timing ─────────────────────────── */

export interface Throughput {
  prefill_tps: number;
  decode_tps: number;
  /**
   * ⚠️ CONVENTION. §A5.9 writes `request_seconds = ttft + prefill + decode`, which
   * treats this as the latency BEFORE prefill begins — queueing, scheduling, the
   * first forward pass setup. The industry's published "time to first token" figure
   * usually INCLUDES prefill, and a row populated from such a benchmark will
   * double-count the prefill term. The spec's formula is implemented as written;
   * this note is the warning that the field has to be populated to match it.
   */
  ttft_seconds: number;
  concurrency_efficiency_factor: number;
}

export type ThroughputResult =
  | { status: 'OK'; throughput: Throughput }
  | { status: 'UNAVAILABLE'; missing: string[] };

/**
 * Pulls the four timing figures off the model row and the instance, refusing when
 * any is unmeasured.
 *
 * §A5.9.1: "for document VLM sizing the bottleneck is prefill_throughput_tps, not
 * decode_throughput_tps". So a missing prefill figure is a refusal — substituting
 * the decode figure would produce a confident number for the term that dominates.
 */
export function throughputFrom(h: HardwareProfile, i: InstanceProfile): ThroughputResult {
  const missing: string[] = [];
  if (h.prefill_throughput_tps.value === null) missing.push('prefill_throughput_tps');
  if (h.decode_throughput_tps.value === null) missing.push('decode_throughput_tps');
  if (h.ttft_seconds.value === null) missing.push('ttft_seconds');
  if (i.concurrency_efficiency_factor.value === null) missing.push('concurrency_efficiency_factor');
  if (missing.length > 0) return { status: 'UNAVAILABLE', missing };
  return {
    status: 'OK',
    throughput: {
      prefill_tps: h.prefill_throughput_tps.value!,
      decode_tps: h.decode_throughput_tps.value!,
      ttft_seconds: h.ttft_seconds.value!,
      concurrency_efficiency_factor: i.concurrency_efficiency_factor.value!,
    },
  };
}

export interface RequestTiming {
  request_seconds: Range;
  /** request_seconds / concurrency_efficiency_factor — what the cost is billed on. */
  effective_seconds: Range;
  /**
   * §A5.9.1 — prefill's share of request_seconds at P50. Close to 100% on document
   * VLM work, well under half on chat. It says which throughput figure the estimate
   * is actually sensitive to, and the answer is not the one chat intuition expects.
   */
  prefill_share_pct: number;
}

/**
 *   prefill_seconds   = input_tokens / prefill_tps
 *   decode_seconds    = output_tokens / decode_tps
 *   request_seconds   = ttft + prefill + decode
 *   effective_seconds = request_seconds / concurrency_efficiency_factor
 *
 * P50 and P90 are computed independently from the two token bands, so the width of
 * the timing band inherits the width of the token bands rather than being asserted.
 */
export function requestTiming(
  inputTokens: Range,
  outputTokens: Range,
  t: Throughput,
): RequestTiming {
  const at = (inTok: number, outTok: number) => {
    const prefill = inTok / t.prefill_tps;
    const decode = outTok / t.decode_tps;
    return { prefill, decode, total: t.ttft_seconds + prefill + decode };
  };
  const p50 = at(inputTokens.p50, outputTokens.p50);
  const p90 = at(inputTokens.p90, outputTokens.p90);

  const request_seconds: Range = { p50: p50.total, p90: p90.total, p99: null };
  const effective_seconds: Range = {
    p50: p50.total / t.concurrency_efficiency_factor,
    p90: p90.total / t.concurrency_efficiency_factor,
    p99: null,
  };
  return {
    request_seconds,
    effective_seconds,
    prefill_share_pct: p50.total === 0 ? 0 : (p50.prefill / p50.total) * 100,
  };
}

/* ─────────────────────────── utilization ─────────────────────────── */

const SECONDS_PER_DAY = 86_400;

/**
 * Mean Gregorian month, used to amortize monthly figures to a day.
 *
 * An amortization CONVENTION, not a billing fact — providers variously bill 730
 * hours, 30 days, or the actual calendar month. It sits here as a named export so
 * the choice is visible in one place and can be argued with, rather than appearing
 * as a bare 30 somewhere in an expression.
 */
export const DAYS_PER_MONTH = 30.436875;

/** Beyond this gap between a stated and a derived utilization, report both (rule 5). */
export const UTILIZATION_DIVERGENCE_TOLERANCE = 0.1;

/** Below this, self-hosting is being compared on a GPU that is mostly idle. */
/**
 * The share of a context window above which images are said to DOMINATE it. A
 * reporting threshold, not a published figure: half the window is the point at
 * which the remaining room is the minority of what was bought.
 */
export const VISUAL_CONTEXT_DOMINANCE_THRESHOLD = 0.5;

export const LOW_UTILIZATION_WARN_THRESHOLD = 0.2;

export interface Utilization {
  /** The figure the cost is divided by. Null when it cannot be established. */
  value: number | null;
  derived: number | null;
  stated: number | null;
  is_derived: boolean;
  /** Stated and derived disagree beyond tolerance — report both, never average. */
  diverges: boolean;
  /** The workload needs more than one instance; a single-instance figure is fiction. */
  exceeds_single_instance: boolean;
}

/**
 * §A5.9 — "Force the user to state expected_requests_per_day and utilization_factor."
 *
 * We force the statement and then check it, because utilization is DERIVABLE from
 * the workload: requests x effective_seconds / seconds_in_a_day. Where the user
 * states a figure that the workload does not support, both are reported. Averaging
 * them would be rule 5's failure applied to a quantity, and picking the user's
 * silently would let a comparison be tuned by the person it is meant to inform.
 */
export function resolveUtilization(
  plan: DeploymentPlan,
  effectiveSecondsP50: number,
): Utilization {
  const stated = plan.utilization_factor;
  if (plan.expected_requests_per_day <= 0) {
    return {
      value: stated,
      derived: null,
      stated,
      is_derived: false,
      diverges: false,
      exceeds_single_instance: false,
    };
  }
  const raw = (plan.expected_requests_per_day * effectiveSecondsP50) / SECONDS_PER_DAY;
  const derived = Math.min(1, raw);
  const diverges =
    stated !== null && Math.abs(stated - derived) / derived > UTILIZATION_DIVERGENCE_TOLERANCE;

  return {
    value: stated ?? derived,
    derived,
    stated,
    is_derived: stated === null,
    diverges,
    exceeds_single_instance: raw > 1,
  };
}

/* ─────────────────────────── cost components ─────────────────────────── */

export interface SelfHostedComponent {
  component: 'gpu_seconds' | 'idle_gpu' | 'storage' | 'egress' | 'ops_labour';
  unit: 'seconds' | 'requests';
  quantity: Range;
  /** Per unit, in the instance's own currency, with regional tax already applied. */
  rate_amount: number;
  rate_record_id: string;
  note: string | null;
}

export type SelfHostedCostResult =
  | {
      status: 'OK';
      currency: string;
      components: SelfHostedComponent[];
      utilization: Utilization;
      /** Informational. Already inside the idle_gpu line — do NOT add it again. */
      idle_cost_per_day: number | null;
      instance_daily_amount: number;
      warnings: EstimateWarning[];
      notes: string[];
    }
  | { status: 'UNAVAILABLE'; missing: string[] };

export interface SelfHostedCostInput {
  instance: InstanceProfile;
  plan: DeploymentPlan;
  timing: RequestTiming;
}

/**
 * Per-request cost, decomposed.
 *
 * §A5.9's formula is
 *
 *   SELF_HOSTED_COST = effective_seconds x (hourly/3600) x (1+tax) / utilization
 *
 * and the `/ utilization` is what pays for the idle time. This function returns it
 * as TWO lines that sum to exactly that:
 *
 *   gpu_seconds : effective_seconds                    x rate_per_second
 *   idle_gpu    : effective_seconds x (1/u - 1)        x rate_per_second
 *   ───────────────────────────────────────────────────────────────────
 *   total       : effective_seconds / u                x rate_per_second   ✓
 *
 * ⚠️ The split is presentational, not additional. An implementation that computes
 * the spec formula AND adds a separate always-on charge bills the idle GPU twice,
 * and the result still looks plausible — which is why the decomposition is done here
 * rather than left to a caller. `idle_cost_per_day` is returned for display and is
 * already inside the idle_gpu line.
 *
 * Scale-to-zero takes the other branch: no idle line, because nothing is billed
 * while nothing is served, and instead the cold starts are amortized as real GPU
 * seconds across the day's requests.
 */
export function selfHostedCost(input: SelfHostedCostInput): SelfHostedCostResult {
  const { instance, plan, timing } = input;
  const missing: string[] = [];
  const warnings: EstimateWarning[] = [];
  const notes: string[] = [];

  const hourly = instanceHourlyAmount(instance, plan.rate_basis);
  if (hourly === null) {
    return {
      status: 'UNAVAILABLE',
      missing: [`hourly_rate_${plan.rate_basis === 'SPOT' ? 'spot' : 'on_demand'}`],
    };
  }
  const tax = instance.regional_tax_rate.value;
  if (tax === null) missing.push('regional_tax_rate');
  if (missing.length > 0) return { status: 'UNAVAILABLE', missing };

  const util = resolveUtilization(plan, timing.effective_seconds.p50);

  const taxed = 1 + tax!;
  const perSecond = (hourly.amount / 3600) * taxed;
  const instanceDaily = hourly.amount * 24 * taxed;
  const currency = hourly.rate.list_currency;

  if (plan.rate_basis === 'SPOT') {
    warnings.push({
      code: 'SPOT_RATE_INTERRUPTION_UNMODELLED',
      message:
        'Costed at the spot rate. Eviction, re-queueing and the capacity risk that makes spot cheap are not modelled here, so this is the price of an uninterrupted run, not the expected price.',
      severity: 'WARN',
    });
  }

  const components: SelfHostedComponent[] = [
    {
      component: 'gpu_seconds',
      unit: 'seconds',
      quantity: timing.effective_seconds,
      rate_amount: perSecond,
      rate_record_id: instance.instance_id,
      note: `${plan.rate_basis} ${hourly.rate.unit} x ${instance.gpu_count} GPU(s), tax ${(tax! * 100).toFixed(2)}%, concurrency-adjusted.`,
    },
  ];

  let idlePerDay: number | null = null;

  if (plan.always_on) {
    if (util.value === null) {
      return { status: 'UNAVAILABLE', missing: ['utilization_factor (and no workload to derive it from)'] };
    }
    const idleMultiplier = 1 / util.value - 1;
    components.push({
      component: 'idle_gpu',
      unit: 'seconds',
      quantity: {
        p50: timing.effective_seconds.p50 * idleMultiplier,
        p90: timing.effective_seconds.p90 * idleMultiplier,
        p99: null,
      },
      rate_amount: perSecond,
      rate_record_id: instance.instance_id,
      note: `Idle share at ${(util.value * 100).toFixed(1)}% utilization${util.is_derived ? ', derived from the stated request volume' : ', as stated'}. This line and gpu_seconds together ARE the §A5.9 formula — the idle GPU is not billed a second time.`,
    });
    idlePerDay = instanceDaily * (1 - util.value);

    if (util.value < LOW_UTILIZATION_WARN_THRESHOLD) {
      warnings.push({
        code: 'LOW_UTILIZATION_SELF_HOSTED',
        message: `The instance is ${(util.value * 100).toFixed(0)}% utilized. Most of what is billed is idle GPU, and the per-request figure is dominated by capacity nobody used.`,
        severity: 'WARN',
      });
    }
  } else {
    // Scale-to-zero. Nothing is billed while nothing is served, so there is no idle
    // line — but the cold starts are real GPU seconds and somebody pays for them.
    const coldSeconds = instance.cold_start_seconds.value;
    const coldStarts = plan.cold_starts_per_day;
    if (coldSeconds === null) {
      notes.push(
        'cold_start_seconds is unmeasured, so the scale-to-zero saving is reported without the cost it trades against. The figure is a lower bound.',
      );
    } else if (coldStarts !== null && plan.expected_requests_per_day > 0) {
      const perRequestColdSeconds =
        (coldStarts * coldSeconds) / plan.expected_requests_per_day;
      components.push({
        component: 'gpu_seconds',
        unit: 'seconds',
        quantity: exactRange(perRequestColdSeconds),
        rate_amount: perSecond,
        rate_record_id: instance.instance_id,
        note: `Cold starts: ${coldStarts}/day x ${coldSeconds}s, amortized over ${plan.expected_requests_per_day} requests/day.`,
      });
    }
  }

  // ── amortized fixed costs ───────────────────────────────────────────────────
  // Expressed per request with quantity 1, because a Candidate total is per request
  // and a per-day figure summed into it would be a unit error. The derivation lives
  // in the note so the arithmetic is auditable rather than implied.
  const perDayRequests = plan.expected_requests_per_day;

  if (instance.storage_rate !== null && instance.weights_storage_gb !== null) {
    if (perDayRequests > 0) {
      const dailyStorage = instance.storage_rate.amount * instance.weights_storage_gb * taxed;
      components.push({
        component: 'storage',
        unit: 'requests',
        quantity: exactRange(1),
        rate_amount: dailyStorage / perDayRequests,
        rate_record_id: instance.instance_id,
        note: `${instance.weights_storage_gb} GB of weights at ${instance.storage_rate.amount}/GB/day, amortized over ${perDayRequests} requests/day.`,
      });
    }
  } else if (instance.storage_rate === null) {
    notes.push('No storage rate on the instance row — weight storage is omitted, not zero.');
  }

  const egressGbPer1k = instance.egress_gb_per_1k_requests.value;
  if (instance.egress_rate !== null && egressGbPer1k !== null) {
    components.push({
      component: 'egress',
      unit: 'requests',
      quantity: exactRange(1),
      rate_amount: (instance.egress_rate.amount * egressGbPer1k * taxed) / 1000,
      rate_record_id: instance.instance_id,
      note: `${egressGbPer1k} GB per 1k requests at ${instance.egress_rate.amount}/GB.`,
    });
  } else if (instance.egress_rate !== null && egressGbPer1k === null) {
    notes.push(
      'An egress rate is published but egress_gb_per_1k_requests is unmeasured, so the egress line is omitted rather than assumed zero.',
    );
  }

  const opsMonthly = instance.ops_labour_monthly.value;
  if (opsMonthly !== null && perDayRequests > 0) {
    components.push({
      component: 'ops_labour',
      unit: 'requests',
      quantity: exactRange(1),
      // Not taxed: this is somebody's time, not a line on the cloud invoice.
      rate_amount: opsMonthly / DAYS_PER_MONTH / perDayRequests,
      rate_record_id: instance.instance_id,
      note: `${opsMonthly}/month over ${DAYS_PER_MONTH.toFixed(2)} days and ${perDayRequests} requests/day. An assumption by construction (§A5.9) — edit it.`,
    });
  } else if (opsMonthly === null) {
    notes.push(
      'No ops-labour figure was supplied, so the comparison omits it entirely. Self-hosting is not labour-free; this is a gap in the estimate, not a zero.',
    );
  }

  if (util.diverges) {
    warnings.push({
      code: 'UTILIZATION_STATED_VS_DERIVED',
      message: `Stated utilization ${util.stated} and the ${util.derived} implied by ${perDayRequests} requests/day x ${timing.effective_seconds.p50.toFixed(3)}s disagree. Both are reported; neither is averaged into the other.`,
      severity: 'WARN',
    });
  }
  if (util.exceeds_single_instance) {
    notes.push(
      'The stated volume exceeds what one instance can serve. The per-request figure below is for a single instance and understates the cost — see the breakeven staircase for the multi-instance shape.',
    );
  }

  return {
    status: 'OK',
    currency,
    components,
    utilization: util,
    idle_cost_per_day: idlePerDay,
    instance_daily_amount: instanceDaily,
    warnings,
    notes,
  };
}

/* ─────────────────────────── the crossover ─────────────────────────── */

/**
 * §A5.9: "compute and display the breakeven request volume where self-hosted crosses
 * below API. That crossover chart is the most valuable screen in the product."
 *
 * Two things make this harder than dividing one cost by another, and both of them
 * are ways the naive version lies:
 *
 * ── 1. Utilization cannot be held fixed along the curve. ──────────────────────
 * Utilization is a FUNCTION of volume — the same GPU at 100 requests/day and at
 * 100,000 is 0.1% busy and saturated. Holding it fixed makes the self-hosted line
 * pass through the origin, which means it is either always cheaper or never cheaper
 * and there is no crossover to find. The per-request figure from `selfHostedCost()`
 * is therefore a snapshot at ONE volume and must not be reused as the slope here.
 *
 * ── 2. The always-on curve is a staircase, not a line. ────────────────────────
 * An always-on instance has no marginal per-request cost at all: you pay for the
 * GPU whether or not you call it. Cost is flat until the instance saturates, then
 * steps by a whole instance. A linear model understates self-hosting at high volume
 * — exactly where a chart is used to argue for it — and produces a smooth curve that
 * looks more trustworthy than the true one.
 *
 * Scale-to-zero is genuinely linear, and takes the other branch.
 */
export interface BreakevenInput {
  /** P50 API cost for ONE request, in the same currency as the instance rate. */
  api_cost_per_request: number;
  /** Tax-inclusive cost of running the instance for a full day. */
  instance_daily_amount: number;
  /** Storage + ops per day. Charged whether or not anything is served. */
  fixed_daily_other?: number;
  effective_seconds_p50: number;
  /**
   * Requests one instance can serve per day, as a fraction of the arithmetic
   * maximum. Defaults to 1.0 — the arithmetic ceiling — because a realistic
   * latency-safe ceiling is a property of the operator's SLO and this module has no
   * business inventing one. Supplying a real figure moves the staircase left.
   */
  max_utilization?: number;
  /** Set for a scale-to-zero deployment; omit for always-on. */
  scale_to_zero?: {
    /** Per-request GPU cost, tax included. */
    marginal_per_request: number;
    /** Cold-start GPU cost for a day, independent of volume. */
    cold_fixed_daily: number;
  } | null;
  sample_requests_per_day?: readonly number[];
  /** Assumption ids. The crossover moves with every one of them. */
  assumptions_ref?: readonly string[];
  /** Scan limit for the staircase. Beyond this the answer is "not at any volume". */
  max_instances?: number;
}

export interface BreakevenResult {
  /** Shaped for `Breakeven` in the contracts. */
  requests_per_day_crossover: number | null;
  assumptions_ref: string[];
  series: Array<{ requests_per_day: number; api_cost: number; self_hosted_cost: number }>;
  /** Requests one instance can serve per day. The width of one stair. */
  capacity_per_instance: number;
  notes: string[];
}

export function breakevenCrossover(input: BreakevenInput): BreakevenResult {
  const maxUtil = input.max_utilization ?? 1;
  const fixedOther = input.fixed_daily_other ?? 0;
  const maxInstances = input.max_instances ?? 100;
  const notes: string[] = [];

  if (input.max_utilization === undefined) {
    notes.push(
      'No latency-safe utilization ceiling was supplied, so one instance is assumed servable to 100% of its arithmetic capacity. That is optimistic: it puts the crossover at the lowest volume the arithmetic allows.',
    );
  }

  const capacity = Math.floor((SECONDS_PER_DAY * maxUtil) / input.effective_seconds_p50);
  const apiDaily = (n: number) => n * input.api_cost_per_request;

  const stz = input.scale_to_zero ?? null;
  const selfDaily = (n: number): number => {
    if (stz !== null) return n * stz.marginal_per_request + stz.cold_fixed_daily + fixedOther;
    const instances = Math.max(1, Math.ceil(n / capacity));
    return instances * input.instance_daily_amount + fixedOther;
  };

  let crossover: number | null = null;

  if (capacity < 1) {
    notes.push(
      'One request occupies more than a full day of this instance, so a single instance cannot serve even one request per day and no crossover exists at this configuration.',
    );
  } else if (stz !== null) {
    // Linear: n x marginal + fixed  ==  n x api
    if (input.api_cost_per_request > stz.marginal_per_request) {
      const n = (stz.cold_fixed_daily + fixedOther) / (input.api_cost_per_request - stz.marginal_per_request);
      crossover = Math.ceil(n);
    } else {
      notes.push(
        'The per-request self-hosted cost already meets or exceeds the API price, so volume cannot close the gap — a scale-to-zero deployment has no idle to amortize away.',
      );
    }
  } else {
    // Staircase: find the first instance-count step whose threshold lands inside it.
    for (let k = 1; k <= maxInstances; k += 1) {
      const threshold = (k * input.instance_daily_amount + fixedOther) / input.api_cost_per_request;
      const n = Math.ceil(threshold);
      if (n <= k * capacity) {
        crossover = n;
        break;
      }
    }
    if (crossover === null) {
      notes.push(
        `No crossover within ${maxInstances} instances. At full saturation this instance costs ${(input.instance_daily_amount / capacity).toFixed(6)} per request against an API price of ${input.api_cost_per_request.toFixed(6)}, so self-hosting does not become cheaper by adding volume.`,
      );
    }
  }

  const samples = input.sample_requests_per_day ?? defaultSamples(crossover, capacity);
  const series = samples.map((n) => ({
    requests_per_day: n,
    api_cost: apiDaily(n),
    self_hosted_cost: selfDaily(n),
  }));

  return {
    requests_per_day_crossover: crossover,
    assumptions_ref: [...(input.assumptions_ref ?? [])],
    series,
    capacity_per_instance: capacity,
    notes,
  };
}

/**
 * Sample points for the chart: a log spread, plus the points either side of the
 * crossover and of the first saturation step. Those two are where the shape is, and
 * a plain log spread walks straight past both.
 */
function defaultSamples(crossover: number | null, capacity: number): number[] {
  const pts = new Set<number>([1, 10, 100, 1_000, 10_000, 100_000]);
  if (crossover !== null && crossover > 0) {
    pts.add(Math.max(1, Math.floor(crossover * 0.9)));
    pts.add(crossover);
    pts.add(Math.ceil(crossover * 1.1));
  }
  if (capacity >= 1) {
    pts.add(capacity);
    pts.add(capacity + 1);
  }
  return [...pts].filter((n) => n > 0).sort((a, b) => a - b);
}
