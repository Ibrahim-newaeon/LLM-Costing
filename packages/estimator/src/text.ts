// /packages/estimator/src/text.ts
//
// Text input tokens (§A5.1) and multi-turn growth (§A5.5).
//
//   input_tokens = tokenize(rendered_prompt) + framing_overhead + tool_schema_tokens
//
// Three components, all real, all commonly forgotten. The third routinely dominates
// a short prompt in an agentic workflow: every tool definition is serialized into
// the context before the user types anything.
//
// The dangerous part of this file is Tier 3. §A4.5.4 permits a bootstrap ratio for
// English prose and states, in bold, that no bootstrap value exists for Arabic or
// Chinese. Applying the English ratio to Arabic is "confident, silent, and wrong by
// a large factor" — so a bucket with no calibration row returns UNAVAILABLE with a
// missing_data entry naming it, and the UI shows a character count instead. A blank
// token field is honest; a wrong one is not.
//
// Spec anchors: §A5.1 · §A5.5 · §A4.5.3 (proxies) · §A4.5.4 (the constant you may
// not generalize) · §A4.5.5 (padding is directional)

import {
  findCalibration,
  minConfidence,
  type CalibrationBucket,
  type Confidence,
  type ContentType,
  type Method,
  type Range,
  type Script,
  type TextCalibration,
  type TextMetrics,
  type TokenizerProfile,
  type EstimateWarning,
} from '@tokenomics/contracts';

/* ─────────────────────────── results ─────────────────────────── */

/** Which rung of §A4.5 actually produced a number. Never the rung requested. */
export type TokenTier = 0 | 1 | 2 | 3;

/**
 * What an exact count already contains.
 *
 *   PROMPT_ONLY    — the rendered prompt text and nothing else. Framing and tool
 *                    schemas are still owed and get their own components.
 *   WHOLE_REQUEST  — everything the provider will bill as input: prompt, system,
 *                    tool definitions, per-message framing, attached media. One
 *                    number, and adding anything to it double-counts.
 *
 * There is no default. Guessing wrong is a silent double-count in one direction
 * and a silent undercount in the other, and neither shows up as a wrong-looking
 * number.
 */
export type ExactCoverage = 'PROMPT_ONLY' | 'WHOLE_REQUEST';

export interface TextComponent {
  component: 'prompt_input' | 'framing_overhead' | 'tool_schema';
  tokens: Range;
  /**
   * §A4.5.5 — padded, and for the context-overflow and max_tokens checks ONLY.
   * Null above Tier 3: padding a measured count is just overquoting.
   */
  context_safety_tokens: number | null;
  method: Method;
  confidence: Confidence;
  tier: TokenTier;
  note: string | null;
}

export interface TextCounted {
  status: 'COUNTED';
  components: TextComponent[];
  total: Range;
  context_safety_total: number;
  confidence: Confidence;
  tier: TokenTier;
}

export interface TextUnavailable {
  status: 'UNAVAILABLE';
  reason: string;
  /** Shaped for `EstimateOutput.missing_data[]`. */
  missing_data: { field: string; why_it_matters: string; blocks_estimate: true };
  /** A coded refusal, for the caller that branches rather than reads. */
  warnings?: EstimateWarning[];
}

export type TextCount = TextCounted | TextUnavailable;

/* ─────────────────────────── bucket resolution ─────────────────────────── */

/**
 * Which calibration bucket this text belongs to.
 *
 * Takes the DOMINANT script family and refines it with the Arabic register and
 * diacritic density the analyzer measured. Where the mix is genuinely mixed, the
 * bucket is `mixed` — which has no bootstrap value either, deliberately: a document
 * that is 70% Latin and 30% Arabic cannot be priced with the Latin ratio.
 *
 * `MIXED_DOMINANCE_THRESHOLD` is the share one family must exceed to be treated as
 * the document's script. It is a judgement about classification, not a rate, so it
 * is a labelled parameter rather than a hidden constant.
 */
export const MIXED_DOMINANCE_THRESHOLD = 0.85;

export function resolveCalibrationBucket(
  metrics: Pick<TextMetrics, 'script_mix' | 'arabic_register' | 'diacritic_density' | 'content_type'>,
  opts: { dominance_threshold?: number } = {},
): CalibrationBucket {
  const threshold = opts.dominance_threshold ?? MIXED_DOMINANCE_THRESHOLD;
  const content_type: ContentType = metrics.content_type;

  const entries = Object.entries(metrics.script_mix) as Array<[string, number]>;
  if (entries.length === 0) return { script: 'mixed', content_type };

  const [family, share] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (share < threshold) return { script: 'mixed', content_type };

  switch (family) {
    case 'latin':
      return { script: 'latin', content_type };
    case 'han':
      // The registry distinguishes Hans from Hant and the document does not carry
      // that distinction. Refusing to pick is the honest move: `mixed` has no
      // bootstrap, so this surfaces as "needs calibration" rather than as a guess.
      return { script: 'mixed', content_type };
    case 'arabic': {
      // Vocalization is a spectrum measured by diacritic_density; the register says
      // which Arabic. Both are needed to land on a real bucket.
      if (metrics.diacritic_density !== null && metrics.diacritic_density > 0) {
        return { script: 'ar_vocalized', content_type };
      }
      if (metrics.arabic_register === 'dialect') return { script: 'ar_dialect', content_type };
      if (metrics.arabic_register === 'msa') return { script: 'ar_msa', content_type };
      return { script: 'mixed', content_type };
    }
    default:
      // cyrillic, other — no bucket exists. See the open finding in the README.
      return { script: 'mixed', content_type };
  }
}

/* ─────────────────────────── the counter ─────────────────────────── */

export interface TextCountInput {
  model_id: string;
  tokenizer: TokenizerProfile;
  metrics: Pick<
    TextMetrics,
    | 'character_count'
    | 'script_mix'
    | 'arabic_register'
    | 'diacritic_density'
    | 'content_type'
    | 'tool_schemas_present'
    | 'tool_schema_character_count'
  >;
  calibration: readonly TextCalibration[];
  /** Messages in the rendered prompt, for per-message framing overhead. */
  message_count: number;
  /**
   * A count from a higher tier, when the caller has one — Tier 1 (a provider count
   * API) or Tier 2 (a local or proxy tokenizer). Supplying it skips the heuristic
   * entirely, and its `method` is carried through unchanged: a cached Tier 3 value
   * is never re-tagged as Tier 1.
   *
   * `covers` is load-bearing and was added after a real provider was read properly
   * (2026-09-08). Anthropic's count-tokens endpoint is handed the WHOLE request —
   * "the count includes system prompts, tool definitions, messages, thinking
   * blocks, images and PDFs" — and returns one number for all of it. A local
   * tokenizer run over the prompt string covers only the prompt.
   *
   * Without the distinction this function added §A5.1.2 framing and §A5.1.3 tool
   * schemas ON TOP of a number that already contained them, and blocked outright
   * when framing was unmeasured — on a term the count had already measured. See
   * the WHOLE_REQUEST branch below.
   */
  exact?: {
    tokens: number;
    method: Method;
    confidence: Confidence;
    tier: 0 | 1 | 2;
    covers: ExactCoverage;
    /** Vendor caveats worth carrying to the line, e.g. unbilled system tokens. */
    note?: string | null;
  };
  /**
   * Whether the request this text belongs to ALSO carries images, audio or video.
   *
   * Required, not optional, and deliberately so: a caller who forgets would get the
   * unsafe path by default, and §A12's rule exists because that path silently prices
   * the media at zero. Making it required broke every call site at compile time,
   * which is the point.
   *
   * A text-only count on a media-bearing request is not wrong by itself — this
   * package composes a text line and a vision line and adds them. What is wrong is
   * a count that CLAIMS to cover the whole request when it cannot have seen the
   * media. See the guard at the top of `countTextTokens`.
   */
  payload_has_media: boolean;
  /** §A4.5.5. Config, not a literal, and it applies to Tier 3 only. */
  heuristic_safety_pad_pct: number;
}

export function countTextTokens(input: TextCountInput): TextCount {
  const {
    model_id, tokenizer, metrics, calibration, message_count, exact,
    payload_has_media, heuristic_safety_pad_pct,
  } = input;

  const components: TextComponent[] = [];
  const confidences: Confidence[] = [];

  /* ---- 0a. §A12 — a whole-request claim only a remote count can make ---- */
  // "A media-bearing payload never returns a local text-only count; it escalates to
  // Tier 1 or returns UNAVAILABLE."
  //
  // A LOCAL tokenizer handed a multimodal payload tokenizes the text parts and
  // ignores the image blocks. The number it returns looks like a request count and
  // is short by every image in the request. Tagged WHOLE_REQUEST, it suppresses the
  // framing and tool-schema components below AND tells the caller nothing else is
  // owed — so the vision line is never added and the images are priced at zero,
  // silently, at whatever confidence the tokenizer claimed.
  //
  // Only tier 1 — the provider's own count endpoint — has seen the media. Anthropic
  // says so in as many words: the count "includes system prompts, tool definitions,
  // messages, thinking blocks, images and PDFs". Nothing that ran on this machine can.
  if (payload_has_media && exact !== undefined && exact.covers === 'WHOLE_REQUEST' && exact.tier !== 1) {
    return {
      status: 'UNAVAILABLE',
      reason:
        `A tier-${exact.tier} count claims to cover the whole request, but this request carries ` +
        'media and nothing outside the provider can have counted it. Escalate to tier 1, or ' +
        'count the text as PROMPT_ONLY and price the media on its own line (§A12).',
      missing_data: {
        field: 'exact.covers',
        why_it_matters:
          'A whole-request count from outside the provider cannot include the media, so the ' +
          'images would be priced at zero rather than refused.',
        blocks_estimate: true,
      },
      warnings: [{
        code: 'MEDIA_PAYLOAD_NOT_REMOTE_COUNTED',
        message:
          `A tier-${exact.tier} count was offered as WHOLE_REQUEST on a media-bearing request. ` +
          'A local tokenizer sees text and skips image blocks, so accepting it would price every ' +
          'image at zero while reporting the tokenizer’s own confidence.',
        severity: 'BLOCKING',
      }],
    };
  }

  /* ---- 0b. a whole-request count is the ENTIRE answer ---- */
  // It already contains framing and tool schemas, so the only correct thing to do
  // with the other two components is not compute them. Returning early rather than
  // guarding each one below keeps that fact in a single place.
  if (exact !== undefined && exact.covers === 'WHOLE_REQUEST') {
    const whole: TextComponent = {
      component: 'prompt_input',
      tokens: { p50: exact.tokens, p90: exact.tokens, p99: null },
      // Never pad a measured count — that is overquoting, not safety.
      context_safety_tokens: null,
      method: exact.method,
      confidence: exact.confidence,
      tier: exact.tier,
      note:
        'Whole-request count: prompt, system, tool definitions and per-message framing are all ' +
        'inside this one figure. No framing_overhead or tool_schema component is emitted, because ' +
        'adding either would bill the same tokens twice.' +
        (exact.note ? ` ${exact.note}` : ''),
    };
    return {
      status: 'COUNTED',
      components: [whole],
      total: whole.tokens,
      context_safety_total: whole.tokens.p90,
      confidence: exact.confidence,
      tier: exact.tier,
    };
  }

  /* ---- 1. the rendered prompt ---- */
  if (exact !== undefined) {
    components.push({
      component: 'prompt_input',
      tokens: { p50: exact.tokens, p90: exact.tokens, p99: null },
      // Never pad a measured count — that is overquoting, not safety.
      context_safety_tokens: null,
      method: exact.method,
      confidence: exact.confidence,
      tier: exact.tier,
      note: null,
    });
    confidences.push(exact.confidence);
  } else {
    if (metrics.character_count === null) {
      return blocked(
        'character_count',
        'No character count and no exact tokenizer result, so there is nothing to count from.',
      );
    }
    const bucket = resolveCalibrationBucket(metrics);
    const row = findCalibration(calibration, model_id, bucket);
    if (row === null) {
      return blocked(
        `calibration[${model_id}/${bucket.script}/${bucket.content_type}]`,
        `No calibration samples for ${bucket.script} + ${bucket.content_type} on ${model_id}. ` +
          '§A4.5.4 permits a bootstrap ratio for English prose only; applying it to another script ' +
          'is wrong by a large factor and silent. Show a character count until this bucket is calibrated.',
      );
    }
    const heuristic = ratioTokens(metrics.character_count, row);
    components.push({
      component: 'prompt_input',
      tokens: heuristic,
      context_safety_tokens: Math.ceil(heuristic.p90 * (1 + heuristic_safety_pad_pct)),
      method: row.provenance.method,
      confidence: row.provenance.confidence,
      tier: 3,
      note:
        `Tier 3 heuristic: ${metrics.character_count} chars x ${row.tokens_per_char.p50}-` +
        `${row.tokens_per_char.p90} tokens/char (${bucket.script}/${bucket.content_type}, ` +
        `n=${row.n_samples}).`,
    });
    confidences.push(row.provenance.confidence);
  }

  /* ---- 2. framing overhead (§A5.1.2) ---- */
  // Chat-template scaffolding, role markers, BOS/EOS, separators. Per model and per
  // turn, derived empirically — never assumed constant across families.
  const perMessage = tokenizer.framing_tokens_per_message;
  const preamble = tokenizer.conversation_preamble_tokens;
  if (perMessage.value === null || preamble.value === null) {
    return blocked(
      'tokenizer.framing_tokens_per_message',
      'Framing overhead is unmeasured for this model. It is real and per-model; omitting it ' +
        'undercounts every message, so the estimate blocks rather than quietly dropping the term.',
    );
  }
  const framing = preamble.value + perMessage.value * message_count;
  const framingConfidence = minConfidence(perMessage.provenance.confidence, preamble.provenance.confidence);
  components.push({
    component: 'framing_overhead',
    tokens: { p50: framing, p90: framing, p99: null },
    context_safety_tokens: null,
    method:
      perMessage.provenance.method === preamble.provenance.method
        ? perMessage.provenance.method
        : 'DERIVED',
    confidence: framingConfidence,
    tier: 2,
    note: `${preamble.value} preamble + ${perMessage.value} x ${message_count} message(s).`,
  });
  confidences.push(framingConfidence);

  /* ---- 3. tool schemas (§A5.1.3) ---- */
  if (metrics.tool_schemas_present) {
    if (metrics.tool_schema_character_count === null) {
      return blocked(
        'tool_schema_character_count',
        'Tool schemas are present but uncounted. They are serialized into the context before the ' +
          'user types anything and frequently dominate a short prompt; null here silently zeroes them.',
      );
    }
    // A tool schema is JSON, not prose. It gets the structured_json bucket — a ratio
    // measured on prose says nothing about brace-heavy machine text.
    const jsonBucket: CalibrationBucket = {
      script: 'latin',
      content_type: 'structured_json',
    };
    const jsonRow = findCalibration(calibration, model_id, jsonBucket);
    if (jsonRow === null) {
      return blocked(
        `calibration[${model_id}/latin/structured_json]`,
        'Tool schemas are JSON and need their own calibration bucket; the prose ratio does not ' +
          'transfer. §A4.5.4 lists code and JSON as a separate bucket for exactly this reason.',
      );
    }
    const toolTokens = ratioTokens(metrics.tool_schema_character_count, jsonRow);
    components.push({
      component: 'tool_schema',
      tokens: toolTokens,
      context_safety_tokens: Math.ceil(toolTokens.p90 * (1 + heuristic_safety_pad_pct)),
      method: jsonRow.provenance.method,
      confidence: jsonRow.provenance.confidence,
      tier: 3,
      note: `${metrics.tool_schema_character_count} chars of tool schema, structured_json bucket.`,
    });
    confidences.push(jsonRow.provenance.confidence);
  }

  const total = components.reduce<Range>(
    (acc, c) => ({ p50: acc.p50 + c.tokens.p50, p90: acc.p90 + c.tokens.p90, p99: null }),
    { p50: 0, p90: 0, p99: null },
  );
  // Unpadded components contribute their own p90; only Tier 3 ones are padded.
  const contextSafetyTotal = components.reduce(
    (acc, c) => acc + (c.context_safety_tokens ?? c.tokens.p90),
    0,
  );

  return {
    status: 'COUNTED',
    components,
    total,
    context_safety_total: contextSafetyTotal,
    confidence: minConfidence(...confidences),
    tier: Math.max(...components.map((c) => c.tier)) as TokenTier,
  };
}

const ratioTokens = (chars: number, row: TextCalibration): Range => ({
  p50: Math.ceil(chars * row.tokens_per_char.p50),
  p90: Math.ceil(chars * row.tokens_per_char.p90),
  p99: null,
});

const blocked = (field: string, why: string): TextUnavailable => ({
  status: 'UNAVAILABLE',
  reason: why,
  missing_data: { field, why_it_matters: why, blocks_estimate: true },
});

/* ─────────────────────────── multi-turn growth (§A5.5) ─────────────────────────── */

export type HistoryStrategy = 'FULL_HISTORY' | 'SLIDING_WINDOW' | 'SUMMARIZED_ROLLUP';

export interface ConversationInput {
  /** System prompt + tool schemas: re-sent every turn, never part of history. */
  fixed_prefix_tokens: number;
  /** New user input per turn. */
  per_turn_input_tokens: number;
  /** Model output per turn — it becomes input on every later turn. */
  per_turn_output_tokens: number;
  turns: number;
  strategy: HistoryStrategy;
  /** Turns of history retained. Required for SLIDING_WINDOW. */
  window_k?: number;
  /**
   * Size of the rolled-up summary, for SUMMARIZED_ROLLUP. This is an ASSUMPTION —
   * nobody knows it before the run — so the caller must supply it and label it. No
   * default: a flattering guess here understates the single biggest lever in a
   * chatbot workflow.
   */
  rollup_tokens?: number;
  /** Turns between roll-ups, for SUMMARIZED_ROLLUP. */
  rollup_every_n?: number;
}

export type ConversationResult =
  | { status: 'COUNTED'; total_input_tokens: number; per_turn: number[] }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * Total INPUT tokens across a multi-turn conversation.
 *
 * A chat workflow re-sends its history every turn, so cost grows quadratically in
 * turns, not linearly — the term everyone forgets. With a fixed prefix `s`, per-turn
 * input `a` and output `b`, FULL_HISTORY over N turns is
 *
 *   Σ  s + a + (n-1)(a+b)   =   N(s+a) + (a+b)·N(N-1)/2
 *
 * which is why trimming history is usually the largest single saving available.
 */
export function conversationInputTokens(input: ConversationInput): ConversationResult {
  const { fixed_prefix_tokens: s, per_turn_input_tokens: a, per_turn_output_tokens: b, turns: N } = input;

  if (!Number.isInteger(N) || N < 1) return { status: 'UNAVAILABLE', reason: 'turns must be >= 1.' };
  if (s < 0 || a < 0 || b < 0) return { status: 'UNAVAILABLE', reason: 'token counts must be >= 0.' };

  const perTurn: number[] = [];

  switch (input.strategy) {
    case 'FULL_HISTORY':
      for (let n = 1; n <= N; n++) perTurn.push(s + a + (n - 1) * (a + b));
      break;

    case 'SLIDING_WINDOW': {
      const k = input.window_k;
      if (k === undefined || !Number.isInteger(k) || k < 1) {
        return {
          status: 'UNAVAILABLE',
          reason: 'SLIDING_WINDOW requires window_k — the window size is the whole cost.',
        };
      }
      for (let n = 1; n <= N; n++) perTurn.push(s + a + Math.min(n - 1, k) * (a + b));
      break;
    }

    case 'SUMMARIZED_ROLLUP': {
      const roll = input.rollup_tokens;
      const every = input.rollup_every_n;
      if (roll === undefined || roll < 0 || every === undefined || !Number.isInteger(every) || every < 1) {
        return {
          status: 'UNAVAILABLE',
          reason:
            'SUMMARIZED_ROLLUP requires rollup_tokens and rollup_every_n. The summary size is an ' +
            'assumption nobody knows before the run; it must be supplied and labelled, not defaulted ' +
            'to a flattering number.',
        };
      }
      // History since the last roll-up, plus one summary standing in for everything
      // before it. The summary itself is re-sent every turn once it exists.
      for (let n = 1; n <= N; n++) {
        const priorTurns = n - 1;
        const rollups = Math.floor(priorTurns / every);
        const sinceRollup = priorTurns - rollups * every;
        perTurn.push(s + a + sinceRollup * (a + b) + (rollups > 0 ? roll : 0));
      }
      break;
    }
  }

  return {
    status: 'COUNTED',
    total_input_tokens: perTurn.reduce((x, y) => x + y, 0),
    per_turn: perTurn,
  };
}
