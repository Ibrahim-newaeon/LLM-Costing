// /packages/router/src/rank.ts
//
// §A7 — "rank under three objectives", Cheapest | Best-Capability | Balanced.
//
// ── The thing this file exists to prevent ────────────────────────────────────
//
// `assembleCandidate` sums a refusal line as zero, because `EstimateLine.cost` is
// null on a refusal and the reduce treats null as 0. A candidate whose every line
// refused therefore has `total_cost.p50 === 0` — and a naive `sort by p50` puts the
// model nothing could price **first, at $0.00**.
//
// That is not a hypothetical. Both rows in the registry today refuse on some path:
// Anthropic on text without tier 1, Google on vision. A cheapest-by-total router
// would have recommended whichever one failed hardest.
//
// So the first thing here is not a comparison, it is a filter: a candidate is
// rankable only if it is COMPLETE. `Candidate.confidence` already carries this —
// it is the minimum over the lines, and a refusal line is NONE — so one check
// covers it, and it is the same check §A3.7 already enforces.
//
// ── And the second thing ─────────────────────────────────────────────────────
//
// Two candidates in different currencies are not comparable by number. §A4.2 makes
// the native currency the source of truth precisely so that nobody silently
// compares a CNY figure against a USD one. Ranking refuses rather than converting.

import {
  type Candidate,
  type ExcludedModel,
  type Rationale,
  type Recommendation,
} from '@tokenomics/contracts';

export interface RankInput {
  candidates: readonly Candidate[];
  /**
   * Quality scores by model id, from `ModelRow.quality_score`. §A6: "do NOT invent
   * benchmark scores" — a model with no sourced score is absent from this map, and
   * absence is why an objective can come back null.
   */
  quality_by_model?: Readonly<Record<string, number>>;
}

export interface RankResult {
  cheapest: Recommendation | null;
  best_capability: Recommendation | null;
  balanced: Recommendation | null;
  /** Candidates removed at ranking time, with the reason. */
  excluded: ExcludedModel[];
  /** Why an objective came back null, when it did. */
  unrankable: Array<{ objective: 'cheapest' | 'best_capability' | 'balanced'; why: string }>;
}

const rationale = (
  metric: string,
  observed: unknown,
  threshold: unknown,
  evidence: string | null = null,
): Rationale => ({
  triggering_metric: metric,
  observed_value: observed,
  threshold,
  evidence_ref: evidence,
});

/**
 * A candidate may be ranked only if its estimate FINISHED.
 *
 * `confidence === 'NONE'` means some line refused (§A3.7 floors the candidate at
 * the weakest line, and a refusal is NONE) or that there are no lines at all. In
 * both cases `total_cost` is a lower bound, not a price, and comparing a lower
 * bound against a complete total is how the unpriceable option wins.
 */
export function isRankable(c: Candidate): boolean {
  return c.confidence !== 'NONE' && c.lines.length > 0;
}

/**
 * Deterministic ordering. Cost first, then `model_id` lexicographically.
 *
 * The tiebreak is not cosmetic: without it, two candidates at the same price are
 * ordered by their position in the registry file, so re-sorting the registry would
 * change the recommendation. A recommendation that moves when nothing about the
 * models moved is one nobody can reproduce.
 */
const byCostThenId = (a: Candidate, b: Candidate): number =>
  a.total_cost.p50 !== b.total_cost.p50
    ? a.total_cost.p50 - b.total_cost.p50
    : a.model_id < b.model_id
      ? -1
      : a.model_id > b.model_id
        ? 1
        : 0;

/**
 * The rate record behind the biggest line — the one a reader would check first if
 * they doubted the recommendation.
 *
 * `pricing_snapshot_id` lives on `EstimateOutput`, one level up, so the candidate
 * itself can only point at the rate that dominated it. Null when no line names one,
 * which is honest: the rationale then says where the number came from and not which
 * record to audit.
 */
function dominantRateRef(c: Candidate): string | null {
  const priced = c.lines.filter((l) => l.cost !== null && l.rate_record_id !== null);
  if (priced.length === 0) return null;
  return priced.reduce((a, b) => (b.cost!.p50 > a.cost!.p50 ? b : a)).rate_record_id;
}

export function rank(input: RankInput): RankResult {
  const excluded: ExcludedModel[] = [];
  const unrankable: RankResult['unrankable'] = [];

  const complete: Candidate[] = [];
  for (const c of input.candidates) {
    if (isRankable(c)) {
      complete.push(c);
      continue;
    }
    const refused = c.lines.filter((l) => l.method === 'UNAVAILABLE').map((l) => l.component);
    excluded.push({
      model_id: c.model_id,
      reason: 'ESTIMATE_INCOMPLETE',
      detail:
        c.lines.length === 0
          ? 'No estimate lines were produced for this candidate.'
          : `Refused on ${refused.join(', ')}. Its total is a lower bound, not a price — ranking it against complete totals would put the least priceable option first.`,
    });
  }

  // ── currencies must match, or the numbers do not mean the same thing ────────
  const currencies = new Set(complete.map((c) => c.currency));
  if (currencies.size > 1) {
    const why =
      `Candidates are priced in ${[...currencies].sort().join(', ')}. §A4.2 keeps the vendor's ` +
      'native currency as the source of truth, so ranking would need a dated FX record; comparing ' +
      'the raw numbers would silently rank on an exchange rate nobody recorded.';
    return {
      cheapest: null,
      best_capability: null,
      balanced: null,
      excluded,
      unrankable: [
        { objective: 'cheapest', why },
        { objective: 'best_capability', why },
        { objective: 'balanced', why },
      ],
    };
  }

  if (complete.length === 0) {
    const why = 'No candidate produced a complete estimate.';
    return {
      cheapest: null,
      best_capability: null,
      balanced: null,
      excluded,
      unrankable: [
        { objective: 'cheapest', why },
        { objective: 'best_capability', why },
        { objective: 'balanced', why },
      ],
    };
  }

  const sorted = [...complete].sort(byCostThenId);

  // ── 1. cheapest ─────────────────────────────────────────────────────────────
  const cheapestC = sorted[0]!;
  const runnerUp = sorted[1] ?? null;
  const cheapest: Recommendation = {
    model_id: cheapestC.model_id,
    deployment_mode: cheapestC.deployment_mode,
    total_cost: cheapestC.total_cost,
    rationale: rationale(
      'total_cost.p50',
      cheapestC.total_cost.p50,
      runnerUp === null
        ? 'only complete candidate'
        : `next cheapest ${runnerUp.model_id} at ${runnerUp.total_cost.p50}`,
      dominantRateRef(cheapestC),
    ),
  };

  // ── 2. best capability ──────────────────────────────────────────────────────
  // §A6 forbids inventing benchmark scores, and `quality_score` is null unless
  // sourced. With no scores there is no capability ordering — and a router that
  // substituted "most expensive" or "largest context" here would be inventing the
  // ranking §A6 exists to prevent.
  const quality = input.quality_by_model ?? {};
  const scored = sorted.filter((c) => quality[c.model_id] !== undefined);

  let best_capability: Recommendation | null = null;
  if (scored.length === 0) {
    unrankable.push({
      objective: 'best_capability',
      why:
        'No candidate carries a sourced quality_score. §A6 forbids inventing benchmark scores, and ' +
        'ranking on price or context size instead would be a capability claim derived from neither.',
    });
  } else {
    const top = scored.reduce((a, b) =>
      quality[b.model_id]! > quality[a.model_id]! ? b : a,
    );
    best_capability = {
      model_id: top.model_id,
      deployment_mode: top.deployment_mode,
      total_cost: top.total_cost,
      rationale: rationale('quality_score', quality[top.model_id], 'highest sourced score'),
    };
    if (scored.length < sorted.length) {
      unrankable.push({
        objective: 'best_capability',
        why: `Ranked over ${scored.length} of ${sorted.length} candidates; the rest carry no sourced quality_score and were not considered.`,
      });
    }
  }

  // ── 3. balanced ─────────────────────────────────────────────────────────────
  // Cost per unit of quality. Needs both, so it inherits the same refusal.
  let balanced: Recommendation | null = null;
  if (scored.length === 0) {
    unrankable.push({
      objective: 'balanced',
      why: 'Balanced is a cost-versus-quality tradeoff and there is no quality signal to trade against.',
    });
  } else if (scored.length === 1) {
    balanced = {
      model_id: scored[0]!.model_id,
      deployment_mode: scored[0]!.deployment_mode,
      total_cost: scored[0]!.total_cost,
      rationale: rationale(
        'cost_per_quality_point',
        scored[0]!.total_cost.p50 / quality[scored[0]!.model_id]!,
        'only scored candidate',
      ),
    };
  } else {
    const ratio = (c: Candidate) => c.total_cost.p50 / quality[c.model_id]!;
    const top = [...scored].sort((a, b) => {
      const d = ratio(a) - ratio(b);
      return d !== 0 ? d : a.model_id < b.model_id ? -1 : 1;
    })[0]!;
    balanced = {
      model_id: top.model_id,
      deployment_mode: top.deployment_mode,
      total_cost: top.total_cost,
      rationale: rationale(
        'cost_per_quality_point',
        ratio(top),
        'lowest cost per sourced quality point',
      ),
    };
  }

  return { cheapest, best_capability, balanced, excluded, unrankable };
}
