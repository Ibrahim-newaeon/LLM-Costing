// /packages/router/src/split.ts
//
// §A7 — "Split routing is a first-class output."
//
//   "The best answer is often 'cheap lightweight model for the 40 READ
//    classifications, frontier model for the 2 WRITE steps.' The router must
//    evaluate per-task assignment, not just one model for the whole workflow, and
//    report the saving versus single-model routing."
//
// Two things decide whether this function is honest.
//
// 1. The BASELINE has to be a real alternative. The saving is "versus single-model
//    routing", so the baseline is the cheapest model that can serve EVERY task —
//    not the cheapest per-task figure summed, and not the cheapest model overall
//    if it cannot do all the work. Where no single model covers the workflow,
//    there is no saving to report: split routing is not cheaper, it is the only
//    option, and saying "saved 100%" would be a fabrication.
//
// 2. Per-task candidates must be COMPLETE, for the same reason as in rank.ts. A
//    task-level estimate that refused totals zero, and the split would assign
//    every task to whichever model failed on it.

import { isRankable } from './rank';
import type { Candidate, Rationale, SplitRouting } from '@tokenomics/contracts';

/** One task's candidates, keyed by the task they price. */
export interface TaskCandidates {
  task_id: string;
  candidates: readonly Candidate[];
}

export interface SplitResult {
  split: SplitRouting | null;
  /** Set when a split could not be produced, or produced without a saving figure. */
  notes: string[];
}

const rationale = (
  metric: string,
  observed: unknown,
  threshold: unknown,
): Rationale => ({
  triggering_metric: metric,
  observed_value: observed,
  threshold,
  evidence_ref: null,
});

const cheapestOf = (cs: readonly Candidate[]): Candidate | null => {
  const complete = cs.filter(isRankable);
  if (complete.length === 0) return null;
  return complete.reduce((a, b) =>
    b.total_cost.p50 !== a.total_cost.p50
      ? b.total_cost.p50 < a.total_cost.p50
        ? b
        : a
      : b.model_id < a.model_id
        ? b
        : a,
  );
};

export function splitRoute(perTask: readonly TaskCandidates[]): SplitResult {
  const notes: string[] = [];

  if (perTask.length === 0) {
    return { split: null, notes: ['No tasks to route.'] };
  }

  // ── the per-task assignment ────────────────────────────────────────────────
  const assignments: SplitRouting['assignments'] = [];
  let splitTotal = 0;
  let complete = true;

  for (const t of perTask) {
    const pick = cheapestOf(t.candidates);
    if (pick === null) {
      complete = false;
      notes.push(
        `No complete estimate for task ${t.task_id}, so no model can be assigned to it. The split below, if any, does not cover the whole workflow.`,
      );
      continue;
    }
    const others = t.candidates.filter((c) => isRankable(c) && c.model_id !== pick.model_id);
    const next = others.length
      ? others.reduce((a, b) => (b.total_cost.p50 < a.total_cost.p50 ? b : a))
      : null;
    assignments.push({
      task_id: t.task_id,
      model_id: pick.model_id,
      rationale: rationale(
        'task_cost.p50',
        pick.total_cost.p50,
        next === null
          ? 'only complete candidate for this task'
          : `next cheapest ${next.model_id} at ${next.total_cost.p50}`,
      ),
    });
    splitTotal += pick.total_cost.p50;
  }

  if (!complete) {
    return {
      split:
        assignments.length > 0
          ? { assignments, total_cost_p50: null, saving_vs_single_model_pct: null }
          : null,
      notes: [
        ...notes,
        'total_cost_p50 is null because at least one task is unpriced; summing the rest would read as a workflow total.',
      ],
    };
  }

  // ── the baseline: the cheapest model that can serve EVERY task ─────────────
  const modelsPerTask = perTask.map(
    (t) => new Set(t.candidates.filter(isRankable).map((c) => c.model_id)),
  );
  const universal = [...modelsPerTask[0]!].filter((id) =>
    modelsPerTask.every((s) => s.has(id)),
  );

  if (universal.length === 0) {
    notes.push(
      'No single model can serve every task, so there is no single-model baseline to compare against. ' +
        'Split routing here is not a saving — it is the only arrangement that covers the workflow.',
    );
    return {
      split: {
        assignments,
        total_cost_p50: splitTotal,
        saving_vs_single_model_pct: null,
      },
      notes,
    };
  }

  const singleTotals = universal.map((id) => ({
    model_id: id,
    total: perTask.reduce((sum, t) => {
      const c = t.candidates.find((x) => x.model_id === id && isRankable(x))!;
      return sum + c.total_cost.p50;
    }, 0),
  }));
  const bestSingle = singleTotals.reduce((a, b) =>
    b.total !== a.total ? (b.total < a.total ? b : a) : b.model_id < a.model_id ? b : a,
  );

  // A split can never be more expensive than the best single model — it picks the
  // cheapest option per task, and the single model is one of those options. A
  // negative saving means a bug, not a finding, so it is worth stating rather than
  // rendering: the guard is in the test.
  const saving =
    bestSingle.total === 0 ? null : ((bestSingle.total - splitTotal) / bestSingle.total) * 100;

  if (saving === 0) {
    notes.push(
      `Split routing matches the best single model (${bestSingle.model_id}) exactly — the same model is cheapest for every task, so there is nothing to split.`,
    );
  }

  return {
    split: {
      assignments,
      total_cost_p50: splitTotal,
      saving_vs_single_model_pct: saving,
    },
    notes,
  };
}
