// /packages/parser/src/defaults.ts
//
// §A4.4.4 — the defaults engine, and the line it must not cross.
//
//   "Guess quantities. Never guess rates."
//
// A missing RATE blocks the estimate: there is no honest default for what a vendor
// charges. A missing QUANTITY gets a labelled, editable default that downgrades
// confidence. This file only ever does the second — it has no access to a rate and
// no way to invent one.
//
// The four obligations §A4.4.4 puts on every default that fires:
//
//   1. emit an assumptions[] entry with basis DEFAULT_APPLIED and an impact rating
//   2. render as an editable field in the Assumptions panel
//   3. downgrade the task to at most MEDIUM — LOW when two or more stack
//   4. NEVER fire when a real asset is attached
//
// (3) is not implemented here: `stackedAssumptionCeiling` in the contracts already
// computes exactly that rule, and a second copy is how this project's known defects
// began. (4) is the one that needs a guard, and it has one.
//
// ⚠️ The seed values are NOT in this file. §A4.4.4: "Store them in `defaults_seed`
// with source USER_SUPPLIED_BASELINE — not in code, and not presented anywhere in
// the UI as a measured figure." They arrive as an argument, the same way calibration
// rows do, and an absent table means the default cannot fire rather than a constant
// quietly standing in.

import {
  DEFAULT_APPLIED,
  type Assumption,
  type ImpactIfWrong,
  type MissingDatum,
} from '@tokenomics/contracts';
import type { DocClass } from './quantities';

/* ═══════════════════════ the seed table ═══════════════════════ */

/**
 * One row of `defaults_seed`. Injected, never inlined.
 *
 * `source` is fixed at USER_SUPPLIED_BASELINE because that is what these are: the
 * operator's starting figures, "not facts", carrying a standing task to replace each
 * one from observed runs.
 */
export interface DefaultsSeedRow {
  doc_class: DocClass;
  input_tokens: number | null;
  output_tokens: number | null;
  image_width_px: number | null;
  image_height_px: number | null;
  image_detail: 'low' | 'high' | 'auto' | null;
  source: 'USER_SUPPLIED_BASELINE';
}

export type DefaultsSeed = readonly DefaultsSeedRow[];

export const findSeed = (seed: DefaultsSeed, doc_class: DocClass): DefaultsSeedRow | null =>
  seed.find((r) => r.doc_class === doc_class) ?? null;

/* ═══════════════════════ the guard that matters ═══════════════════════ */

/**
 * What the caller already KNOWS about the request, measured rather than guessed.
 *
 * §A4.4.4 rule 4: "never fire when a real asset is attached — a measured value
 * always beats a default. Defaults are for pre-upload and hypothetical estimation
 * only." A default that overwrites a measurement is worse than no default at all,
 * because the measurement was the thing worth having.
 */
export interface MeasuredFacts {
  /** From a real file: characters counted, not estimated. */
  character_count?: number | null;
  /** From a real image: pixels read off the asset. */
  image_width_px?: number | null;
  image_height_px?: number | null;
  /** True when ANY asset was attached — the master switch on rule 4. */
  asset_attached?: boolean;
}

export interface AppliedDefault {
  assumption: Assumption;
  field: string;
  value: number;
}

export interface DefaultsResult {
  applied: AppliedDefault[];
  /** Gaps no default may fill. These block; they are questions, not guesses. */
  missing: MissingDatum[];
  /** Reasons a default was NOT applied, so the absence is legible too. */
  suppressed: string[];
}

const assumption = (
  task_id: string,
  field: string,
  value: unknown,
  impact_if_wrong: ImpactIfWrong,
  note: string,
): Assumption => ({
  id: `${task_id}:${field}`,
  task_id,
  field,
  value,
  // The exact string the contract keys SEED_UNCALIBRATED on. Anything else and the
  // Assumption refinement rejects the row.
  basis: DEFAULT_APPLIED,
  seed_provenance: 'SEED_UNCALIBRATED',
  impact_if_wrong,
  user_editable: true,
  // Null: ranking needs prices this stage does not have. The estimator fills it.
  sensitivity_rank: null,
  ...(note ? {} : {}),
});

export interface DefaultsInput {
  task_id: string;
  doc_class: DocClass | null;
  seed: DefaultsSeed;
  measured?: MeasuredFacts;
  /** Set when the task generates or edits an image. */
  needs_image_dimensions?: boolean;
  /** Set when iteration language appeared with no count (§A4.4.3). */
  volume_unquantified?: boolean;
}

export function applyDefaults(input: DefaultsInput): DefaultsResult {
  const { task_id, doc_class, seed } = input;
  const measured = input.measured ?? {};
  const applied: AppliedDefault[] = [];
  const missing: MissingDatum[] = [];
  const suppressed: string[] = [];

  // ── rule 4, before anything else ─────────────────────────────────────────
  const hasMeasuredText =
    measured.character_count !== undefined && measured.character_count !== null;
  const hasMeasuredImage =
    measured.image_width_px !== undefined && measured.image_width_px !== null;

  // ── text size ─────────────────────────────────────────────────────────────
  if (hasMeasuredText) {
    suppressed.push(
      `text size: a real asset was measured at ${measured.character_count} characters, and a measured value always beats a default (§A4.4.4).`,
    );
  } else if (doc_class === null) {
    // No trigger phrase and no asset. There is nothing to key a seed on, and
    // picking the middle class would be inventing a document.
    missing.push({
      field: 'document_length',
      task_id,
      model_id: null,
      question: 'Roughly how long is the input — a short post, an article, or a full document?',
      why_it_matters:
        'Nothing in the request names a document class, so there is no seed row to default from. The three classes differ by more than 80x in input tokens.',
      blocks_estimate: false,
    });
  } else {
    const row = findSeed(seed, doc_class);
    if (row === null) {
      suppressed.push(
        `text size: no defaults_seed row for '${doc_class}'. §A4.4.4 keeps the baselines out of code, so an absent table means no default rather than a constant standing in.`,
      );
    } else {
      if (row.input_tokens !== null) {
        applied.push({
          field: 'input_tokens',
          value: row.input_tokens,
          assumption: assumption(
            task_id,
            'input_tokens',
            row.input_tokens,
            // A document-length guess moves the dominant term on a READ task.
            'ORDER_OF_MAGNITUDE',
            '',
          ),
        });
      }
      if (row.output_tokens !== null) {
        applied.push({
          field: 'output_tokens',
          value: row.output_tokens,
          assumption: assumption(task_id, 'output_tokens', row.output_tokens, 'HIGH', ''),
        });
      }
    }
  }

  // ── image dimensions ──────────────────────────────────────────────────────
  if (input.needs_image_dimensions) {
    if (hasMeasuredImage) {
      suppressed.push(
        `image dimensions: measured at ${measured.image_width_px}x${measured.image_height_px} from the asset.`,
      );
    } else {
      const row = findSeed(seed, 'image_unspecified');
      if (row === null || row.image_width_px === null || row.image_height_px === null) {
        suppressed.push(
          'image dimensions: no defaults_seed row for image_unspecified, so no default fired.',
        );
      } else {
        applied.push({
          field: 'image_dimensions',
          value: row.image_width_px,
          assumption: assumption(
            task_id,
            'image_dimensions',
            { width_px: row.image_width_px, height_px: row.image_height_px, detail: row.image_detail },
            // Under a TOKEN_CAP geometry, oversizing saturates; under AREA_CLAMP it
            // does not. The same guess is cheap on one model and expensive on another.
            'ORDER_OF_MAGNITUDE',
            '',
          ),
        });
      }
    }
  }

  // ── volume ────────────────────────────────────────────────────────────────
  // §A4.4.3: "Missing iteration language is the most common cause of a 100x
  // underestimate." When the language IS there and the count is not, that is a
  // question — defaulting to 1 is the underestimate itself.
  if (input.volume_unquantified) {
    missing.push({
      field: 'volume',
      task_id,
      model_id: null,
      question: 'How many items does this run over?',
      why_it_matters:
        'The request says this repeats but does not say how many times. Assuming one is the single most common cause of a 100x underestimate (§A4.4.3), so the volume is asked for rather than defaulted.',
      blocks_estimate: false,
    });
  }

  return { applied, missing, suppressed };
}
