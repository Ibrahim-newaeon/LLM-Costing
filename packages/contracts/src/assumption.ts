// /packages/contracts/src/assumption.ts
//
// The SECOND axis.
//
// `provenance.ts` models where a number CAME FROM and how far to trust it.
// This file models what was GUESSED, and how far the answer moves if the guess is
// wrong. They are not the same question and neither substitutes for the other: a
// figure can be HIGH-confidence about a quantity that was invented wholesale, and
// the user needs to see both facts.
//
// Project rule 2 — guess quantities, never guess rates — is only visible to a user
// through this file. `sensitivity_rank` is what orders the tornado chart.
//
// Spec anchors: §A4.4.4 (quantities vs rates) · §A3.2 (refuse rather than invent)
//
// Reconciles two prior definitions that had ALREADY drifted, neither with Zod
// behind it:
//
//   /schemas/workflow-input.schema.json   `assumed_value` + `seed_provenance`
//   /schemas/estimate-output.schema.json  `value` + `id` + `sensitivity_rank`
//
// One definition, superset, keyed on `value` (2026-09-07 decision). The analyzer
// leaves `sensitivity_rank` null because ranking requires prices it does not have;
// the estimator fills it. Neither side gets its own copy of the type.

import { z } from 'zod';
import type { Confidence } from './provenance';

/* ─────────────────────────── the two impact scales ─────────────────────────── */

// These two enums share the member ORDER_OF_MAGNITUDE and nothing else, and
// `docs/drift-sweep.md` §5c's suggestion to "reconcile" them is withdrawn here:
// they attach to different objects and answer different questions.
//
//   Impact         — on Ambiguity.     The input admits more than one reading.
//                                      How much does picking wrong cost?
//   ImpactIfWrong  — on Assumption.    The input was silent and we supplied a
//                                      value. How much does that value move the
//                                      total?
//
// An ambiguity is a question for the user. An assumption is an answer we gave
// ourselves. Merging the scales would merge those, and the UI has to keep them
// apart: one gets asked, the other gets shown with an edit control.

/** Severity of an unresolved READING of the input. */
export const Impact = z.enum(['COSMETIC', 'MATERIAL', 'ORDER_OF_MAGNITUDE']);
export type Impact = z.infer<typeof Impact>;

/** Severity of a GUESSED quantity turning out wrong. */
export const ImpactIfWrong = z.enum(['LOW', 'MEDIUM', 'HIGH', 'ORDER_OF_MAGNITUDE']);
export type ImpactIfWrong = z.infer<typeof ImpactIfWrong>;

/* ─────────────────────────── seed calibration ─────────────────────────── */

/**
 * Where a default VALUE came from, as opposed to how confident we are in it.
 *
 * SEED_UNCALIBRATED is the honest label for a number somebody picked because the
 * table could not be empty. It is not a measurement and it must not decay into one
 * by sitting in the codebase long enough to look official.
 */
export const SeedProvenance = z.enum([
  'SEED_UNCALIBRATED',        // a baseline with no observed runs behind it → LOW
  'CALIBRATED_FROM_OBSERVED', // replaced from real runs of this workload
  'USER_SUPPLIED_BASELINE',   // the operator stated it for their own workload
]);
export type SeedProvenance = z.infer<typeof SeedProvenance>;

/** The `basis` string that marks a value as a seed default rather than a reading. */
export const DEFAULT_APPLIED = 'DEFAULT_APPLIED';

/* ─────────────────────────── assumption ─────────────────────────── */

export const Assumption = z
  .object({
    /** Stable id so `breakeven.assumptions_ref` and the UI can point at one. */
    id: z.string().min(1).nullable().default(null),
    /** Null when the assumption is workflow-wide rather than task-scoped. */
    task_id: z.string().min(1).nullable().default(null),
    field: z.string().min(1),
    /**
     * The assumed value itself. Deliberately untyped — it stands in for whatever
     * field it names, from an integer page count to a history strategy.
     */
    value: z.unknown(),
    /**
     * Why this value was chosen. `DEFAULT_APPLIED` for a seed baseline. Never
     * "typical" without a calibration reference — "typical" is a claim about a
     * population nobody measured.
     */
    basis: z.string().min(1),
    seed_provenance: SeedProvenance.nullable().default(null),
    impact_if_wrong: ImpactIfWrong,
    /**
     * False only where changing it would make the estimate incoherent. An
     * assumption the user cannot edit is a decision we made on their behalf and
     * did not tell them about.
     */
    user_editable: z.boolean().default(true),
    /**
     * 1 = moves total cost most. Drives the tornado chart.
     *
     * Null from the analyzer, which has no prices and therefore cannot rank; the
     * estimator fills it. Null means "not yet ranked", never "does not matter".
     */
    sensitivity_rank: z.number().int().min(1).nullable().default(null),
  })
  .superRefine((a, ctx) => {
    // z.unknown() permits an absent key. An assumption with no value is a claim
    // that we guessed, without saying what — worse than not recording it.
    if (!('value' in a) || a.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An assumption must carry the value that was assumed.',
        path: ['value'],
      });
    }
    // A seed baseline has to say so in `basis`, because `basis` is what the UI
    // renders. A SEED_UNCALIBRATED value described in prose as though it were
    // measured is the failure this field exists to make impossible.
    if (a.seed_provenance === 'SEED_UNCALIBRATED' && a.basis !== DEFAULT_APPLIED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A SEED_UNCALIBRATED assumption must state basis '${DEFAULT_APPLIED}'.`,
        path: ['basis'],
      });
    }
  });
export type Assumption = z.infer<typeof Assumption>;

/**
 * Ceiling an assumption imposes on the confidence of anything computed from it.
 * Mirrors `confidenceCeiling` in provenance.ts: the rule is executable, not just
 * documented, so it cannot be forgotten at one of the call sites.
 *
 *   SEED_UNCALIBRATED   → LOW     a number with no observations behind it
 *   basis DEFAULT_APPLIED → MEDIUM  we supplied it, but from a calibrated table
 *   otherwise           → HIGH    the assumption itself imposes no ceiling
 *
 * Note this is a CEILING, not a confidence. Feed it through `minConfidence`
 * alongside the quantity's and the rate's own confidences (§A3.7).
 */
export function assumptionConfidenceCeiling(a: Assumption): Confidence {
  if (a.seed_provenance === 'SEED_UNCALIBRATED') return 'LOW';
  if (a.basis === DEFAULT_APPLIED) return 'MEDIUM';
  return 'HIGH';
}

/**
 * §A4.4.4 — two stacked defaults cap at LOW even when each alone would be MEDIUM.
 * Guessing a page count from a guessed document class is not one assumption; the
 * errors multiply, and a MEDIUM label on that is a lie by arithmetic.
 */
export function stackedAssumptionCeiling(assumptions: Assumption[]): Confidence {
  const supplied = assumptions.filter(
    (a) => a.basis === DEFAULT_APPLIED || a.seed_provenance === 'SEED_UNCALIBRATED',
  );
  if (supplied.length === 0) return 'HIGH';
  if (supplied.length >= 2) return 'LOW';
  return assumptionConfidenceCeiling(supplied[0]!);
}

/* ─────────────────────────── ambiguity ─────────────────────────── */

/**
 * The input admits more than one reading and we did NOT pick one.
 *
 * Distinct from an assumption on purpose: an ambiguity is surfaced as a question,
 * because silently taking the cheaper reading is how an estimate flatters itself.
 */
export const Ambiguity = z.object({
  field: z.string().min(1),
  /** At least two, or it is not ambiguous. */
  readings: z.array(z.string().min(1)).min(2),
  impact: Impact,
});
export type Ambiguity = z.infer<typeof Ambiguity>;

/* ─────────────────────────── missing data ─────────────────────────── */

/**
 * Something needed that is not present. Superset of the two prior shapes, which
 * differed by which side was speaking: the analyzer asks the user a `question`,
 * the estimator explains `why_it_matters` about a specific model. One type, and a
 * rule that it must do at least one of the two — an entry that names a gap without
 * either asking about it or explaining it is unactionable.
 */
export const MissingDatum = z
  .object({
    field: z.string().min(1),
    task_id: z.string().min(1).nullable().default(null),
    model_id: z.string().min(1).nullable().default(null),
    /** Specific and answerable. "More detail needed" is not a question. */
    question: z.string().min(1).nullable().default(null),
    why_it_matters: z.string().min(1).nullable().default(null),
    /**
     * True blocks the estimate outright. §A3.2 — a blocking gap returns no number,
     * rather than a number with a caveat attached.
     */
    blocks_estimate: z.boolean(),
  })
  .refine((m) => m.question !== null || m.why_it_matters !== null, {
    message: 'A missing_data entry must either ask a question or say why it matters.',
    path: ['question'],
  });
export type MissingDatum = z.infer<typeof MissingDatum>;
