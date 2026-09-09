// /packages/contracts/src/ingest.ts
//
// §A4.2 two-tier ingestion, §A6 — the records a pull of a pricing source leaves
// behind. Three of them, each answering one question:
//
//   Snapshot          what was read, from where, when, and its hash
//   Observation       one fact one source stated about one model
//   PriceChangeEvent  what moved between two snapshots of the same source
//
// Nothing here is a rate. A rate enters the registry through a human reading the
// vendor's own page; what this file describes is the EVIDENCE that a maintained
// registry is checked against, and the trail it leaves. Rule 5 lives one level
// down — `RateConflict` on `Rate` and `SourcedConflict` on every `sourced()` — and
// the ingest package produces those from the records here; it never averages.
//
// Spec anchors: §A4.2 (immutable snapshots, diff → PriceChangeEvent, two-source
// conflict → review) · §A4.3 (aggregator rows capped) · §A3.8 (AGGREGATOR ≠ HIGH).

import { z } from 'zod';
import { Provenance, SourceClass } from './provenance';
import { Currency, RateUnit, ServiceTier } from './pricing';

/* ─────────────────────────── snapshot ─────────────────────────── */

/**
 * One successful read of one source. Immutable: a new pull is a new snapshot,
 * never an update to this one (§A4.2 — "never UPDATE a rate"). A failed fetch
 * leaves no snapshot; there is nothing honest to record about a body that was
 * not received.
 *
 * `content_sha256` is what makes "unchanged since last pull" a fact rather than
 * a feeling, and it is deliberately NOT called `verified`. The prototype's
 * refresh script set `verified: true` when a price string appeared on a page,
 * and `docs/prototype-salvage.md` §2 records why that flag was stronger than its
 * evidence. A matching hash proves the bytes did not move. It does not prove
 * that any model has any price.
 */
export const Snapshot = z.object({
  /** `${source_id}@${retrieved_at}` — readable, sortable, and unique per pull. */
  snapshot_id: z.string().min(1),
  /** A short stable name for the source: `litellm`, `openrouter`, … */
  source_id: z.string().min(1),
  source_class: SourceClass,
  source_url: z.string().url(),
  retrieved_at: z.string().datetime(),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byte_length: z.number().int().nonnegative(),
});
export type Snapshot = z.infer<typeof Snapshot>;

/* ─────────────────────────── observation ─────────────────────────── */

/**
 * Which rate an observation is about, in the registry's own vocabulary.
 *
 * `above_tokens` is the context-tier boundary a figure applies ABOVE (§A5.7);
 * null is the base tier. `modality` is null for output — a model has one output
 * rate, and the estimator's `input_rate_by_modality` keys are the only input
 * modalities a rate can be keyed by.
 */
export const RateKey = z.object({
  direction: z.enum(['input', 'output', 'cache_write', 'cache_read', 'reasoning_output']),
  modality: z.enum(['text', 'image', 'audio', 'video']).nullable(),
  variant: ServiceTier.default('standard'),
  above_tokens: z.number().int().positive().nullable().default(null),
});
export type RateKey = z.infer<typeof RateKey>;

const observationBase = {
  /** Registry `model_id` this is about — mapped by the adapter, never guessed. */
  model_id: z.string().min(1),
  snapshot_id: z.string().min(1),
  /** The key the SOURCE used, kept so a mapping can be audited. */
  source_key: z.string().min(1),
  provenance: Provenance,
};

/**
 * One fact one source stated. A discriminated union, because the three kinds are
 * compared against different registry fields by different rules and a single
 * `{field: string, value: unknown}` would push that knowledge into string matching.
 *
 *   RATE       a price — kept in the SOURCE's unit and currency. The comparison
 *              normalizes; the record does not, so an audit reads what was read.
 *   LIMIT      a context or output ceiling.
 *   LIFECYCLE  a deprecation date. Not a number, and never merged: an aggregator
 *              saying "deprecated 2026-10-20" is a claim for a human to check
 *              against the vendor's own page, not a field to write.
 */
export const RateObservation = z.object({
  ...observationBase,
  kind: z.literal('RATE'),
  key: RateKey,
  amount: z.number().nonnegative(),
  unit: RateUnit,
  currency: Currency,
});
export type RateObservation = z.infer<typeof RateObservation>;

export const LimitObservation = z.object({
  ...observationBase,
  kind: z.literal('LIMIT'),
  which: z.enum(['context_window', 'max_output']),
  value: z.number().int().positive(),
});
export type LimitObservation = z.infer<typeof LimitObservation>;

export const LifecycleObservation = z.object({
  ...observationBase,
  kind: z.literal('LIFECYCLE'),
  which: z.enum(['deprecation_date']),
  value: z.string().datetime(),
});
export type LifecycleObservation = z.infer<typeof LifecycleObservation>;

export const Observation = z.discriminatedUnion('kind', [
  RateObservation,
  LimitObservation,
  LifecycleObservation,
]);
export type Observation = z.infer<typeof Observation>;

/* ─────────────────────────── price change ─────────────────────────── */

/**
 * §A4.2 — "diff each pull against the prior snapshot and emit a PriceChangeEvent
 * when a rate moves". Both amounts are in the source's unit; a change is only
 * ever computed between two observations with the same unit and currency, so the
 * delta is a comparison of like with like or it is not emitted.
 *
 * ADDED and REMOVED are changes too: a model appearing in a source is a lead, and
 * one vanishing is the earliest signal of a withdrawal.
 */
export const PriceChangeEvent = z.object({
  model_id: z.string().min(1),
  key: RateKey,
  change: z.enum(['CHANGED', 'ADDED', 'REMOVED']),
  unit: RateUnit,
  currency: Currency,
  previous_amount: z.number().nonnegative().nullable(),
  current_amount: z.number().nonnegative().nullable(),
  /**
   * Signed, relative to the previous amount. Null for ADDED/REMOVED and when the
   * previous amount was zero — a move away from free has no finite percentage,
   * and inventing one would rank it below a 1% change (rule: handle a zero
   * denominator explicitly).
   */
  delta_pct: z.number().nullable(),
  previous_snapshot_id: z.string().min(1).nullable(),
  current_snapshot_id: z.string().min(1).nullable(),
});
export type PriceChangeEvent = z.infer<typeof PriceChangeEvent>;
