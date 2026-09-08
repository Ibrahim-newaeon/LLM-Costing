// /packages/router/src/gate.ts
//
// §A7's capability gate — drop models lacking required modality, tools, context
// or residency, BEFORE ranking.
//
// The contract this file is written against is one sentence in estimate.ts:
//
//   "a router that silently drops the cheapest option is indistinguishable from
//    one that is wrong about the price"
//
// So every drop produces an `ExcludedModel` with a reason, and — the part that is
// easy to skip — every check that could NOT be performed produces an
// `UnverifiedCheck`. A gate that cannot read a model's context window and passes it
// anyway has not gated it; saying so is the difference between a pass and an
// unexamined pass.
//
// Spec anchors: §A7 (the gate) · §A6 (residency) · §A4.2 (staleness)

import {
  rankingEligibility,
  rateFreshness,
  rateInForce,
  type ExcludedModel,
  type ExclusionReason,
  type ModelRow,
  type Task,
} from '@tokenomics/contracts';

/** A check the gate was asked to make and could not. Not a pass. */
export interface UnverifiedCheck {
  model_id: string;
  check: 'context_window' | 'residency' | 'rate_validity';
  why: string;
}

export interface GateInput {
  models: readonly ModelRow[];
  tasks: readonly Task[];
  /**
   * Estimated input tokens per task, when the estimator has produced them. Absent
   * entries mean the context check cannot run for that task — reported, not passed.
   */
  input_tokens_by_task?: Readonly<Record<string, number>>;
  /** The date being priced. Rates are checked for validity AT this instant. */
  at?: Date;
}

export interface GateResult {
  eligible: ModelRow[];
  excluded: ExcludedModel[];
  unverified: UnverifiedCheck[];
}

const exclude = (
  model_id: string,
  reason: ExclusionReason,
  detail: string,
): ExcludedModel => ({ model_id, reason, detail });

/**
 * Which input modalities the workflow actually requires.
 *
 * Read off the tasks rather than asked for separately, because the analyzer has
 * already made these decisions and a second source would drift from it.
 */
function requiredModalities(tasks: readonly Task[]): Set<string> {
  const need = new Set<string>(['text']);
  for (const t of tasks) {
    if (t.flags.requires_vision || t.image_metrics !== null) need.add('image');
    if (t.media_metrics !== null) need.add(t.media_metrics.modality);
  }
  return need;
}

export function capabilityGate(input: GateInput): GateResult {
  const { models, tasks } = input;
  const at = input.at ?? new Date();
  const eligible: ModelRow[] = [];
  const excluded: ExcludedModel[] = [];
  const unverified: UnverifiedCheck[] = [];

  const needed = requiredModalities(tasks);
  const needsTools = tasks.some((t) => t.flags.requires_tool_calling);
  const residency = tasks
    .map((t) => t.flags.data_residency_constraint)
    .find((r): r is string => r !== null);

  for (const m of models) {
    // ── modality ──────────────────────────────────────────────────────────────
    const missing = [...needed].filter((mod) => !m.modalities_in.includes(mod as never));
    if (missing.length > 0) {
      excluded.push(
        exclude(m.model_id, 'MISSING_MODALITY', `Workflow needs ${missing.join(', ')}.`),
      );
      continue;
    }

    // ── tools ─────────────────────────────────────────────────────────────────
    if (needsTools && !m.supports_tools) {
      excluded.push(exclude(m.model_id, 'NO_TOOL_SUPPORT', 'A task requires tool calling.'));
      continue;
    }

    // ── residency ─────────────────────────────────────────────────────────────
    if (residency !== undefined) {
      if (!m.compliance.data_residency_region.includes(residency)) {
        excluded.push(
          exclude(
            m.model_id,
            'DATA_RESIDENCY_BLOCKED',
            `Stated constraint '${residency}'; this model lists ${m.compliance.data_residency_region.join(', ')}.`,
          ),
        );
        continue;
      }
    }

    // ── context window ────────────────────────────────────────────────────────
    // Not excluding on an unknown window, but not calling it a pass either. The
    // Gemini row is exactly this case: Google's spec tables are JS-rendered and
    // the window was never fetched, so the check is unperformed rather than clean.
    const window = m.context_window.value;
    const estimates = input.input_tokens_by_task ?? {};
    if (window === null) {
      unverified.push({
        model_id: m.model_id,
        check: 'context_window',
        why: 'context_window is UNAVAILABLE on this row, so the request may not fit and nothing here can tell.',
      });
    } else {
      const overflowing = tasks.find((t) => (estimates[t.task_id] ?? 0) > window);
      if (overflowing !== undefined) {
        excluded.push(
          exclude(
            m.model_id,
            'CONTEXT_TOO_SMALL',
            `Task ${overflowing.task_id} needs ${estimates[overflowing.task_id]} tokens; window is ${window}.`,
          ),
        );
        continue;
      }
      const unmeasured = tasks.filter((t) => estimates[t.task_id] === undefined);
      if (unmeasured.length > 0) {
        unverified.push({
          model_id: m.model_id,
          check: 'context_window',
          why: `No token estimate for ${unmeasured.map((t) => t.task_id).join(', ')}, so the fit was not checked.`,
        });
      }
    }

    // ── row-level: can this row produce a number at ALL ───────────────────────
    // Deliberately AFTER the capability checks, following §A7's own pipeline
    // (Capability Gate → Estimator → Pricing Resolver). Both failures exclude the
    // model, but the capability one is the more actionable report: fixing a missing
    // rate does not make a text-only model see, so naming the rate first would send
    // the reader after the wrong thing.
    const rowLevel = rankingEligibility(m);
    if (!rowLevel.eligible) {
      const mapped: Partial<Record<string, ExclusionReason>> = {
        SUBSCRIPTION_NON_COMPARABLE: 'RATE_MISSING',
        VISION_GEOMETRY_UNAVAILABLE: 'ASSET_EXCEEDS_CONSTRAINTS',
        NO_USABLE_RATE: 'RATE_MISSING',
        TOKENIZER_UNAVAILABLE: 'TOKENIZER_UNAVAILABLE',
      };
      // A vision-geometry refusal only matters if the workflow needs vision — the
      // Gemini row is text-rankable and vision-blocked at the same time.
      const relevant = rowLevel.reasons.filter(
        (r) => r !== 'VISION_GEOMETRY_UNAVAILABLE' || needed.has('image'),
      );
      if (relevant.length > 0) {
        const first = relevant[0]!;
        excluded.push(
          exclude(m.model_id, mapped[first] ?? 'RATE_MISSING', `Row-level: ${relevant.join(', ')}.`),
        );
        continue;
      }
    }

    // ── rate validity and staleness ───────────────────────────────────────────
    // Two independent questions (see pricing.ts): does a rate APPLY to the date
    // being priced, and was it CHECKED recently enough to trust.
    let blocked = false;
    for (const profile of m.text_rates) {
      const outputs = [profile.output_rate];
      const inForce = rateInForce(outputs, at);
      if (inForce.status === 'NONE_IN_FORCE') {
        excluded.push(exclude(m.model_id, 'RATE_MISSING', inForce.reason));
        blocked = true;
        break;
      }
      if (inForce.status === 'AMBIGUOUS') {
        unverified.push({ model_id: m.model_id, check: 'rate_validity', why: inForce.reason });
        continue;
      }
      const fresh = rateFreshness(inForce.rate, at);
      if (fresh === 'STALE') {
        excluded.push(
          exclude(m.model_id, 'RATE_STALE', 'The output rate is past its max_age_days (§A3.2).'),
        );
        blocked = true;
        break;
      }
      if (fresh === 'UNVERIFIED' || fresh === 'NO_POLICY') {
        unverified.push({
          model_id: m.model_id,
          check: 'rate_validity',
          why: `Rate freshness is ${fresh} — not stale, but not confirmed fresh either.`,
        });
      }
    }
    if (blocked) continue;

    eligible.push(m);
  }

  return { eligible, excluded, unverified };
}
