// /packages/contracts/src/estimate.ts
//
// EstimateOutput — the final response of /api/estimate.
//
// "Every figure carries a method and a confidence. A figure without them is
// invalid by contract." That sentence was the header of the hand-authored
// estimate-output.schema.json and nothing enforced it, because there was no Zod
// behind the file. Here it is structural: an EstimateLine cannot be constructed
// without both, a candidate's confidence must EQUAL the minimum over its lines,
// and the estimate's must equal the minimum over its candidates.
//
// Replaces the hand-authored /schemas/estimate-output.schema.json, whose `method`
// enum had 6 of 11 values and whose `confidence` was missing NONE.
//
// Spec anchors: §A3.3 (traceable) · §A3.7 (confidence propagates by minimum) ·
// §A5.7 (context tiers) · §A5.9 (self-hosting) · §A6 (routing)

import { z } from 'zod';
import { Confidence, Method, minConfidence } from './provenance';
import { Assumption, MissingDatum } from './assumption';
import { Currency, DeploymentMode } from './pricing';
import { RateBasis } from './instance';
import { RequestMultipliers } from './request';
import { Tier, ProxyBasis } from './registry';

/* ─────────────────────────── ranges ─────────────────────────── */

/**
 * Rule 3. Point estimates are forbidden for non-deterministic quantities, and
 * "non-deterministic" covers almost everything an LLM does.
 */
export const Range = z
  .object({
    p50: z.number().nonnegative(),
    p90: z.number().nonnegative(),
    p99: z.number().nonnegative().nullable().default(null),
  })
  .superRefine((r, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    // An inverted band is not a wide estimate, it is a swapped assignment — and it
    // reads as plausible on a dashboard, which is what makes it worth a hard error.
    if (r.p90 < r.p50) err('p90 must be >= p50.', ['p90']);
    if (r.p99 !== null && r.p99 < r.p90) err('p99 must be >= p90.', ['p99']);
  });
export type Range = z.infer<typeof Range>;

/* ─────────────────────────── rationale & evidence ─────────────────────────── */

/** No recommendation renders without one. */
export const Rationale = z.object({
  triggering_metric: z.string().min(1),
  observed_value: z.unknown(),
  threshold: z.unknown(),
  evidence_ref: z.string().min(1).nullable().default(null),
});
export type Rationale = z.infer<typeof Rationale>;

export const Evidence = z
  .object({
    ref: z.string().min(1),
    kind: z.enum([
      'PRICING_RECORD',
      'TOKENIZER_RUN',
      'COUNT_API_RESPONSE',
      'CALIBRATION_ROW',
      'BENCHMARK',
      'VENDOR_DOC',
      'MODEL_CARD',
    ]),
    source_url: z.string().url().nullable(),
    verified_at: z.string().datetime().nullable(),
    sample_size: z.number().int().positive().nullable().default(null),
  })
  .refine((e) => e.kind !== 'VENDOR_DOC' || e.source_url !== null, {
    message: 'A VENDOR_DOC evidence row without a URL is a citation of nothing.',
    path: ['source_url'],
  });
export type Evidence = z.infer<typeof Evidence>;

/* ─────────────────────────── the estimate line ─────────────────────────── */

export const CostComponent = z.enum([
  'prompt_input', 'framing_overhead', 'tool_schema', 'conversation_history',
  'image_tiles', 'audio_duration', 'video_frames',
  'completion_output', 'reasoning_output',
  'cache_read', 'cache_write', 'cache_storage', 'per_request_fee',
  // §A5.10. `tool_schema` counts the schemas YOU send (§A5.1); this is what the
  // provider injects on top for merely enabling tools. Two meters, both real, and
  // one provider reports its own as a separate usage field — folding them into one
  // line makes it impossible to see that they did not overlap.
  'tool_use_system_prompt',
  // Not token-priced at all: per thousand calls, per GB-day, or per session.
  'server_tool_call',
  'gpu_seconds', 'idle_gpu', 'storage', 'egress', 'ops_labour',
]);
export type CostComponent = z.infer<typeof CostComponent>;

export const CostUnit = z.enum([
  'tokens', 'tiles', 'images', 'megapixels', 'seconds', 'requests', 'gb', 'months',
]);
export type CostUnit = z.infer<typeof CostUnit>;

/**
 * Present only when a closed-tier model was counted with a substitute vocabulary.
 * `basis` is ProxyBasis from registry.ts — the same fact the model row records, not
 * a second copy of the enum.
 */
export const TokenizerProxyUse = z.object({
  target_model: z.string().min(1),
  proxy_model: z.string().min(1),
  basis: ProxyBasis,
  /** From Tier-1 drift capture. Null = unvalidated, which forces LOW. */
  measured_delta_pct: z.number().nullable().default(null),
});
export type TokenizerProxyUse = z.infer<typeof TokenizerProxyUse>;

export const CacheOutcome = z.object({
  hit: z.boolean(),
  /**
   * Must be true. A hash-only cache key serves one model's token count for
   * another — silently, consistently, and in whichever direction the two
   * vocabularies happen to differ.
   */
  key_includes_tokenizer_revision: z.boolean(),
});
export type CacheOutcome = z.infer<typeof CacheOutcome>;

export const EstimateLine = z
  .object({
    task_id: z.string().min(1),
    component: CostComponent,
    quantity: Range.nullable().default(null),
    unit: CostUnit.nullable().default(null),
    /** Null only when method is UNAVAILABLE. */
    rate_record_id: z.string().min(1).nullable().default(null),
    cost: Range.nullable().default(null),
    /**
     * Padded quantity for the context-overflow and max_tokens checks ONLY.
     *
     * It must NEVER reach a price — padding a quote overcharges the client. Use
     * `billableQuantity()` rather than reading a quantity off this object by hand;
     * that function exists so the invariant survives a copy-paste.
     */
    context_safety_quantity: z.number().nonnegative().nullable().default(null),
    method: Method,
    /**
     * The tier that ACTUALLY produced this number, never the tier requested.
     * 0 cache · 1 remote count API · 2 local/proxy tokenizer · 3 calibrated
     * heuristic. A silent downgrade is the same class of bug as a hardcoded rate.
     */
    tier: z.number().int().min(0).max(3).nullable().default(null),
    tokenizer_proxy: TokenizerProxyUse.nullable().default(null),
    cache: CacheOutcome.nullable().default(null),
    confidence: Confidence,
    note: z.string().min(1).nullable().default(null),
  })
  .superRefine((l, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // Mirrors the Provenance rule. NONE ⟺ UNAVAILABLE, in both directions, so a
    // refusal cannot be dressed as a low-confidence number or vice versa.
    if ((l.method === 'UNAVAILABLE') !== (l.confidence === 'NONE')) {
      err(
        'confidence NONE is reserved for method UNAVAILABLE, and required by it (§A3.3).',
        ['confidence'],
      );
    }
    if (l.method !== 'UNAVAILABLE' && l.rate_record_id === null) {
      err('Only an UNAVAILABLE line may omit rate_record_id — otherwise the price came from nowhere.', [
        'rate_record_id',
      ]);
    }
    if (l.method !== 'UNAVAILABLE' && l.cost === null) {
      err('A line that is not a refusal must carry a cost range (rule 3).', ['cost']);
    }
    if (l.quantity !== null && l.unit === null) {
      err('A quantity without a unit is a number, not a measurement.', ['unit']);
    }
    // Padding never reduces. Anything below the quantity it pads is a sign the two
    // were computed from different inputs.
    if (l.context_safety_quantity !== null && l.quantity !== null) {
      if (l.context_safety_quantity < l.quantity.p50) {
        err('context_safety_quantity must be >= quantity.p50 — padding never reduces.', [
          'context_safety_quantity',
        ]);
      }
      // §A4.5.2 — only the heuristic tier pads. A padded tier-1 count would mean a
      // measured number was inflated, which is exactly what the invariant forbids.
      if (l.tier !== null && l.tier < 3 && l.context_safety_quantity > l.quantity.p90) {
        err('Only tier 3 may pad beyond the measured band; tiers 0-2 report what they counted.', [
          'context_safety_quantity',
        ]);
      }
    }
    if (l.cache !== null && !l.cache.key_includes_tokenizer_revision) {
      err(
        'A cache key without the tokenizer revision serves one model’s count for another (§A5.8).',
        ['cache', 'key_includes_tokenizer_revision'],
      );
    }
    // An unvalidated proxy has no measured drift, so no evidence can lift it.
    if (
      l.tokenizer_proxy !== null &&
      l.tokenizer_proxy.measured_delta_pct === null &&
      l.confidence !== 'LOW' &&
      l.confidence !== 'NONE'
    ) {
      err('An unvalidated tokenizer proxy forces LOW confidence (§A4.5.3).', ['confidence']);
    }
  });
export type EstimateLine = z.infer<typeof EstimateLine>;

/**
 * The only quantity that may be multiplied by a rate.
 *
 * `context_safety_quantity` is deliberately unreachable from here. Read it
 * directly when you are checking a context window; never when you are pricing.
 */
export const billableQuantity = (l: EstimateLine): Range | null => l.quantity;

/* ─────────────────────────── candidates ─────────────────────────── */

export const SelfHostedDetail = z
  .object({
    /**
     * Which machine. Without it the figure cannot be reproduced or re-priced when
     * the instance rate moves — the same gap `pricing_snapshot_id` closes for
     * token rates.
     */
    instance_id: z.string().min(1).nullable().default(null),
    /** Stored, never blended. Spot and on-demand are different risk products. */
    rate_basis: RateBasis,

    vram_feasible: z.boolean(),
    /**
     * GiB throughout, matching InstanceProfile.vram_per_gpu_gib. Mixing GiB and
     * decimal GB across a comparison is a ~7% error at the exact point where the
     * answer is "does it fit".
     */
    required_vram_gib: z.number().positive().nullable().default(null),
    available_vram_gib: z.number().positive().nullable().default(null),
    /**
     * The three terms separately. A single total tells the user they cannot deploy;
     * these tell them which lever moves it — quantize the weights, cut the planned
     * context, or drop the batch size.
     */
    weights_vram_gib: z.number().positive().nullable().default(null),
    kv_cache_vram_gib: z.number().nonnegative().nullable().default(null),
    activation_vram_gib: z.number().nonnegative().nullable().default(null),

    request_seconds: Range.nullable().default(null),
    /**
     * §A5.9.1 — prefill's share of `request_seconds`. On document VLM work this
     * runs close to 100%, which is the opposite of chat, and it is the diagnostic
     * that says which throughput figure the estimate is actually sensitive to.
     */
    prefill_share_pct: z.number().min(0).max(100).nullable().default(null),

    /** Exclusive of 0: a candidate you never call has no per-request cost to compare. */
    utilization_factor: z.number().gt(0).max(1),
    /**
     * True when the estimator computed utilization from the workload rather than
     * being told it. The number is the same kind of thing either way; where it came
     * from is not, and §A5.9 calls this the honest lever precisely because it is the
     * one a vendor comparison is most tempted to set for you.
     */
    utilization_is_derived: z.boolean().default(false),

    idle_cost_per_day: z.number().nonnegative().nullable().default(null),
    ops_labour_monthly: z.number().nonnegative().nullable().default(null),
  })
  .superRefine((d, ctx) => {
    // A refusal has to say by how much it missed. "Does not fit" with no figures is
    // indistinguishable from "we could not work it out", and the two call for
    // completely different next actions from the user.
    if (!d.vram_feasible && (d.required_vram_gib === null || d.available_vram_gib === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'An infeasible deployment must report both required and available VRAM — by how much it missed is the actionable part (§A5.9).',
        path: ['required_vram_gib'],
      });
    }
  });
export type SelfHostedDetail = z.infer<typeof SelfHostedDetail>;

export const Candidate = z
  .object({
    model_id: z.string().min(1),
    provider_id: z.string().min(1),
    tier: Tier.nullable().default(null),
    deployment_mode: DeploymentMode,
    data_residency_region: z.string().min(1).nullable().default(null),
    is_prc_hosted: z.boolean().nullable().default(null),
    lines: z.array(EstimateLine),
    total_tokens: z
      .object({
        input: Range.nullable().default(null),
        output: Range.nullable().default(null),
        reasoning: Range.nullable().default(null),
        cached: Range.nullable().default(null),
      })
      .nullable()
      .default(null),
    total_cost: Range,
    currency: Currency,
    display_currency: Currency.nullable().default(null),
    /** Dated FX record id. Required whenever display_currency differs from currency. */
    fx_rate_ref: z.string().min(1).nullable().default(null),
    self_hosted_detail: SelfHostedDetail.nullable().default(null),
    /**
     * §A5.10 — what was multiplied onto every line, and why. Null means neither
     * layer applied (standard tier, no regional endpoint), which is a different
     * claim from "we did not look".
     */
    request_multipliers: RequestMultipliers.nullable().default(null),
    confidence: Confidence,
  })
  .superRefine((c, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // §A3.7 — confidence is COMPUTED, never typed in. This is the rule the spec
    // states and no schema could enforce: a HIGH token count multiplied by an
    // UNAVAILABLE rate is not a HIGH estimate, it is not an estimate at all.
    const computed = c.lines.length ? minConfidence(...c.lines.map((l) => l.confidence)) : 'NONE';
    if (c.confidence !== computed) {
      err(
        `confidence must equal the minimum over lines (§A3.7): computed ${computed}, got ${c.confidence}.`,
        ['confidence'],
      );
    }
    if (c.display_currency !== null && c.display_currency !== c.currency && c.fx_rate_ref === null) {
      err(
        'A converted display currency requires a dated fx_rate_ref — a stale FX rate is invisible in a way a stale price is not (§A4.2).',
        ['fx_rate_ref'],
      );
    }
    if (c.self_hosted_detail !== null && c.deployment_mode === 'API_MANAGED') {
      err('An API_MANAGED candidate has no self-hosted detail to report.', ['self_hosted_detail']);
    }
    if (c.deployment_mode === 'SELF_HOSTED' && c.self_hosted_detail === null) {
      err(
        'A SELF_HOSTED candidate needs its VRAM and utilization detail — without it the comparison is not like-for-like (§A5.9).',
        ['self_hosted_detail'],
      );
    }
  });
export type Candidate = z.infer<typeof Candidate>;

/* ─────────────────────────── recommendations ─────────────────────────── */

export const Recommendation = z.object({
  model_id: z.string().min(1),
  deployment_mode: DeploymentMode.nullable().default(null),
  total_cost: Range.nullable().default(null),
  rationale: Rationale,
});
export type Recommendation = z.infer<typeof Recommendation>;

export const SplitRouting = z.object({
  assignments: z.array(
    z.object({
      task_id: z.string().min(1),
      model_id: z.string().min(1),
      rationale: Rationale,
    }),
  ),
  total_cost_p50: z.number().nonnegative().nullable().default(null),
  saving_vs_single_model_pct: z.number().nullable().default(null),
});
export type SplitRouting = z.infer<typeof SplitRouting>;

export const Recommendations = z.object({
  cheapest: Recommendation.nullable().default(null),
  best_capability: Recommendation.nullable().default(null),
  balanced: Recommendation.nullable().default(null),
  /** Per-task model assignment. Often beats any single-model choice. */
  split_routing: SplitRouting.nullable().default(null),
});
export type Recommendations = z.infer<typeof Recommendations>;

/* ─────────────────────────── exclusions ─────────────────────────── */

/**
 * Why a model was removed BEFORE ranking. Transparency requirement — a router
 * that silently drops the cheapest option is indistinguishable from one that is
 * wrong about the price.
 *
 * ⚠️ Not the same as `Ineligibility` in registry.ts, and deliberately so. That
 * one answers "can this row produce a number at all", from the row alone, before
 * a request exists. This one is about THIS request: residency, context size and
 * asset constraints are properties of the pairing, not of the model. They overlap
 * on TOKENIZER_UNAVAILABLE and nowhere else.
 */
export const ExclusionReason = z.enum([
  'MISSING_MODALITY',
  'NO_TOOL_SUPPORT',
  'CONTEXT_TOO_SMALL',
  'DATA_RESIDENCY_BLOCKED',
  'RATE_MISSING',
  'RATE_STALE',
  'VRAM_INFEASIBLE',
  'TOKENIZER_UNAVAILABLE',
  'ASSET_EXCEEDS_CONSTRAINTS',
  /**
   * The estimate for this candidate did not finish — some line refused, so its
   * total is a LOWER BOUND rather than a price.
   *
   * Distinct from RATE_MISSING, which names a cause. This names a state: the
   * missing piece may be the rate, the token count, the geometry or the prior,
   * and the router does not need to know which in order to refuse to rank it.
   * Without this, `assembleCandidate` sums refusal lines as zero and a candidate
   * nothing could price ranks FIRST, at $0.00.
   */
  'ESTIMATE_INCOMPLETE',
]);
export type ExclusionReason = z.infer<typeof ExclusionReason>;

export const ExcludedModel = z.object({
  model_id: z.string().min(1),
  reason: ExclusionReason,
  detail: z.string().min(1).nullable().default(null),
});
export type ExcludedModel = z.infer<typeof ExcludedModel>;

/* ─────────────────────────── optimization ─────────────────────────── */

export const OptimizationLever = z.enum([
  'ENABLE_PROMPT_CACHING', 'TRIM_CONVERSATION_HISTORY', 'SUMMARIZE_ROLLUP',
  'DOWNSIZE_MODEL_FOR_TASK', 'BATCH_REQUESTS', 'REDUCE_IMAGE_RESOLUTION',
  'USE_LOW_DETAIL_VISION', 'TRIM_TOOL_SCHEMAS', 'LOWER_MAX_TOKENS',
  'AVOID_CONTEXT_TIER_THRESHOLD', 'SWITCH_TO_SELF_HOSTED', 'SWITCH_TO_API',
]);
export type OptimizationLever = z.infer<typeof OptimizationLever>;

export const Optimization = z
  .object({
    lever: OptimizationLever,
    target_task_ids: z.array(z.string().min(1)).default([]),
    projected_saving_pct: z.number().min(0).max(100),
    projected_saving_absolute: z.number().nullable().default(null),
    /** What gets worse. A lever with no stated tradeoff is under-analysed. */
    tradeoff: z.string().min(1).nullable().default(null),
    rationale: Rationale,
  })
  .refine((o) => o.projected_saving_pct === 0 || o.tradeoff !== null, {
    // Every one of these levers costs something — latency, fidelity, quality or
    // operational burden. A saving with no stated cost is a recommendation the
    // user cannot evaluate.
    message: 'A lever projecting a saving must state what gets worse.',
    path: ['tradeoff'],
  });
export type Optimization = z.infer<typeof Optimization>;

/* ─────────────────────────── system overhead ─────────────────────────── */

/**
 * §A4.4.1 — the cost of the estimator's own parse.
 *
 * "A cost calculator that doesn't meter its own parser is lying about total cost
 * of ownership." An L2 parse is an LLM call with input and output tokens, and it
 * has to appear somewhere.
 *
 * ⚠️ TWO PLACEMENT RULES, both easy to get wrong, and only one of them needs a
 * runtime check:
 *
 * 1. **It belongs at the estimate level, not in a candidate's `lines[]`.** The
 *    parse happens ONCE per workflow, before any model is chosen. Metering it per
 *    candidate multiplies it by the number of models being compared and corrupts
 *    every comparison, because the same constant is added to both sides.
 *
 *    That one needs no check: `CostComponent` has no member for it, so a parse
 *    cost cannot be expressed as an `EstimateLine` at all. The type system is the
 *    guard.
 *
 * 2. **An L1 parse costs nothing, so it emits no entry.** That is what makes the
 *    L1 hit-rate legible as a margin figure — "if every parse shows overhead, you
 *    cannot see the lever". `source` is an enum of one today for that reason: the
 *    only overhead this project has found is the L2 parse, and inventing
 *    categories for costs nobody has measured would defeat the point.
 */
export const SystemOverhead = z.object({
  source: z.enum(['L2_PARSE']),
  /**
   * The parser runs on the cheapest capable model, which is frequently NOT one of
   * the candidates being priced — so this rate lookup is independent of the
   * comparison set and the id here may name a model absent from `candidates`.
   */
  parser_model_id: z.string().min(1),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost: Range.nullable().default(null),
  currency: Currency,
  rate_record_id: z.string().min(1).nullable().default(null),
  method: Method,
  confidence: Confidence,
});
export type SystemOverhead = z.infer<typeof SystemOverhead>;

/* ─────────────────────────── breakeven ─────────────────────────── */

export const BreakevenPoint = z.object({
  requests_per_day: z.number().nonnegative(),
  api_cost: z.number().nonnegative(),
  self_hosted_cost: z.number().nonnegative(),
});

export const Breakeven = z.object({
  requests_per_day_crossover: z.number().nonnegative().nullable().default(null),
  /** Assumption ids. The crossover moves with every one of them. */
  assumptions_ref: z.array(z.string().min(1)).default([]),
  series: z.array(BreakevenPoint).default([]),
});
export type Breakeven = z.infer<typeof Breakeven>;

/* ─────────────────────────── warnings ─────────────────────────── */

export const WarningCode = z.enum([
  'MAX_TOKENS_BELOW_P90', 'NEAR_CONTEXT_TIER_THRESHOLD', 'PRICE_CHANGED_SINCE_LAST_RUN',
  'RATE_CONFLICT_UNRESOLVED', 'PROXY_TOKENIZER_IN_USE', 'LOW_UTILIZATION_SELF_HOSTED',
  'STALE_FX_RATE', 'REASONING_TOKENS_ESTIMATED', 'VIDEO_HIGH_VARIANCE',
  'CALIBRATION_SAMPLE_TOO_SMALL', 'ESCALATION_FAILED',
  'HEURISTIC_ON_UNCALIBRATED_SCRIPT', 'PROXY_SCRIPT_MISMATCH',
  'PROXY_DRIFT_EXCEEDED', 'MEDIA_PAYLOAD_NOT_REMOTE_COUNTED',
  'CACHE_KEY_MISSING_TOKENIZER_REVISION', 'ASSET_EXCEEDS_MAX_EDGE',
  'RESIZE_SAVES_NOTHING', 'RESIZE_BELOW_LEGIBILITY_FLOOR',
  'PROVIDER_WILL_NORMALIZE', 'REROUTED_FOR_ASSET_CONSTRAINT',
  'REROUTE_BLOCKED_BY_RESIDENCY',
  // §A5.6 / §A5.8 caching. `cache.ts` already detects all three and already writes
  // a sentence about each; none of them had a code, so none could reach
  // `EstimateOutput.warnings` and the sentence died inside the module. Caching
  // costing more than it saves is not a footnote — it is the answer.
  'CACHE_NET_LOSS',
  'CACHE_STORAGE_DOMINATES',
  'CACHE_WRITE_PREMIUM',
  // §A5.3 audio / video.
  'FPS_NOT_CONFIGURABLE',
  'VIDEO_FRAMES_CLAMPED_TO_MAX',
  'AUDIO_TRACK_FOLDED_INTO_VIDEO_TOKENS',
  // §A5.9 self-hosting.
  'SPOT_RATE_INTERRUPTION_UNMODELLED',
  'UTILIZATION_STATED_VS_DERIVED',
  'VISUAL_TOKENS_DOMINATE_CONTEXT',
  // §A5.10 request-level multipliers and non-token fees.
  'SERVER_TOOL_ALLOWANCE_NOT_APPLIED',
  'SERVICE_TIER_UNAVAILABLE',
  'RESIDENCY_UPLIFT_APPLIED',
  'REROLL_COUNT_DEFAULTED',
]);
export type WarningCode = z.infer<typeof WarningCode>;

export const EstimateWarning = z.object({
  code: WarningCode,
  message: z.string().min(1),
  severity: z.enum(['INFO', 'WARN', 'BLOCKING']),
});
export type EstimateWarning = z.infer<typeof EstimateWarning>;

/* ─────────────────────────── the document ─────────────────────────── */

export const EstimateOutput = z
  .object({
    estimate_id: z.string().min(1),
    workflow_id: z.string().min(1).nullable().default(null),
    scenario_id: z.string().min(1).nullable().default(null),
    generated_at: z.string().datetime(),
    /**
     * Pins the exact rate set used. Required for reproducibility of saved
     * scenarios after prices move — without it a re-run is a different estimate
     * wearing the same id.
     */
    pricing_snapshot_id: z.string().min(1),
    candidates: z.array(Candidate),
    recommendations: Recommendations.nullable().default(null),
    excluded_models: z.array(ExcludedModel).default([]),
    optimization_report: z.array(Optimization).default([]),
    breakeven: Breakeven.nullable().default(null),
    assumptions: z.array(Assumption),
    evidence: z.array(Evidence),
    confidence: Confidence,
    needs_human_review: z.boolean(),
    missing_data: z.array(MissingDatum),
    warnings: z.array(EstimateWarning).default([]),
    /**
     * §A4.4.1. Empty for an L1 parse, which is free — and that emptiness is the
     * operating metric, not a missing field. Excluded from per-candidate ranking
     * by construction: it is not a line and cannot become one.
     */
    system_overhead: z.array(SystemOverhead).default([]),
  })
  .superRefine((e, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // §A3.7 again, one level up.
    const computed = e.candidates.length
      ? minConfidence(...e.candidates.map((c) => c.confidence))
      : 'NONE';
    if (e.confidence !== computed) {
      err(
        `confidence must equal the minimum over candidates (§A3.7): computed ${computed}, got ${e.confidence}.`,
        ['confidence'],
      );
    }
    // NONE means no estimate was produced. Shipping that without flagging it is
    // how a refusal gets read as a zero.
    if (e.confidence === 'NONE' && !e.needs_human_review) {
      err('An estimate with NONE confidence must set needs_human_review.', ['needs_human_review']);
    }
    if (e.missing_data.some((m) => m.blocks_estimate) && !e.needs_human_review) {
      err('A blocking missing_data entry requires needs_human_review.', ['needs_human_review']);
    }
    if (e.warnings.some((w) => w.severity === 'BLOCKING') && !e.needs_human_review) {
      err('A BLOCKING warning requires needs_human_review.', ['needs_human_review']);
    }

    // Recommendations and split-routing assignments must point at candidates that
    // were actually costed. A recommendation for an excluded model is a routing bug
    // that reads as a bargain.
    const priced = new Set(e.candidates.map((c) => c.model_id));
    const checkRec = (r: Recommendation | null, key: string) => {
      if (r !== null && !priced.has(r.model_id)) {
        err('A recommendation must name a candidate that was costed.', ['recommendations', key]);
      }
    };
    if (e.recommendations) {
      checkRec(e.recommendations.cheapest, 'cheapest');
      checkRec(e.recommendations.best_capability, 'best_capability');
      checkRec(e.recommendations.balanced, 'balanced');
      e.recommendations.split_routing?.assignments.forEach((a, i) => {
        if (!priced.has(a.model_id)) {
          err('A split-routing assignment must name a candidate that was costed.', [
            'recommendations',
            'split_routing',
            'assignments',
            i,
          ]);
        }
      });
    }

    // Evidence is referenced by ref from rationales; duplicates make a ref ambiguous.
    const refs = e.evidence.map((v) => v.ref);
    if (new Set(refs).size !== refs.length) {
      err('evidence ref must be unique — rationales point at it.', ['evidence']);
    }
    // A model cannot be both priced and excluded.
    e.excluded_models.forEach((x, i) => {
      if (priced.has(x.model_id)) {
        err('A model cannot be both a candidate and excluded.', ['excluded_models', i]);
      }
    });
  });
export type EstimateOutput = z.infer<typeof EstimateOutput>;

/* ─────────────────────── inferred types ───────────────────────
 * Companions for the schemas above that were defined without one. Every schema in
 * this package should export both: a consumer that can only import the value has to
 * write `z.infer<typeof X>` at its own use sites, which is the same shape spelled
 * out in two places and one edit away from disagreeing.
 */
export type BreakevenPoint = z.infer<typeof BreakevenPoint>;
