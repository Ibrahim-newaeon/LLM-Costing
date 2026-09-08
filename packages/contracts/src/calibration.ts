// /packages/contracts/src/calibration.ts
//
// The chars-per-token calibration table (§A4.1, §A4.5.4).
//
// This is the input Tier 3 runs on, and it is the most dangerous table in the
// system: a ratio measured on English prose, applied to Arabic, is wrong by a
// large factor, silently, and in a consistent direction. §A4.5.4 states the
// prohibition in prose. Here it is a parse error.
//
// Spec anchors: §A4.5.4 (the constant you may not generalize) · §A4.1 (calibration
// replaces seeds automatically) · §A3.2 (refuse rather than invent)

import { z } from 'zod';
import { Provenance } from './provenance';
import { SeedProvenance } from './assumption';
import { Script } from './vision';
import { ContentType, OutputBand } from './workflow';

/* ─────────────────────────── the bucket key ─────────────────────────── */

/**
 * A calibration row is keyed by SCRIPT and CONTENT TYPE, per model.
 *
 * `Script` is reused deliberately — it is already the calibration-bucket
 * vocabulary (`ar_msa`, `ar_dialect`, `ar_vocalized`, `zh_hans`, `zh_hant`, …),
 * finer than the coarse `ScriptFamily` proportions a document reports. A document
 * that is 30% Arabic is measured in families; the ratio it is priced with is
 * measured in buckets, because vocalized and unvocalized Arabic do not tokenize
 * alike.
 */
export const CalibrationBucket = z.object({
  script: Script,
  content_type: ContentType,
});
export type CalibrationBucket = z.infer<typeof CalibrationBucket>;

/** Scripts for which §A4.5.4 states no bootstrap value exists in the spec. */
const NO_BOOTSTRAP: ReadonlySet<Script> = new Set<Script>([
  'ar_msa',
  'ar_dialect',
  'ar_vocalized',
  'zh_hans',
  'zh_hant',
  // 'mixed' too: a mixture containing an uncalibrated script is uncalibrated.
  'mixed',
]);

/** True where a SEED_UNCALIBRATED bootstrap ratio is forbidden outright. */
export const bootstrapForbidden = (script: Script): boolean => NO_BOOTSTRAP.has(script);

/* ─────────────────────────── the row ─────────────────────────── */

export const TextCalibration = z
  .object({
    model_id: z.string().min(1),
    bucket: CalibrationBucket,
    /**
     * TOKENS PER CHARACTER, not characters per token.
     *
     * The human-facing figure in §A4.5.4 is "≈3.5–4 characters per token", which
     * is the reciprocal — roughly 0.25 to 0.29 tokens per character. Stored this
     * way round on purpose: cost rises with tokens, so p90 here is the expensive
     * end. Under chars-per-token the percentiles inverfor cost, and a reader
     * reaching for "the p90" would pick the cheap one. The unit that matches the
     * direction of the risk is the unit to store.
     */
    tokens_per_char: z
      .object({
        p50: z.number().positive(),
        p90: z.number().positive(),
      })
      .refine((r) => r.p90 >= r.p50, {
        message: 'p90 tokens-per-char must be >= p50 — p90 is the expensive end.',
        path: ['p90'],
      }),
    /** Observations behind the row. Zero means this is a seed, not a measurement. */
    n_samples: z.number().int().nonnegative(),
    seed_provenance: SeedProvenance.nullable().default(null),
    provenance: Provenance,
  })
  .superRefine((c, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // §A4.5.4, made structural. "No bootstrap value exists in this document" for
    // Arabic or Chinese — so a seed row for those scripts cannot be constructed at
    // all. Applying the English ratio to Arabic is the failure the whole section
    // exists to prevent, and prose could only ask people not to do it.
    if (c.seed_provenance === 'SEED_UNCALIBRATED' && bootstrapForbidden(c.bucket.script)) {
      err(
        `No bootstrap chars-per-token value exists for ${c.bucket.script} (§A4.5.4). ` +
          'Tier 3 returns UNAVAILABLE for this bucket until it is calibrated from observed runs; ' +
          'the UI shows a character count instead. A blank token field is honest, a wrong one is not.',
        ['seed_provenance'],
      );
    }

    // A row with no observations behind it IS a seed, whatever it calls itself.
    if (c.n_samples === 0 && c.seed_provenance === null) {
      err(
        'A calibration row with zero samples must declare its seed_provenance — it is a seed, ' +
          'not a measurement, and everything loaded from defaults_seed is SEED_UNCALIBRATED + LOW.',
        ['seed_provenance'],
      );
    }

    // §A4.5.4's uniform rule: seeds are LOW, and confidence rises only when the
    // calibration table replaces them, never by assertion.
    if (c.seed_provenance === 'SEED_UNCALIBRATED' && c.provenance.confidence !== 'LOW') {
      err(
        'Everything loaded from defaults_seed is SEED_UNCALIBRATED and LOW. Confidence rises when ' +
          'samples replace the seed, never by assertion (§A4.5.4).',
        ['provenance', 'confidence'],
      );
    }

    // A measured row claiming to be measured needs samples to have measured.
    if (c.seed_provenance === 'CALIBRATED_FROM_OBSERVED' && c.n_samples === 0) {
      err('CALIBRATED_FROM_OBSERVED with zero samples is a seed wearing a better label.', [
        'n_samples',
      ]);
    }
  });
export type TextCalibration = z.infer<typeof TextCalibration>;

/**
 * Find the row for a bucket. Exact match only — **never interpolate**.
 *
 * There is no defensible way to derive an Arabic ratio from a Latin one, or a code
 * ratio from a prose one. A miss is a miss, and the caller's job is to refuse with
 * a `missing_data[]` entry naming the bucket, not to reach for the nearest row.
 */
export function findCalibration(
  table: readonly TextCalibration[],
  model_id: string,
  bucket: CalibrationBucket,
): TextCalibration | null {
  return (
    table.find(
      (c) =>
        c.model_id === model_id &&
        c.bucket.script === bucket.script &&
        c.bucket.content_type === bucket.content_type,
    ) ?? null
  );
}

/* ─────────────────────────── output priors (§A5.4) ─────────────────────────── */

/**
 * The non-deterministic half. You cannot know output length before the call, so it
 * is a DISTRIBUTION, keyed by the band the analyzer picked.
 *
 * §A5.4 is explicit that each prior is "calibrated from observed runs, not
 * invented", and that for any model flagged `is_reasoning_model` a reasoning term is
 * MANDATORY. Reasoning tokens are invisible in the response body but billed, so an
 * estimate that omits them is wrong by however much the model thought — which on a
 * reasoning model is frequently the larger half of the bill.
 *
 * `reasoning_tokens` is therefore nullable ONLY for non-reasoning models, and the
 * estimator refuses a reasoning model whose prior leaves it null rather than
 * treating the invisible term as zero.
 */
export const OutputPrior = z
  .object({
    model_id: z.string().min(1),
    band: OutputBand,
    output_tokens: z
      .object({ p50: z.number().nonnegative(), p90: z.number().nonnegative() })
      .refine((r) => r.p90 >= r.p50, { message: 'p90 must be >= p50.', path: ['p90'] }),
    /**
     * Null means "this model does not reason", not "reasoning is free". Populated
     * from `usage.completion_tokens_details` (or the provider's equivalent) on real
     * responses — which is why §A5.4 says to wire that capture from day one.
     */
    reasoning_tokens: z
      .object({ p50: z.number().nonnegative(), p90: z.number().nonnegative() })
      .refine((r) => r.p90 >= r.p50, { message: 'p90 must be >= p50.', path: ['p90'] })
      .nullable()
      .default(null),
    n_samples: z.number().int().nonnegative(),
    seed_provenance: SeedProvenance.nullable().default(null),
    provenance: Provenance,
  })
  .superRefine((p, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    if (p.n_samples === 0 && p.seed_provenance === null) {
      err(
        'A prior with zero observations must declare its seed_provenance. §A5.4 requires priors ' +
          'calibrated from observed runs; an undeclared one is an invented number.',
        ['seed_provenance'],
      );
    }
    if (p.seed_provenance === 'SEED_UNCALIBRATED' && p.provenance.confidence !== 'LOW') {
      err('Seeds are LOW until samples replace them, never by assertion (§A4.5.4).', [
        'provenance', 'confidence',
      ]);
    }
    if (p.seed_provenance === 'CALIBRATED_FROM_OBSERVED' && p.n_samples === 0) {
      err('CALIBRATED_FROM_OBSERVED with zero samples is a seed wearing a better label.', [
        'n_samples',
      ]);
    }
    // An unbounded band has no upper end by definition, so a p90 equal to p50 is
    // claiming a certainty the band denies.
    if (p.band === 'unbounded' && p.output_tokens.p90 === p.output_tokens.p50) {
      err(
        'An unbounded output band with a zero-width distribution is a contradiction — the band ' +
          'exists to say the length is not pinned down.',
        ['output_tokens', 'p90'],
      );
    }
  });
export type OutputPrior = z.infer<typeof OutputPrior>;

/** Exact-match lookup. Same rule as the text table: never interpolate a band. */
export function findOutputPrior(
  table: readonly OutputPrior[],
  model_id: string,
  band: OutputBand,
): OutputPrior | null {
  return table.find((p) => p.model_id === model_id && p.band === band) ?? null;
}
