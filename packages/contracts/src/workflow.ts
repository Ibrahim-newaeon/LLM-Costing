// /packages/contracts/src/workflow.ts
//
// WorkflowInput — the Request Analyzer's output contract (Part B), consumed by the
// deterministic estimator. It carries NO prices and NO token counts, by design:
// the analyzer's job is to describe the work, not to price it. §A4.4 STEP 4 says
// it plainly — never emit a numeric token estimate yourself.
//
// Replaces the hand-authored /schemas/workflow-input.schema.json, which had no Zod
// behind it and had drifted: its `confidence` enum was missing NONE, and its
// `assumption` shape disagreed with the one in estimate-output.schema.json.
//
// Spec anchors: §A4.4 (Layer 0 parser) · §A4.4.4 (quantities vs rates) ·
// §A5.2.1 (asset disposition ladder) · §A5.3 (media)

import { z } from 'zod';
import { Confidence } from './provenance';
import { Assumption, Ambiguity, MissingDatum } from './assumption';

/* ─────────────────────────── where a metric came from ─────────────────────────── */

/**
 * Where a METRIC VALUE came from — not how far to trust a number.
 *
 * ⚠️ The prior JSON schema called this `provenance`, which collides head-on with
 * `Provenance` in provenance.ts. They are unrelated: `Provenance` records method,
 * confidence and source_url for a figure the engine produced; this records how a
 * measurement about the user's own input was obtained. Renamed on the way into the
 * contracts so the two cannot be confused at a call site. The JSON field names
 * (`character_count_source`, `dimensions_source`, `duration_source`) are unchanged.
 */
export const MetricSource = z.enum([
  'USER_STATED',         // the user said so
  'MEASURED_FROM_ASSET', // read off the file
  'DERIVED_FROM_ASSET',  // measured, then transformed by a STATED rule
  'DEFAULT_APPLIED',     // we supplied it — requires a matching assumptions[] entry
  'MISSING',             // requires a matching missing_data entry
]);
export type MetricSource = z.infer<typeof MetricSource>;

/* ─────────────────────────── scripts ─────────────────────────── */

/**
 * Coarse script families, for PROPORTIONS of a document.
 *
 * ⚠️ Deliberately NOT `Script` from vision.ts, which is a seven-value calibration
 * bucket (`ar_msa`, `ar_dialect`, `ar_vocalized`, `zh_hans`, `zh_hant`, …) keyed to
 * the legibility floor. These are families you can measure a mix of; those are
 * buckets you calibrate a ratio against. Merging them would force a document to
 * declare an Arabic register in order to state that it is 30% Arabic.
 *
 * FINDING, not yet resolved: `cyrillic` exists here and has no counterpart in
 * vision.ts's `Script`, so a Cyrillic document currently has no legibility floor.
 * Recorded rather than papered over.
 */
export const ScriptFamily = z.enum(['latin', 'arabic', 'han', 'cyrillic', 'other']);
export type ScriptFamily = z.infer<typeof ScriptFamily>;

/** What OCR detected in an image. The families, plus the two non-answers. */
export const DetectedScript = z.enum([...ScriptFamily.options, 'mixed', 'unknown']);
export type DetectedScript = z.infer<typeof DetectedScript>;

/* ─────────────────────────── languages ─────────────────────────── */

export const PayloadLanguage = z.object({
  code: z.string().min(1), // 'en' | 'ar' | 'zh-Hans' | 'zh-Hant' | …
  share: z.number().min(0).max(1),
});

/**
 * Three separate facts. Conflating them misprices the workflow — only
 * `payload_languages` enters the cost math. A UI in Arabic driving an English
 * corpus is an RTL layout problem and nothing else.
 */
export const Languages = z
  .object({
    /** Interface locale. Costs nothing; drives RTL layout only. */
    ui_language: z.string().min(1).nullable().default(null),
    /** Language THIS REQUEST is written in. Selects the parser lexicon. */
    instruction_language: z.string().min(1).nullable().default(null),
    /** Language of the BILLED CONTENT. */
    payload_languages: z.array(PayloadLanguage).min(1),
  })
  .refine(
    (l) => {
      const sum = l.payload_languages.reduce((t, p) => t + p.share, 0);
      return Math.abs(sum - 1) <= 0.02;
    },
    {
      // The prose said "should sum to ~1", which nothing enforced. Shares summing
      // to 0.5 silently halve every script-weighted ratio downstream.
      message: 'payload_languages shares must sum to 1 (±0.02).',
      path: ['payload_languages'],
    },
  );
export type Languages = z.infer<typeof Languages>;

/* ─────────────────────────── parse metadata ─────────────────────────── */

/**
 * How this task graph was produced. The L2 parse is itself a billable LLM call and
 * must be metered as `system_overhead` on the estimate — an estimator that forgets
 * this undercounts by its own parsing cost on every run.
 */
export const ParseMeta = z
  .object({
    layer: z.enum(['L1_DETERMINISTIC', 'L2_LLM_PARSE']),
    parse_confidence: z.number().min(0).max(1),
    escalated_reason: z.string().min(1).nullable().default(null),
    parser_model_id: z.string().min(1).nullable().default(null),
    parser_input_tokens: z.number().int().nonnegative().nullable().default(null),
    parser_output_tokens: z.number().int().nonnegative().nullable().default(null),
  })
  .refine((p) => p.layer !== 'L2_LLM_PARSE' || p.parser_model_id !== null, {
    message: 'An L2_LLM_PARSE must name parser_model_id — it is a billable call and has to be metered.',
    path: ['parser_model_id'],
  });
export type ParseMeta = z.infer<typeof ParseMeta>;

/* ─────────────────────────── text metrics ─────────────────────────── */

/**
 * What KIND of text this is. Exported because it is half of a calibration bucket
 * key (§A4.5.4) — code, JSON and tabular tokenize very differently from prose, and
 * a ratio measured on one says nothing about the others.
 */
export const ContentType = z.enum([
  'prose',
  'code',
  'structured_json',
  'tabular',
  'mixed',
  'unknown',
]);
export type ContentType = z.infer<typeof ContentType>;

export const TextMetrics = z
  .object({
    character_count: z.number().int().nonnegative().nullable().default(null),
    character_count_source: MetricSource,
    /**
     * Selects the seed default when character_count is absent. Seed values are
     * SEED_UNCALIBRATED and must be replaced from observed runs.
     */
    doc_class: z.enum(['short_form', 'medium_form', 'long_form', 'unknown']).default('unknown'),
    /**
     * Proportions, not a single label. Mixed Arabic/Latin/Han documents are the
     * norm in Gulf workflows and the tokenizer follows the mix.
     */
    // partialRecord, not record: zod 4's z.record over an enum key is EXHAUSTIVE,
    // which would force a Latin-only document to declare 0 for four other scripts.
    script_mix: z.partialRecord(ScriptFamily, z.number().min(0).max(1)).default({}),
    /**
     * Convenience flag for bucket selection, DERIVED from diacritic_density by
     * threshold. Never set independently — vocalization is a spectrum, and a raw
     * boolean snaps partially-vocalized text to whichever extreme misprices it.
     */
    arabic_vocalized: z.boolean().nullable().default(null),
    /**
     * Measured diacritics per consonant. The value the calibration table is keyed
     * on. Most real Arabic is partially vocalized — diacritics only on genuinely
     * ambiguous words — so this, not the boolean, is what drives the ratio.
     */
    diacritic_density: z.number().min(0).max(1).nullable().default(null),
    arabic_register: z.enum(['msa', 'dialect', 'mixed']).nullable().default(null),
    /**
     * null = UNKNOWN and BLOCKING. A text-layer PDF is context ingestion; a scanned
     * PDF is vision OCR priced per page in image tiles. No default is defensible
     * across that gap.
     */
    pdf_has_text_layer: z.boolean().nullable().default(null),
    content_type: ContentType.default('unknown'),
    tool_schemas_present: z.boolean().default(false),
    tool_schema_character_count: z.number().int().nonnegative().nullable().default(null),
    conversation_turns: z.number().int().positive().nullable().default(null),
    history_strategy: z
      .enum(['FULL_HISTORY', 'SLIDING_WINDOW', 'SUMMARIZED_ROLLUP'])
      .nullable()
      .default(null),
    history_window_k: z.number().int().positive().nullable().default(null),
  })
  .superRefine((t, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // Enforces the "do not set it independently" note the prose could only ask for.
    if (t.arabic_vocalized !== null && t.diacritic_density === null) {
      err(
        'arabic_vocalized is DERIVED from diacritic_density; setting it without the density it came from re-creates the boolean this field replaced.',
        ['diacritic_density'],
      );
    }
    if (t.history_strategy === 'SLIDING_WINDOW' && t.history_window_k === null) {
      err('SLIDING_WINDOW requires history_window_k — the window size is the whole cost.', [
        'history_window_k',
      ]);
    }
    if (t.tool_schemas_present && t.tool_schema_character_count === null) {
      err(
        'Tool schemas present but uncounted. The schema JSON is billed input (§A5.1); null here silently zeroes it.',
        ['tool_schema_character_count'],
      );
    }
    const mix = Object.values(t.script_mix);
    if (mix.length > 0) {
      const sum = mix.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 0.02) {
        err('script_mix proportions must sum to 1 (±0.02).', ['script_mix']);
      }
    }
  });
export type TextMetrics = z.infer<typeof TextMetrics>;

/* ─────────────────────────── image metrics ─────────────────────────── */

/**
 * The rungs of the §A5.2.1 ladder, in order. Exported because the estimator
 * decides which rung an asset lands on and must not invent a parallel vocabulary
 * to say so.
 */
export const DispositionRung = z.enum([
  'FITS_AS_IS',
  'PROVIDER_NORMALIZED',
  'RESIZE_PROPOSED',
  'RESIZE_SAVES_NOTHING',
  'FIDELITY_LOCKED',
  'REROUTED',
  'BLOCKED',
]);
export type DispositionRung = z.infer<typeof DispositionRung>;

/**
 * Outcome of the §A5.2.1 oversized/out-of-spec ladder.
 *
 * The estimator NEVER mutates the user's asset. A resize is a PROPOSAL the user
 * accepted or declined; resolution is a quality decision, not a cost decision.
 */
export const AssetDisposition = z
  .object({
    rung: DispositionRung,
    violated_constraints: z
      .array(
        z.enum([
          'max_edge_px',
          'min_edge_px',
          'max_bytes',
          'max_pages',
          'max_duration_seconds',
          'max_frames',
          'allowed_mime',
        ]),
      )
      .default([]),
    /** WxH as measured. Always retained, even when a transform was applied. */
    original_dimensions: z.string().min(3).nullable().default(null),
    /** WxH actually priced. */
    effective_dimensions: z.string().min(3).nullable().default(null),
    /** Names the rule — the provider's normalization, or the accepted resize. */
    transform_rule: z.string().min(1).nullable().default(null),
    resize_accepted_by_user: z.boolean().nullable().default(null),
    /** tiles(scaled) − tiles(original). */
    recomputed_tile_delta: z.number().int().nullable().default(null),
    min_legible_edge_px: z.number().int().positive().nullable().default(null),
  })
  .superRefine((d, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // Tiles are a ceiling function and several providers UPSCALE below their
    // shortest-edge target, so shrinking an image can RAISE the count. Proposing a
    // resize that saves nothing is the ladder's own named failure state.
    if (d.rung === 'RESIZE_PROPOSED' && (d.recomputed_tile_delta ?? 0) >= 0) {
      err(
        'A resize is only proposed when recomputed_tile_delta is negative; otherwise the rung is RESIZE_SAVES_NOTHING (§A5.2.1).',
        ['recomputed_tile_delta'],
      );
    }
    if (d.rung === 'PROVIDER_NORMALIZED' && d.transform_rule === null) {
      err('PROVIDER_NORMALIZED must name the normalization rule it applied.', ['transform_rule']);
    }
  });
export type AssetDisposition = z.infer<typeof AssetDisposition>;

export const ImageMetrics = z
  .object({
    width_px: z.number().int().positive().nullable().default(null),
    height_px: z.number().int().positive().nullable().default(null),
    dimensions_source: MetricSource,
    detail_mode: z.enum(['low', 'high', 'auto']).nullable().default(null),
    image_count: z.number().int().positive().default(1),
    operation: z.enum(['analyze', 'generate', 'img2img', 'inpaint', 'upscale']),
    upscale_multiplier: z.number().gt(1).nullable().default(null),
    /**
     * §A5.10 re-rolls — "image workflows generate N candidates per accepted image.
     * Every candidate bills."
     *
     * Defaults to 1 and is, in the spec's own words, "almost never actually 1".
     * The default therefore does not pass silently: on a generating operation the
     * estimator emits an Assumption for it, which caps the line's confidence.
     * A default that is usually wrong has to cost something.
     */
    candidates_per_accepted_image: z.number().int().positive().default(1),
    mask_present: z.boolean().default(false),
    byte_size: z.number().int().nonnegative().nullable().default(null),
    /**
     * Multi-page documents multiply the tile grid PER PAGE. Surface
     * pages × tiles_per_page as its own estimate line.
     */
    page_count: z.number().int().positive().nullable().default(null),
    /** Drives min_legible_edge_px. Mixed takes the STRICTEST floor, never the average. */
    detected_script: DetectedScript.nullable().default(null),
    /** User marked this OCR-critical. Blocks the resize rung entirely. */
    fidelity_critical: z.boolean().default(false),
    asset_disposition: AssetDisposition.nullable().default(null),
  })
  .superRefine((m, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // The rule the prose stated and nothing enforced.
    if (m.dimensions_source === 'DERIVED_FROM_ASSET' && !m.asset_disposition?.transform_rule) {
      err(
        'DERIVED_FROM_ASSET requires asset_disposition.transform_rule — a transformed measurement must name the rule that transformed it.',
        ['asset_disposition', 'transform_rule'],
      );
    }
    if (m.fidelity_critical && m.asset_disposition?.rung === 'RESIZE_PROPOSED') {
      err(
        'fidelity_critical blocks the resize rung: the correct rung is FIDELITY_LOCKED (§A5.2.1).',
        ['asset_disposition', 'rung'],
      );
    }
    // Re-rolls are a property of GENERATING. Analysing an image once does not
    // produce candidates, and a count above 1 there is a misfiled field that would
    // multiply a vision bill.
    if (m.operation === 'analyze' && m.candidates_per_accepted_image !== 1) {
      err(
        'candidates_per_accepted_image applies to generation, not analysis — an analysed image is billed once (§A5.10).',
        ['candidates_per_accepted_image'],
      );
    }
    if (m.operation === 'inpaint' && !m.mask_present) {
      err('An inpaint operation requires a mask.', ['mask_present']);
    }
    if (m.operation === 'upscale' && m.upscale_multiplier === null) {
      err('An upscale operation requires upscale_multiplier — it is the cost.', [
        'upscale_multiplier',
      ]);
    }
  });
export type ImageMetrics = z.infer<typeof ImageMetrics>;

/* ─────────────────────────── media metrics ─────────────────────────── */

export const MediaMetrics = z.object({
  modality: z.enum(['audio', 'video']),
  duration_seconds: z.number().nonnegative().nullable().default(null),
  duration_source: MetricSource,
  has_audio_track: z.boolean().default(false),
  /** §A5.3 — frame sampling IS the video cost. Often user-configurable. */
  frame_sample_rate_hz: z.number().gt(0).nullable().default(null),
});
export type MediaMetrics = z.infer<typeof MediaMetrics>;

/* ─────────────────────────── cost flags ─────────────────────────── */

export const CostFlags = z.object({
  requires_reasoning: z.boolean(),
  requires_vision: z.boolean(),
  requires_tool_calling: z.boolean(),
  requires_long_context: z.boolean().default(false),
  requires_structured_output: z.boolean().default(false),
  is_conversational: z.boolean().default(false),
  /** Caching candidate: same system prompt / tool block reused across calls. */
  has_stable_prefix: z.boolean().default(false),
  latency_sensitive: z.boolean().default(false),
  /**
   * Jurisdiction or policy the user ACTUALLY STATED. Null when unstated — do not
   * infer. §A5.2.1 rung 6: rerouting for an asset constraint never overrides this.
   */
  data_residency_constraint: z.string().min(1).nullable().default(null),
});
export type CostFlags = z.infer<typeof CostFlags>;

/* ─────────────────────────── task ─────────────────────────── */

/**
 * How much output this task is expected to produce. Exported because it is the key
 * a calibrated output prior is looked up by (§A5.4) — the analyzer picks a band, and
 * the estimator turns that band into a distribution measured from observed runs.
 *
 * It is a BAND, not a number. §A4.4 STEP 4 is explicit that the analyzer never emits
 * a numeric token estimate itself.
 */
export const OutputBand = z.enum(['short', 'medium', 'long', 'unbounded']);
export type OutputBand = z.infer<typeof OutputBand>;

export const Task = z
  .object({
    task_id: z.string().min(1),
    sequence_index: z.number().int().nonnegative(),
    label: z.string().min(1).nullable().default(null),
    type: z.enum(['READ', 'WRITE', 'EDIT']),
    sub_kind: z
      .enum([
        'context_ingestion', 'vision_ocr', 'image_analysis', 'document_parsing',
        'completion', 'reasoning', 'creative_draft', 'structured_generation',
        'text_rewrite', 'image_generate', 'image_to_image', 'inpaint', 'upscale',
      ])
      .nullable()
      .default(null),
    /**
     * Executions of this task. A loop over 500 docs is ONE task with volume 500.
     * Arabic-Indic and Chinese numerals must be converted before extraction.
     */
    volume: z.number().int().positive(),
    /**
     * Parent task id when a compound verb expanded into a pair. "Translate" and
     * "summarize" are BOTH read and write — classifying either as a single task
     * undercounts by roughly one document.
     */
    expands_from: z.string().min(1).nullable().default(null),
    /** Below 1 for conditional branches. Multiplies effective volume. */
    execution_probability: z.number().min(0).max(1).default(1),
    text_metrics: TextMetrics.nullable().default(null),
    image_metrics: ImageMetrics.nullable().default(null),
    media_metrics: MediaMetrics.nullable().default(null),
    /** Selects a calibrated prior downstream. NOT itself a token estimate. */
    expected_output_band: OutputBand.nullable().default(null),
    max_tokens: z.number().int().positive().nullable().default(null),
    flags: CostFlags,
  })
  .superRefine((t, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // Safe direction only: metrics present ⇒ the flag must agree. The converse
    // (vision required but metrics absent) is a legitimate missing_data case.
    if (t.image_metrics !== null && !t.flags.requires_vision) {
      err('A task carrying image_metrics must set flags.requires_vision.', [
        'flags',
        'requires_vision',
      ]);
    }
    if (t.type === 'READ' && t.expected_output_band === 'unbounded') {
      err('A READ task with an unbounded output band is a WRITE task in disguise.', [
        'expected_output_band',
      ]);
    }
  });
export type Task = z.infer<typeof Task>;

/* ─────────────────────────── the document ─────────────────────────── */

export const WorkflowInput = z
  .object({
    workflow_id: z.string().min(1).nullable().default(null),
    workflow_label: z.string().min(1).max(200).nullable().default(null),
    languages: Languages,
    parse_meta: ParseMeta.nullable().default(null),
    /**
     * May be EMPTY. §A4.4 closing rule: when no estimate is possible, return no
     * tasks, LOW, and needs_human_review — returning nothing useful, honestly, is
     * a correct outcome.
     */
    tasks: z.array(Task),
    assumptions: z.array(Assumption),
    ambiguities: z.array(Ambiguity),
    missing_data: z.array(MissingDatum),
    confidence: Confidence,
    needs_human_review: z.boolean(),
    analyzer_notes: z.string().min(1).nullable().default(null),
  })
  .superRefine((w, ctx) => {
    const err = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    if (w.missing_data.some((m) => m.blocks_estimate) && !w.needs_human_review) {
      err(
        'A blocking missing_data entry requires needs_human_review — a gap that blocks the estimate is not a footnote.',
        ['needs_human_review'],
      );
    }
    // §A3.3 — NONE is reserved for UNAVAILABLE, which is a property of a produced
    // figure. The analyzer produces no figures, so it has no NONE to report; the
    // honest floor for "I could not read this" is LOW plus needs_human_review.
    if (w.confidence === 'NONE') {
      err(
        'WorkflowInput.confidence may not be NONE. NONE is reserved for method UNAVAILABLE on a produced figure; an analyzer that cannot read the request returns LOW with needs_human_review.',
        ['confidence'],
      );
    }
    const ids = w.tasks.map((t) => t.task_id);
    if (new Set(ids).size !== ids.length) {
      err('task_id must be unique — assumptions and estimate lines reference it.', ['tasks']);
    }
    const known = new Set(ids);
    w.tasks.forEach((t, i) => {
      if (t.expands_from !== null && !known.has(t.expands_from)) {
        err('expands_from must reference a task in this workflow.', ['tasks', i, 'expands_from']);
      }
    });
    w.assumptions.forEach((a, i) => {
      if (a.task_id !== null && !known.has(a.task_id)) {
        err('An assumption scoped to an unknown task cannot be edited or ranked.', [
          'assumptions',
          i,
          'task_id',
        ]);
      }
    });
  });
export type WorkflowInput = z.infer<typeof WorkflowInput>;

/* ─────────────────────── inferred types ───────────────────────
 * Companions for the schemas above that were defined without one. Every schema in
 * this package should export both: a consumer that can only import the value has to
 * write `z.infer<typeof X>` at its own use sites, which is the same shape spelled
 * out in two places and one edit away from disagreeing.
 */
export type PayloadLanguage = z.infer<typeof PayloadLanguage>;
