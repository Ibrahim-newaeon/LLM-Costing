// /packages/router/src/index.ts
//
// §A7's last box: [Router] → [Recommendations].
//
// Pure, like the estimator: no I/O, no clock beyond an injected date, no registry
// lookups. Candidates and rows arrive as arguments, so a recommendation is
// reproducible from its inputs — which is the whole reason §A7 demands a
// `Rationale` on every one of them.
//
//   [Capability Gate]  gate.ts   — drop, and SAY WHY, before ranking
//   [Router]           rank.ts   — three objectives, or an honest null
//                      split.ts  — per-task assignment vs a real baseline
//
// The three objectives are not symmetrical in practice. Cheapest needs only
// complete estimates; Best-Capability and Balanced need a sourced `quality_score`,
// and §A6 forbids inventing one. With today's registry both come back null with a
// reason, and that is the correct output rather than a gap to paper over.

export * from './gate';
export * from './rank';
export * from './split';

import { capabilityGate, type GateInput, type GateResult } from './gate';
import { rank, type RankInput } from './rank';
import { splitRoute, type TaskCandidates } from './split';
import type { EstimateWarning, ExcludedModel, Recommendations } from '@tokenomics/contracts';

export interface RouteInput extends GateInput {
  /** Whole-workflow candidates, one per surviving model. */
  candidates: RankInput['candidates'];
  /** Per-task candidates, for the split. Omit to skip split routing. */
  per_task?: readonly TaskCandidates[];
  quality_by_model?: RankInput['quality_by_model'];
}

export interface RouteResult {
  recommendations: Recommendations;
  /** Every model that did not reach the ranking, and why. */
  excluded: ExcludedModel[];
  /** Checks the gate could not perform. Not passes. */
  unverified: GateResult['unverified'];
  /** Why an objective is null, and anything the split could not conclude. */
  notes: string[];
  /**
   * Coded warnings about models that PASSED the gate. A deprecated model is still
   * callable and may still be the cheapest, so it is ranked — and the caller is
   * told, because a recommendation with an announced shutdown date is a migration
   * nobody agreed to.
   */
  warnings: EstimateWarning[];
}

/**
 * Gate, rank, split — in that order, because §A7 puts the gate before the
 * estimator and ranking a model that was never eligible wastes the estimate and
 * risks recommending it.
 *
 * Exclusions from both stages are concatenated rather than merged: a model dropped
 * for residency and a model dropped for an unfinished estimate are different
 * failures, and collapsing them would hide which one a fix should target.
 */
export function route(input: RouteInput): RouteResult {
  const gated = capabilityGate(input);
  const eligibleIds = new Set(gated.eligible.map((m) => m.model_id));

  // Candidates for models the gate removed are not ranked. If a caller estimated
  // them anyway, that is their cost to have paid, not a reason to rank them.
  const ranked = rank({
    candidates: input.candidates.filter((c) => eligibleIds.has(c.model_id)),
    quality_by_model: input.quality_by_model,
  });

  const notes = ranked.unrankable.map((u) => `${u.objective}: ${u.why}`);

  let split = null;
  if (input.per_task !== undefined) {
    const s = splitRoute(
      input.per_task.map((t) => ({
        task_id: t.task_id,
        candidates: t.candidates.filter((c) => eligibleIds.has(c.model_id)),
      })),
    );
    split = s.split;
    notes.push(...s.notes);
  }

  return {
    recommendations: {
      cheapest: ranked.cheapest,
      best_capability: ranked.best_capability,
      balanced: ranked.balanced,
      split_routing: split,
    },
    excluded: [...gated.excluded, ...ranked.excluded],
    unverified: gated.unverified,
    notes,
    warnings: gated.warnings,
  };
}
