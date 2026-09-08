// /packages/estimator/src/request.ts
//
// §A5.10 — request-level multipliers and non-token fees.
//
// §A5.8's identity covers what is metered per token. This is the rest of the
// invoice, and every term in it is missed for the same structural reason: it is a
// property of the REQUEST, and a row-level registry has nowhere to put it.
//
//   FINAL_COST = ( TOKEN_TERMS(§A5.8)
//                + cache_storage_tokens x storage_rate x hours_held     <- cache.ts
//                + tool_use_system_prompt_tokens x input_rate           <- here
//                + Σ server_tool_calls x per_call_fee )                 <- here
//              x service_tier_multiplier                                <- here
//              x (1 + residency_uplift_pct)                             <- here
//
// The two multiplicative layers are applied PER LINE rather than to the total.
// Algebraically identical — but `Candidate.total_cost` is required to equal the sum
// of its lines, so scaling the total alone would break the contract, and scaling
// only some lines would silently exempt whichever the author forgot. Applying it to
// every line keeps the decomposition readable and the invariant true.
//
// What is NOT here: the cache storage term (cache.ts already carries it, §A5.6 plus
// §A5.10), the two §A5.7 shape corrections and the image-generation fourth pricing
// dimension (all three already landed in the contracts).

import {
  EstimateLine,
  minConfidence,
  IDENTITY_FACTOR,
  RequestMultipliers,
  type Confidence,
  type ComplianceProfile,
  type ImageMetrics,
  type Range,
  type Rate,
  type RequestOptions,
  type ServerToolFee,
  type ServerToolUse,
  type ServiceTier,
  type ServiceTierProfile,
  type TextRateProfile,
} from '@tokenomics/contracts';
import { exactRange } from './range';

/* ═══════════════════════ 1. the service tier ═══════════════════════ */

export type ServiceTierResult =
  | { status: 'OK'; multiplier: number; confidence: Confidence; profile: ServiceTierProfile }
  | { status: 'UNAVAILABLE'; reason: string; warning: 'SERVICE_TIER_UNAVAILABLE' };

/**
 * Resolve the multiplier for the tier the caller asked for.
 *
 * ⚠️ §A5.10: the multipliers are **not shared across vendors** — the annex records
 * one provider's premium tier at 1.8x where two others use 2x. So this function
 * takes the model row's own `ServiceTierProfile[]` and has no table of its own. A
 * shared constant here would be a hardcoded rate wearing a config's clothes (§A3.1).
 *
 * Three ways it refuses, and each is a real vendor behaviour rather than a defensive
 * check: the tier may not exist for this provider, it may be excluded in combination
 * with another the caller also asked for, and it may be unavailable in the region
 * the residency constraint forces. Falling back to `standard` in any of those cases
 * would price a request the provider would not accept.
 */
export function resolveServiceTier(
  profiles: readonly ServiceTierProfile[],
  requested: ServiceTier,
  region: string | null,
  alsoRequested: readonly ServiceTier[] = [],
): ServiceTierResult {
  const profile = profiles.find((p) => p.tier === requested);
  if (profile === undefined) {
    return {
      status: 'UNAVAILABLE',
      reason: `This provider publishes no '${requested}' tier. Its multiplier is not 1 by default — it is unknown, and another vendor's figure does not transfer (§A5.10).`,
      warning: 'SERVICE_TIER_UNAVAILABLE',
    };
  }
  if (!profile.available) {
    return {
      status: 'UNAVAILABLE',
      reason: `The '${requested}' tier is published but marked unavailable.`,
      warning: 'SERVICE_TIER_UNAVAILABLE',
    };
  }
  const clash = alsoRequested.find((t) => t !== requested && profile.excludes.includes(t));
  if (clash !== undefined) {
    return {
      status: 'UNAVAILABLE',
      reason: `'${requested}' cannot be combined with '${clash}'.`,
      warning: 'SERVICE_TIER_UNAVAILABLE',
    };
  }
  if (region !== null && profile.unavailable_in_regions.includes(region)) {
    return {
      status: 'UNAVAILABLE',
      reason: `'${requested}' is not offered in ${region}. A residency constraint can remove a discount tier, which is a cost consequence of the compliance choice and not a separate one.`,
      warning: 'SERVICE_TIER_UNAVAILABLE',
    };
  }

  const multiplier = profile.multiplier.value;
  if (multiplier === null) {
    return {
      status: 'UNAVAILABLE',
      reason: `The '${requested}' tier exists but its multiplier is unsourced. §A3.2 — refuse rather than assume 1.`,
      warning: 'SERVICE_TIER_UNAVAILABLE',
    };
  }
  // A sourced() may legally hold a value alongside NONE confidence, and NONE is
  // reserved for UNAVAILABLE. Floored onto a priced line that would make the line
  // NONE while it still carries a cost, which the EstimateLine contract rejects
  // outright — correctly. Refuse here instead, where the reason can be stated.
  const confidence = profile.multiplier.provenance.confidence;
  if (confidence === 'NONE') {
    return {
      status: 'UNAVAILABLE',
      reason: `The '${requested}' tier multiplier carries NONE confidence, which is a refusal wearing a number.`,
      warning: 'SERVICE_TIER_UNAVAILABLE',
    };
  }
  return { status: 'OK', multiplier, confidence, profile };
}

/* ═══════════════════════ 2. the residency uplift ═══════════════════════ */

export type ResidencyResult =
  | { status: 'OK'; uplift_pct: number; confidence: Confidence; applies: boolean }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * §A5.10 — a regional or in-country endpoint carries a percentage uplift on **all**
 * categories, cache reads and writes included.
 *
 * "This binds directly on Gulf routing: the compliant option is not the same price
 * as the default, and a router that filters on residency without applying this
 * understates it." Understating the compliant path is the specific failure — the
 * router recommends it *because* it is compliant and then quotes it at the
 * non-compliant price.
 *
 * The uplift applies only when the request actually routes to one of the model's
 * residency regions. A request served from the default endpoint pays no uplift, and
 * a request that names a region the model does not list is not a cheap version of
 * the compliant option — it is a routing error, and it refuses.
 */
export function residencyUplift(
  compliance: ComplianceProfile,
  region: string | null,
): ResidencyResult {
  if (region === null) {
    return { status: 'OK', uplift_pct: 0, confidence: 'HIGH', applies: false };
  }
  if (!compliance.data_residency_region.includes(region)) {
    return {
      status: 'UNAVAILABLE',
      reason: `This model does not publish an endpoint in ${region}; it lists ${compliance.data_residency_region.join(', ')}. Pricing it there would quote a route that does not exist.`,
    };
  }
  const pct = compliance.residency_uplift_pct.value;
  if (pct === null) {
    return {
      status: 'UNAVAILABLE',
      reason: `A regional endpoint in ${region} was requested but its uplift is unsourced. Treating it as zero prices the compliant path as though compliance were free (§A5.10).`,
    };
  }
  const confidence = compliance.residency_uplift_pct.provenance.confidence;
  if (confidence === 'NONE') {
    return {
      status: 'UNAVAILABLE',
      reason: `The ${region} uplift carries NONE confidence, which is a refusal wearing a number.`,
    };
  }
  return { status: 'OK', uplift_pct: pct, confidence, applies: pct > 0 };
}

/* ═══════════════════ 3. the tool-use system prompt ═══════════════════ */

export type ToolSystemPromptResult =
  | { status: 'OK'; tokens: number; confidence: Confidence; rate: Rate }
  | { status: 'NOT_APPLICABLE' }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * §A5.10 — a published, per-model token count for merely ENABLING tools.
 *
 * "Separate from and additional to the tool schema JSON in §A5.1." §A5.1 counts the
 * schemas you send; this is what the provider injects on top. Two meters, both real,
 * and one provider reports its tool tokens as its own usage field — independent
 * confirmation that they are not a subset of input.
 *
 * That is why this returns a figure to be billed on its own `tool_use_system_prompt`
 * line rather than being folded into `tool_schema`: folded together, nobody can
 * later check that they did not overlap.
 */
export function toolUseSystemPromptTokens(
  rates: TextRateProfile,
  toolChoiceMode: string | null,
): ToolSystemPromptResult {
  if (toolChoiceMode === null) return { status: 'NOT_APPLICABLE' };

  const row = rates.tool_use_system_prompt_tokens.find(
    (r) => r.tool_choice_mode === toolChoiceMode,
  );
  if (row === undefined) {
    return {
      status: 'UNAVAILABLE',
      reason: `No published tool-use system prompt count for mode '${toolChoiceMode}'. The injection is not zero merely because it is unpublished.`,
    };
  }
  if (row.tokens.value === null) {
    return {
      status: 'UNAVAILABLE',
      reason: `The tool-use system prompt count for '${toolChoiceMode}' is unsourced.`,
    };
  }
  const inputRate = rates.input_rate_by_modality.text ?? null;
  if (inputRate === null) {
    return {
      status: 'UNAVAILABLE',
      reason: 'The tool-use system prompt bills at the text input rate, and there is none.',
    };
  }
  return {
    status: 'OK',
    tokens: row.tokens.value,
    confidence: minConfidence(row.tokens.provenance.confidence, inputRate.provenance.confidence),
    rate: inputRate,
  };
}

/* ═══════════════════ 4. server-tool per-call fees ═══════════════════ */

export interface ServerToolCharge {
  tool: string;
  /** Calls actually billed, after any verified free allowance. */
  billable_calls: number;
  /** Calls the allowance covered. Zero when no allowance, or none could be verified. */
  free_calls: number;
  /** Per single call, derived from the published unit. */
  amount_per_call: number;
  rate: Rate;
  confidence: Confidence;
  note: string | null;
}

export interface ServerToolResult {
  charges: ServerToolCharge[];
  /** Tools the request will call that the model row does not price. */
  unpriced: Array<{ tool: string; reason: string }>;
  warnings: string[];
  notes: string[];
}

/** Units a per-call fee may legitimately arrive in, and what one call costs. */
function perCallAmount(rate: Rate): number | null {
  switch (rate.unit) {
    case 'per_1k_calls':
      return rate.amount / 1000;
    case 'per_request':
      return rate.amount;
    default:
      return null;
  }
}

/**
 * §A5.10 — web search, file search, code containers: "not token-priced at all",
 * priced per thousand calls, per GB-day or per session. A token-only estimator
 * returns zero for them, and "an agentic workflow with search enabled can have a
 * majority of its cost here."
 *
 * ── The free allowance, and why it is not applied by default ────────────────
 * Several of these fees carry a monthly free allowance. Applying it requires knowing
 * how much of the month is already spent, which is account state this function is
 * not given unless the caller supplies it. Faced with that gap there are three
 * options and only one is honest:
 *
 *   assume the allowance is intact  -> understates, in the customer's favour, silently
 *   refuse the whole line           -> discards a fee that IS known
 *   bill every call and say so      -> overstates by at most the allowance, visibly
 *
 * The third. The warning and the note name the allowance that was not applied, so
 * the reader can subtract it themselves if they know the answer.
 */
export function serverToolFees(
  fees: readonly ServerToolFee[],
  uses: readonly ServerToolUse[],
  executions = 1,
): ServerToolResult {
  const charges: ServerToolCharge[] = [];
  const unpriced: Array<{ tool: string; reason: string }> = [];
  const warnings = new Set<string>();
  const notes: string[] = [];

  for (const use of uses) {
    if (use.calls_per_execution === 0) continue;

    const fee = fees.find((f) => f.tool === use.tool);
    if (fee === undefined) {
      unpriced.push({
        tool: use.tool,
        reason: `The model row publishes no fee for '${use.tool}'. A tool the workflow calls and the registry does not price is a hole in the estimate, not a free call.`,
      });
      continue;
    }
    const amount = perCallAmount(fee.rate);
    if (amount === null) {
      unpriced.push({
        tool: use.tool,
        reason: `'${use.tool}' is priced in ${fee.rate.unit}, which is not a per-call unit. Converting it needs a quantity this function does not have (a session length, a GB-day).`,
      });
      continue;
    }

    const totalCalls = use.calls_per_execution * executions;
    let freeCalls = 0;
    let note: string | null = null;

    if (fee.free_allowance_per_month !== null) {
      if (use.calls_used_this_month === null) {
        warnings.add('SERVER_TOOL_ALLOWANCE_NOT_APPLIED');
        note = `A free allowance of ${fee.free_allowance_per_month}/month is published for '${use.tool}', but calls already made this month are unknown, so every call is billed. This overstates by at most the allowance.`;
        notes.push(note);
      } else {
        const remaining = Math.max(0, fee.free_allowance_per_month - use.calls_used_this_month);
        freeCalls = Math.min(remaining, totalCalls);
        note = `${freeCalls} of ${totalCalls} calls covered by the remaining monthly allowance (${remaining} of ${fee.free_allowance_per_month} left).`;
      }
    }

    charges.push({
      tool: use.tool,
      billable_calls: totalCalls - freeCalls,
      free_calls: freeCalls,
      amount_per_call: amount,
      rate: fee.rate,
      confidence: fee.rate.provenance.confidence,
      note,
    });
  }

  return { charges, unpriced, warnings: [...warnings], notes };
}

/* ═══════════════════════ 5. re-rolls ═══════════════════════ */

export interface RerollResult {
  factor: number;
  /** True when the spec's "almost never actually 1" default went unchallenged. */
  defaulted: boolean;
  warning: 'REROLL_COUNT_DEFAULTED' | null;
  note: string | null;
}

const GENERATING: ReadonlySet<ImageMetrics['operation']> = new Set([
  'generate',
  'img2img',
  'inpaint',
]);

/**
 * §A5.10 — "image workflows generate N candidates per accepted image. Every
 * candidate bills."
 *
 * The field defaults to 1 and §A5.10 says it is "almost never actually 1", so the
 * default is reported rather than accepted. A default that is usually wrong should
 * cost the estimate some confidence; the caller turns `defaulted` into an Assumption
 * whose ceiling does exactly that (§A4.4.4).
 *
 * Upscale is excluded: it operates on an image already accepted, so there is no
 * candidate set to multiply.
 */
export function rerollFactor(m: ImageMetrics): RerollResult {
  if (!GENERATING.has(m.operation)) {
    return { factor: 1, defaulted: false, warning: null, note: null };
  }
  const n = m.candidates_per_accepted_image;
  if (n === 1) {
    return {
      factor: 1,
      defaulted: true,
      warning: 'REROLL_COUNT_DEFAULTED',
      note: 'candidates_per_accepted_image is at its default of 1. §A5.10 records that this is almost never the real figure, and every candidate bills — so this is the floor of the generation cost, not an estimate of it.',
    };
  }
  return {
    factor: n,
    defaulted: false,
    note: `${n} candidates billed per accepted image.`,
    warning: null,
  };
}

/* ═══════════════════ 6. applying the multipliers ═══════════════════ */

export interface MultiplierInput {
  service_tier: ServiceTier;
  service_tier_multiplier: number;
  service_tier_confidence: Confidence;
  region: string | null;
  residency_uplift_pct: number;
  residency_confidence: Confidence;
}

export interface AppliedMultipliers {
  lines: EstimateLine[];
  multipliers: RequestMultipliers;
  warnings: string[];
}

const scale = (r: Range | null, f: number): Range | null =>
  r === null ? null : { p50: r.p50 * f, p90: r.p90 * f, p99: r.p99 === null ? null : r.p99 * f };

/**
 * Scale every line by `tier_multiplier x (1 + residency_uplift)`.
 *
 * Three properties this preserves, each of which a total-level multiplication would
 * break:
 *
 *   1. `Candidate.total_cost == Σ line.cost` still holds, because every line moved.
 *   2. No line is exempt by omission. §A5.10 is explicit that the residency uplift
 *      applies to "all categories, cache reads and writes included" — the terms most
 *      likely to be forgotten, because they are not where anyone looks for a regional
 *      surcharge.
 *   3. QUANTITIES are untouched. A batch tier does not change how many tokens you
 *      send; it changes what they cost. Scaling the quantity would corrupt the token
 *      totals and the context-window check along with the price.
 *
 * A refusal line (`method: 'UNAVAILABLE'`, no cost) passes through unscaled. There is
 * nothing to multiply, and multiplying nothing produces a zero that reads as free.
 *
 * Confidence: §A3.7. A multiplier is an input like any other, so each line's
 * confidence is floored by the weakest of the two. A HIGH token count at a
 * MEDIUM-confidence tier multiplier is a MEDIUM figure.
 */
export function applyRequestMultipliers(
  lines: readonly EstimateLine[],
  input: MultiplierInput,
): AppliedMultipliers {
  const factor = input.service_tier_multiplier * (1 + input.residency_uplift_pct);
  const warnings: string[] = [];
  if (input.residency_uplift_pct > 0) warnings.push('RESIDENCY_UPLIFT_APPLIED');

  const floor = minConfidence(input.service_tier_confidence, input.residency_confidence);

  const scaled = lines.map((l) => {
    if (l.method === 'UNAVAILABLE' || l.cost === null) return l;
    // Re-parsed rather than spread and trusted: the scaled line goes back through
    // the same refinements `buildLine` uses, so a multiplier cannot produce a line
    // the contract would have rejected had it been built directly.
    return EstimateLine.parse({
      ...l,
      cost: factor === IDENTITY_FACTOR ? l.cost : scale(l.cost, factor),
      // A multiplier of exactly 1 still floors the confidence: a LOW-confidence
      // source claiming nothing was added is a LOW-confidence claim.
      confidence: minConfidence(l.confidence, floor),
    });
  });

  return {
    lines: scaled,
    multipliers: RequestMultipliers.parse({
      service_tier: input.service_tier,
      service_tier_multiplier: input.service_tier_multiplier,
      region: input.region,
      residency_uplift_pct: input.residency_uplift_pct,
      combined_factor: factor,
      confidence: floor,
    }),
    warnings,
  };
}

/* ═══════════════════ 7. the whole request-level layer ═══════════════════ */

export interface RequestLayerInput {
  options: RequestOptions;
  tier_profiles: readonly ServiceTierProfile[];
  compliance: ComplianceProfile;
  rates: TextRateProfile;
  /** Executions of the task these fees are counted for. */
  executions?: number;
}

export type RequestLayerResult =
  | {
      status: 'OK';
      multipliers: MultiplierInput;
      tool_system_prompt: ToolSystemPromptResult;
      server_tools: ServerToolResult;
      warnings: string[];
      notes: string[];
    }
  | { status: 'UNAVAILABLE'; reasons: string[]; warnings: string[] };

/**
 * Resolve everything §A5.10 adds, in one pass, so a caller cannot apply three of the
 * four layers and quietly drop the fourth.
 *
 * Refuses as a unit: if the service tier or the residency uplift cannot be
 * established, no scaled figure is produced at all. A partially-applied multiplier
 * is worse than no answer, because it looks like a complete one.
 */
export function resolveRequestLayer(input: RequestLayerInput): RequestLayerResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  const tier = resolveServiceTier(input.tier_profiles, input.options.service_tier, input.options.region);
  if (tier.status === 'UNAVAILABLE') {
    reasons.push(tier.reason);
    warnings.push(tier.warning);
  }

  const residency = residencyUplift(input.compliance, input.options.region);
  if (residency.status === 'UNAVAILABLE') reasons.push(residency.reason);

  if (tier.status === 'UNAVAILABLE' || residency.status === 'UNAVAILABLE') {
    return { status: 'UNAVAILABLE', reasons, warnings };
  }

  if (residency.applies) {
    notes.push(
      `The ${input.options.region} endpoint carries a ${(residency.uplift_pct * 100).toFixed(2)}% uplift on every category, cache reads and writes included. The compliant route is not the default price (§A5.10).`,
    );
  }

  const toolSystem = toolUseSystemPromptTokens(input.rates, input.options.tool_choice_mode);
  if (toolSystem.status === 'UNAVAILABLE') notes.push(toolSystem.reason);

  const serverTools = serverToolFees(
    input.rates.server_tool_fees,
    input.options.server_tools,
    input.executions ?? 1,
  );
  warnings.push(...serverTools.warnings);
  notes.push(...serverTools.notes);
  for (const u of serverTools.unpriced) notes.push(u.reason);

  return {
    status: 'OK',
    multipliers: {
      service_tier: input.options.service_tier,
      service_tier_multiplier: tier.multiplier,
      service_tier_confidence: tier.confidence,
      region: input.options.region,
      residency_uplift_pct: residency.uplift_pct,
      residency_confidence: residency.confidence,
    },
    tool_system_prompt: toolSystem,
    server_tools: serverTools,
    warnings,
    notes,
  };
}

/** Total server-tool cost as a degenerate range — these calls are counted, not sampled. */
export const serverToolCost = (charges: readonly ServerToolCharge[]): Range =>
  exactRange(charges.reduce((a, c) => a + c.billable_calls * c.amount_per_call, 0));
