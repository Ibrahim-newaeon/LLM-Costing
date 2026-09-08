// /packages/parser/src/parse.ts
//
// §A4.4.1 — L1, the deterministic router.
//
//   [free text, any language]
//         ↓
//   [L1: Deterministic Router]  ← lexicon + normalizer + regex. Free, ~0ms, no tokens.
//         ↓  confidence >= PARSE_CONFIDENCE_FLOOR ? emit : escalate
//   [L2: Structured LLM Parse]  ← not implemented here; this decides WHEN to call it
//         ↓
//   [WorkflowInput]
//
// "L1 handles the ~70% of inputs that are imperative and well-formed. L2 is the
// fallback, not the default." So this file's job is twofold: parse what it can, and
// be honest about when it cannot — because every escalation is a billable LLM call
// and the L1 hit-rate "is the single lever on your own gross margin".
//
// L2 itself is not built here. What is built is the decision, the confidence score
// it turns on, and the `ParseMeta` that records which layer answered — so the
// overhead line can be emitted for L2 and, crucially, NOT for L1.

import {
  WorkflowInput,
  stackedAssumptionCeiling,
  type Assumption,
  type Confidence,
  type MissingDatum,
  type ParseMeta,
  type Task,
} from '@tokenomics/contracts';
import { normalize, type Normalized } from './normalize';
import { matchIntents, type LexiconHit } from './lexicon';
import {
  classifyDocument, detectConditional, detectPdfKind, extractVolume,
  mentionsDocument, volumeIsUnquantified,
} from './quantities';
import { applyDefaults, type DefaultsSeed, type MeasuredFacts } from './defaults';

/**
 * The escalation threshold. Config, not a constant of nature — it trades L2 spend
 * against parse quality and belongs in settings, so it is a parameter with a
 * documented starting point rather than a literal buried in a comparison.
 */
export const PARSE_CONFIDENCE_FLOOR = 0.6;

export interface ParseInput {
  text: string;
  seed: DefaultsSeed;
  ui_language?: string | null;
  /** Measured facts from attached assets. Suppresses defaults (§A4.4.4 rule 4). */
  measured?: MeasuredFacts;
  confidence_floor?: number;
}

export type ParseResult =
  | { status: 'PARSED'; workflow: WorkflowInput; normalized: Normalized }
  | {
      status: 'ESCALATE';
      reason: string;
      parse_confidence: number;
      normalized: Normalized;
      /** What L1 did manage, so L2 can be given a head start rather than the raw string. */
      partial: { intents: string[]; script_mix: Normalized['script_mix'] };
    };

/* ═══════════════════════ confidence ═══════════════════════ */

/**
 * How much L1 trusts its own read.
 *
 * Deliberately pessimistic in the two places where being wrong is expensive: a
 * negated verb and an unresolved document class both pull it toward escalation,
 * because the cost of a wrong task graph is a wrong estimate and the cost of an L2
 * call is a fraction of a cent.
 */
export function parseConfidence(hits: LexiconHit[], normalized: Normalized): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 1;

  const usable = hits.filter((h) => !h.negated);
  if (usable.length === 0) {
    return { score: 0, reasons: ['No actionable verb matched the lexicon.'] };
  }
  if (hits.some((h) => h.negated)) {
    // "don't summarize, just extract" parsed correctly still means the sentence is
    // doing something subtle, and the next clause may negate more than it appears.
    score -= 0.25;
    reasons.push('A negated verb was found and suppressed; the surrounding clause may qualify others.');
  }
  const mixCount = Object.keys(normalized.script_mix).length;
  if (mixCount > 2) {
    score -= 0.15;
    reasons.push(`Three or more scripts in the instruction (${mixCount}); lexicon selection is less certain.`);
  }
  if (normalized.matchable.length > 600) {
    score -= 0.2;
    reasons.push('Long free-text instruction; L1 matches verbs, not structure.');
  }
  if (detectConditional(normalized.matchable).is_conditional) {
    score -= 0.2;
    reasons.push('A conditional branch was detected and its probability is not inferable from the text.');
  }
  return { score: Math.max(0, Math.round(score * 100) / 100), reasons };
}

/* ═══════════════════════ the parse ═══════════════════════ */

export function parseL1(input: ParseInput): ParseResult {
  const normalized = normalize(input.text);
  const floor = input.confidence_floor ?? PARSE_CONFIDENCE_FLOOR;
  const hits = matchIntents(normalized.matchable);
  const { score, reasons } = parseConfidence(hits, normalized);

  if (score < floor) {
    return {
      status: 'ESCALATE',
      reason: reasons.join(' ') || 'Parse confidence below the floor.',
      parse_confidence: score,
      normalized,
      partial: {
        intents: hits.filter((h) => !h.negated).map((h) => h.entry.intent),
        script_mix: normalized.script_mix,
      },
    };
  }

  const usable = hits.filter((h) => !h.negated);
  const volume = extractVolume(normalized.matchable);
  const conditional = detectConditional(normalized.matchable);
  const docClass = classifyDocument(normalized.matchable);

  const tasks: Task[] = [];
  const assumptions: Assumption[] = [];
  const missing: MissingDatum[] = [];
  let seq = 0;

  for (const hit of usable) {
    const intentId = `intent:${hit.entry.intent}`;
    const multi = hit.entry.expansion.length > 1;
    // A pair is anchored on its FIRST half, never on a synthetic parent row.
    // A parent would be a third entry in `tasks` that nothing bills, and §A4.4.3's
    // whole point is that the expansion IS the two things you pay for. WorkflowInput
    // enforces the same thing from the other side — expands_from must name a task
    // that exists here — so an unbilled parent is not expressible.
    let anchorId: string | null = null;

    for (const [stepIndex, step] of hit.entry.expansion.entries()) {
      const task_id = multi ? `${intentId}:${step.type.toLowerCase()}` : intentId;
      if (stepIndex === 0) anchorId = task_id;
      const needsImage = step.sub_kind === 'image_generate' || step.sub_kind === 'inpaint';

      const d = applyDefaults({
        task_id,
        doc_class: needsImage ? 'image_unspecified' : docClass.doc_class,
        seed: input.seed,
        measured: input.measured,
        needs_image_dimensions: needsImage,
        volume_unquantified: volumeIsUnquantified(volume),
      });
      assumptions.push(...d.applied.map((a) => a.assumption));
      missing.push(...d.missing);

      // §A4.4.3 — a conditional is a probabilistic branch, and the probability is
      // not in the sentence. Recording 1 would treat it as certain; recording a
      // guess would invent it. So the branch is flagged and the number is asked for.
      if (conditional.is_conditional) {
        missing.push({
          field: 'execution_probability',
          task_id,
          model_id: null,
          question: `How often does the "${conditional.marker?.trim()}" condition hold?`,
          why_it_matters:
            'This task runs only when a condition is met. Nothing in the request says how often that is, and treating it as certain overstates the workflow while guessing a rate understates the uncertainty.',
          blocks_estimate: false,
        });
      }

      tasks.push({
        task_id,
        sequence_index: seq++,
        label: null,
        type: step.type,
        sub_kind: step.sub_kind,
        volume: volume.volume,
        // The second half of a compound intent points back at the first, so the UI
        // can render "you said summarize — here are the two things you pay for"
        // without a third row that nobody pays for.
        expands_from: stepIndex > 0 ? anchorId : null,
        execution_probability: 1,
        text_metrics: null,
        image_metrics: null,
        media_metrics: null,
        expected_output_band: null,
        max_tokens: null,
        flags: {
          requires_reasoning: false,
          requires_vision: step.sub_kind === 'vision_ocr' || step.sub_kind === 'image_analysis',
          requires_tool_calling: false,
          requires_long_context: docClass.doc_class === 'long_form',
          requires_structured_output: false,
          is_conversational: false,
          has_stable_prefix: false,
          latency_sensitive: false,
          data_residency_constraint: null,
        },
      } as Task);
    }
  }

  // ── §A4.4.7 — the question no default can answer ──────────────────────────
  if (mentionsDocument(normalized.matchable) && input.measured?.asset_attached !== true) {
    const kind = detectPdfKind(normalized.matchable);
    if (kind === 'UNKNOWN') {
      missing.push({
        field: 'pdf_has_text_layer',
        task_id: null,
        model_id: null,
        question: 'Is the document searchable text, or a scan?',
        why_it_matters:
          'A text-layer document is priced on text tokens (§A5.1). A scan is vision geometry once per page (§A5.2), which can be far higher and scales with page count. No default is defensible across a gap this size.',
        blocks_estimate: true,
      });
    }
  }

  // ── §A4.4.4 rule 3 — the ceiling, computed by the contracts, not restated ──
  const ceiling = stackedAssumptionCeiling(assumptions);
  // §A3.3: the analyzer produces no figures, so it has no NONE to report. LOW is
  // the honest floor for "I could not read this", and the contract enforces it.
  const confidence: Confidence = ceiling === 'NONE' ? 'LOW' : ceiling;
  const blocking = missing.some((m) => m.blocks_estimate);

  const workflow = WorkflowInput.parse({
    workflow_id: null,
    workflow_label: null,
    languages: {
      ui_language: input.ui_language ?? null,
      // §A4.4.6 — the language the REQUEST is written in, which selects the lexicon
      // and costs nothing. Distinct from the payload, below.
      instruction_language: normalized.dominant,
      // ⚠️ The instruction's script is NOT the payload's. §A4.4.6's own example is
      // an English request about a Chinese payload from an Arabic UI. L1 sees only
      // the instruction, so it reports the instruction's script here and flags the
      // payload as unknown rather than assuming they match.
      payload_languages: [{ code: normalized.dominant ?? 'und', share: 1 }],
    },
    parse_meta: {
      layer: 'L1_DETERMINISTIC',
      parse_confidence: score,
      escalated_reason: null,
      // Null on purpose, and the contract permits it only for L1: an L1 parse runs
      // no model, so there is no overhead line to emit. That absence is the metric.
      parser_model_id: null,
      parser_input_tokens: null,
      parser_output_tokens: null,
    } satisfies ParseMeta,
    tasks,
    assumptions,
    ambiguities:
      docClass.ambiguous_with.length > 0 && docClass.doc_class !== null
        ? [{
            field: 'doc_class',
            readings: [docClass.doc_class, ...docClass.ambiguous_with],
            impact: 'ORDER_OF_MAGNITUDE',
          }]
        : [],
    missing_data: missing,
    confidence,
    needs_human_review: blocking || confidence === 'LOW',
    analyzer_notes: null,
  });

  return { status: 'PARSED', workflow, normalized };
}

/**
 * §A4.4.6 — the payload language, which is the only one that enters the cost math.
 *
 * Separate from `parseL1` because it needs the ASSET, not the instruction. Calling
 * it with the instruction text would reproduce the conflation §A4.4.6 exists to
 * prevent: "written in English about a Chinese payload, and might come from an
 * Arabic UI".
 */
export function payloadLanguages(assetSample: string): Array<{ code: string; share: number }> {
  const mix = normalize(assetSample).script_mix;
  const entries = Object.entries(mix) as Array<[string, number]>;
  if (entries.length === 0) return [{ code: 'und', share: 1 }];
  const code: Record<string, string> = {
    latin: 'en', arabic: 'ar', han: 'zh-Hans', cyrillic: 'ru', other: 'und',
  };
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([family, share]) => ({ code: code[family] ?? 'und', share }));
}
