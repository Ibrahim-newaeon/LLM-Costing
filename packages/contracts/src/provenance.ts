// /packages/contracts/src/provenance.ts
//
// CANONICAL. Three definitions of Method and Confidence had drifted across
// registry.schema.ts, Annex A15 §11, and /schemas/estimate-output.schema.json.
// This file is the single source; the other two are deleted, not synced.
//
// Spec anchors: §A3.3 (every number traceable) · §A3.7 (confidence propagates by
// minimum) · §A3.8 (source class caps confidence, structurally).

import { z } from 'zod';

/* ─────────────────────────── method ─────────────────────────── */

/**
 * How a number was produced. Reconciled superset of the three prior enums.
 *
 *   was in registry.schema.ts │ A15 §11 │ estimate-output.json
 *   ──────────────────────────┼─────────┼─────────────────────
 *   TOKENIZER_SCALED     ✓    │    ✗    │  ✗   → kept, real distinct case
 *   MEASURED_BENCHMARK   ✗    │    ✗    │  ✓   → kept, distinct from DERIVED
 *   MEASURED_PROBE       ✗    │    ✗    │  ✗   → NEW; fit.ts had no method tag
 */
export const Method = z.enum([
  'EXACT_TOKENIZER',      // provider's own tokenizer, run locally            → HIGH
  'PROVIDER_COUNT_API',   // remote count endpoint (Anthropic, Gemini)        → HIGH
  'PROVIDER_FORMULA',     // vendor-documented image/video token formula      → HIGH
  'MEASURED_PROBE',       // geometry recovered by the §A4.6.1 probe, exact fit
  'MEASURED_BENCHMARK',   // throughput measured on YOUR hardware             → MEDIUM
  'TOKENIZER_SCALED',     // legacy tokenizer × a published/calibrated factor → MEDIUM
  'CALIBRATED_HEURISTIC', // generated ratio table, not a measurement         → MEDIUM/LOW
  'EXACT_PROXY',          // stand-in tokenizer from another family           → LOW
  'USER_SUPPLIED',        // typed by an operator, with an owner
  'DERIVED',              // computed; inherits the WEAKEST input's confidence
  'UNAVAILABLE',          // no data. Refusing to guess.
]);
export type Method = z.infer<typeof Method>;

/**
 * NONE existed only in registry.schema.ts. Kept, and given a rule:
 * NONE is reserved for UNAVAILABLE and is the only confidence it may carry.
 */
export const Confidence = z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']);
export type Confidence = z.infer<typeof Confidence>;

/** Where a rate came from. §A3.8 — AGGREGATOR can never yield HIGH. */
export const SourceClass = z.enum([
  'VENDOR_PAGE',   // read from the provider's own pricing/docs page
  'VENDOR_CONFIG', // read from the model's own config.json / model card
  'VENDOR_DOCS',   // provider documentation that is not the rate card
  'AGGREGATOR',    // LiteLLM, OpenRouter, comparison sites — capped below HIGH
  'MEASURED',      // produced by a harness in this repo (probe / calibration)
  'USER_ENTERED',  // admin override, with verified_by
]);
export type SourceClass = z.infer<typeof SourceClass>;

/* ─────────────────────────── provenance ─────────────────────────── */

export const Provenance = z
  .object({
    method: Method,
    confidence: Confidence,
    source_class: SourceClass,
    source_url: z.string().url().nullable(),
    verified_at: z.string().datetime().nullable(),
    verified_by: z.string().min(1).nullable().default(null),
    notes: z.string().nullable().default(null),
  })
  // §A3.8 — makes the aggregator caveat unrepresentable, not merely documented.
  // Empirical basis: on one verification pass roughly 1 aggregator rate in 3 was
  // wrong; several stale by a price change, one off by 5×.
  .refine((p) => !(p.source_class === 'AGGREGATOR' && p.confidence === 'HIGH'), {
    message: 'An AGGREGATOR-sourced value may not be HIGH confidence (§A3.8).',
    path: ['confidence'],
  })
  // NONE ⟺ UNAVAILABLE, in both directions. Resolves the drift where one enum
  // had NONE with no rule attached and two others omitted it entirely.
  .refine((p) => (p.method === 'UNAVAILABLE') === (p.confidence === 'NONE'), {
    message: 'confidence NONE is reserved for method UNAVAILABLE, and required by it.',
    path: ['confidence'],
  })
  // §A3.1 — every value except a refusal is traceable to something.
  .refine((p) => p.method === 'UNAVAILABLE' || p.source_url !== null, {
    message: 'Every value except UNAVAILABLE requires a source_url (§A3.1).',
    path: ['source_url'],
  })
  // A manual override without a named owner is an anonymous number.
  .refine((p) => p.source_class !== 'USER_ENTERED' || p.verified_by !== null, {
    message: 'USER_ENTERED requires verified_by — a human owns this number (§A4.2).',
    path: ['verified_by'],
  })
  // A proxy is structurally uncertain; no evidence can lift it above LOW.
  .refine((p) => p.method !== 'EXACT_PROXY' || p.confidence === 'LOW', {
    message: 'EXACT_PROXY is capped at LOW regardless of sample size (§A4.1 VERIFY #3).',
    path: ['confidence'],
  });
export type Provenance = z.infer<typeof Provenance>;

/* ─────────────────── rule 5 for a sourced CONSTANT ─────────────────── */

/**
 * Two or more readings of one constant that do not agree, kept side by side.
 *
 * Rule 5 — conflicts are reported, never merged — had exactly one home in the
 * contracts, `RateConflict` on `Rate`, and it is shaped for money: one competing
 * record, one competing amount, a signed delta. A vendor contradicting ITSELF about
 * a tokens-per-second, a tile size or a resolution limit fitted none of that, and so
 * could only be recorded as an absence (finding 3.15). Google's tokens page does
 * exactly this for video — 263 tokens/second in one paragraph, ~100/~300 in the
 * table below it, all labelled static — and "unpriced, reason unrecorded" was the
 * best the registry could say.
 *
 * This is the other home. Every `sourced()` value carries the slot, so the
 * disagreement sits on the field it is about rather than in a note somewhere else.
 * `value` stays whatever the reader could honestly commit to — usually null with
 * `UNAVAILABLE`, because a number chosen from among the candidates is a number
 * nobody published — and the candidates say why.
 *
 * Deliberately NOT a generalisation of `RateConflict`. That record answers "which
 * of two rows is right"; this one answers "what did the source actually say". The
 * ingest pipeline produces the first from a two-source diff and the second from a
 * single page that disagrees with itself, and folding them together would lose
 * which question is being asked.
 */
export const SourcedConflictCandidate = z.object({
  value: z.union([z.number(), z.string(), z.boolean()]),
  source_url: z.string().url(),
  retrieved_at: z.string().datetime(),
  /** Where on the page — a quoted phrase, a table caption. Null when not recorded. */
  locator: z.string().nullable().default(null),
});
export type SourcedConflictCandidate = z.infer<typeof SourcedConflictCandidate>;

export const SourcedConflict = z.object({
  candidates: z.array(SourcedConflictCandidate).min(2),
  /** A human decided. Until then every candidate is shown and `value` is not one of them. */
  resolved: z.boolean().default(false),
  notes: z.string().nullable().default(null),
});
export type SourcedConflict = z.infer<typeof SourcedConflict>;

/** Wrap any scalar so it cannot be rendered without its provenance. */
export const sourced = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({
    value: inner.nullable(),
    provenance: Provenance,
    /** Rule 5, on the field it is about. Null is "no disagreement recorded". */
    conflict: SourcedConflict.nullable().default(null),
  });

/**
 * The hand-written companion of `sourced()`. Two spellings of one shape, kept
 * because a generic type cannot be inferred from a Zod factory; `provenance.test.ts`
 * assigns a parsed `sourced()` value to this type and back so they cannot drift.
 */
export type Sourced<T> = {
  value: T | null;
  provenance: Provenance;
  conflict: SourcedConflict | null;
};

/* ─────────────────────── confidence propagation (§A3.7) ─────────────────────── */

const RANK: Record<Confidence, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

/**
 * Confidence is COMPUTED, never typed in.
 *
 *   line     = min(quantity, rate)
 *   task     = min over lines
 *   estimate = min over tasks
 *
 * A HIGH token count multiplied by an UNAVAILABLE rate is not a HIGH estimate —
 * it is not an estimate at all.
 */
export function minConfidence(...cs: Confidence[]): Confidence {
  if (cs.length === 0) return 'NONE';
  return cs.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

/** True when a computed confidence must block rather than render. */
export const blocksEstimate = (c: Confidence): boolean => c === 'NONE';

/**
 * Ceiling a source class imposes, before any other consideration.
 * Used by the ingestion pipeline so an aggregator row cannot be promoted later.
 */
export function confidenceCeiling(sc: SourceClass): Confidence {
  switch (sc) {
    case 'AGGREGATOR':
      return 'MEDIUM';
    default:
      return 'HIGH';
  }
}

export const UNAVAILABLE_PROVENANCE: Provenance = {
  method: 'UNAVAILABLE',
  confidence: 'NONE',
  source_class: 'VENDOR_DOCS',
  source_url: null,
  verified_at: null,
  verified_by: null,
  notes: 'No published figure. Refusing to guess (§A3.2).',
};
