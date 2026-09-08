import { describe, it, expect } from 'vitest';
import { TextCalibration, TokenizerProfile } from '@tokenomics/contracts';
import {
  countTextTokens,
  conversationInputTokens,
  resolveCalibrationBucket,
} from './text';

const prov = (over: Record<string, unknown> = {}) => ({
  method: 'CALIBRATED_HEURISTIC',
  confidence: 'MEDIUM',
  source_class: 'MEASURED',
  source_url: 'https://example.invalid/calibration',
  verified_at: '2026-09-01T00:00:00.000Z',
  verified_by: null,
  notes: null,
  ...over,
});
const src = (value: unknown, p = prov()) => ({ value, provenance: p });

const cal = (over: Record<string, unknown> = {}) =>
  TextCalibration.parse({
    model_id: 'm1',
    bucket: { script: 'latin', content_type: 'prose' },
    tokens_per_char: { p50: 0.25, p90: 0.29 },
    n_samples: 500,
    seed_provenance: 'CALIBRATED_FROM_OBSERVED',
    provenance: prov(),
    ...over,
  });

const tokenizer = (over: Record<string, unknown> = {}) =>
  TokenizerProfile.parse({
    availability: 'LOCAL_EXACT',
    identifier: 'o200k_base',
    revision_hash: 'abc123',
    tokenizer_multiplier: src(1),
    framing_tokens_per_message: src(4),
    conversation_preamble_tokens: src(7),
    ...over,
  });

const metrics = (over: Record<string, unknown> = {}) => ({
  character_count: 4000,
  script_mix: { latin: 1 },
  arabic_register: null,
  diacritic_density: null,
  content_type: 'prose' as const,
  tool_schemas_present: false,
  tool_schema_character_count: null,
  ...over,
});

const base = {
  model_id: 'm1',
  tokenizer: tokenizer(),
  calibration: [cal()],
  message_count: 3,
  heuristic_safety_pad_pct: 0.15,
};

describe('§A4.5.4 — the ratio you may not generalize', () => {
  it('counts English prose from a calibrated ratio', () => {
    const r = countTextTokens({ ...base, metrics: metrics() });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    // 4000 chars x 0.25 / 0.29, plus 7 preamble + 4 x 3 messages
    expect(r.components[0]!.tokens).toEqual({ p50: 1000, p90: 1160, p99: null });
    expect(r.components[1]!.tokens.p50).toBe(19);
    expect(r.total.p50).toBe(1019);
  });

  it('REFUSES Arabic rather than borrowing the Latin ratio', () => {
    const r = countTextTokens({
      ...base,
      metrics: metrics({ script_mix: { arabic: 1 }, arabic_register: 'msa' }),
    });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') {
      expect(r.missing_data.field).toContain('ar_msa');
      expect(r.missing_data.blocks_estimate).toBe(true);
    }
  });

  it('refuses a mixed-script document too — a 70/30 split is not Latin', () => {
    const r = countTextTokens({
      ...base,
      metrics: metrics({ script_mix: { latin: 0.7, arabic: 0.3 } }),
    });
    expect(r.status).toBe('UNAVAILABLE');
  });

  it('counts Arabic once the bucket IS calibrated', () => {
    const arabic = cal({
      bucket: { script: 'ar_msa', content_type: 'prose' },
      tokens_per_char: { p50: 0.5, p90: 0.62 },
    });
    const r = countTextTokens({
      ...base,
      calibration: [cal(), arabic],
      metrics: metrics({ script_mix: { arabic: 1 }, arabic_register: 'msa' }),
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    // Twice the tokens per character of Latin — which is the whole point.
    expect(r.components[0]!.tokens.p50).toBe(2000);
  });
});

describe('bucket resolution', () => {
  it('routes vocalized Arabic to its own bucket, by measured density', () => {
    expect(
      resolveCalibrationBucket(metrics({ script_mix: { arabic: 1 }, diacritic_density: 0.4 })).script,
    ).toBe('ar_vocalized');
  });

  it('will not pick between Hans and Hant on a document that does not say', () => {
    expect(resolveCalibrationBucket(metrics({ script_mix: { han: 1 } })).script).toBe('mixed');
  });

  it('sends cyrillic to mixed — there is no bucket for it', () => {
    expect(resolveCalibrationBucket(metrics({ script_mix: { cyrillic: 1 } })).script).toBe('mixed');
  });
});

describe('§A5.1 — the three components', () => {
  it('bills framing overhead per message, plus a preamble', () => {
    const r = countTextTokens({ ...base, metrics: metrics(), message_count: 10 });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.components[1]!.tokens.p50).toBe(7 + 4 * 10);
  });

  it('blocks when framing overhead is unmeasured rather than dropping the term', () => {
    const r = countTextTokens({
      ...base,
      metrics: metrics(),
      tokenizer: tokenizer({ framing_tokens_per_message: { value: null, provenance: prov() } }),
    });
    expect(r.status).toBe('UNAVAILABLE');
  });

  it('prices tool schemas from the structured_json bucket, not the prose one', () => {
    const json = cal({
      bucket: { script: 'latin', content_type: 'structured_json' },
      tokens_per_char: { p50: 0.4, p90: 0.45 },
    });
    const r = countTextTokens({
      ...base,
      calibration: [cal(), json],
      metrics: metrics({ tool_schemas_present: true, tool_schema_character_count: 1000 }),
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    const tool = r.components.find((c) => c.component === 'tool_schema')!;
    expect(tool.tokens.p50).toBe(400); // the JSON ratio, not the prose 0.25
  });

  it('refuses when tool schemas are present but only a prose bucket exists', () => {
    const r = countTextTokens({
      ...base,
      metrics: metrics({ tool_schemas_present: true, tool_schema_character_count: 1000 }),
    });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.missing_data.field).toContain('structured_json');
  });
});

describe('§A4.5.5 — padding is directional', () => {
  it('pads the context-safety number and leaves the cost number alone', () => {
    const r = countTextTokens({ ...base, metrics: metrics() });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    const prompt = r.components[0]!;
    expect(prompt.tokens.p90).toBe(1160);
    expect(prompt.context_safety_tokens).toBe(Math.ceil(1160 * 1.15));
    expect(prompt.context_safety_tokens).toBeGreaterThan(prompt.tokens.p90);
  });

  it('never pads a measured count — that is overquoting, not safety', () => {
    const r = countTextTokens({
      ...base,
      metrics: metrics(),
      exact: { tokens: 1234, method: 'EXACT_TOKENIZER', confidence: 'HIGH', tier: 2, covers: 'PROMPT_ONLY' },
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.components[0]!.context_safety_tokens).toBeNull();
    expect(r.components[0]!.tokens).toEqual({ p50: 1234, p90: 1234, p99: null });
  });

  it('carries a supplied tier through instead of re-tagging it', () => {
    const r = countTextTokens({
      ...base,
      metrics: metrics(),
      exact: { tokens: 900, method: 'PROVIDER_COUNT_API', confidence: 'HIGH', tier: 1, covers: 'WHOLE_REQUEST' },
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.components[0]!.tier).toBe(1);
    expect(r.components[0]!.method).toBe('PROVIDER_COUNT_API');
  });
});

/* ══════════════ `covers` — the double-count this shape exists to prevent ══════════════ */

describe('an exact count says what it already contains', () => {
  it('PROMPT_ONLY still owes framing and tool schemas', () => {
    const r = countTextTokens({
      ...base,
      metrics: metrics(),
      exact: { tokens: 1000, method: 'EXACT_TOKENIZER', confidence: 'HIGH', tier: 2, covers: 'PROMPT_ONLY' },
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.components.map((c) => c.component)).toContain('framing_overhead');
    expect(r.total.p50).toBeGreaterThan(1000);
  });

  it('WHOLE_REQUEST is the entire answer — nothing is added to it', () => {
    // Anthropic's count-tokens endpoint is handed the whole request and its count
    // "includes system prompts, tool definitions, messages". Adding §A5.1.2 framing
    // or §A5.1.3 tool schemas on top bills the same tokens twice.
    const r = countTextTokens({
      ...base,
      metrics: metrics(),
      exact: { tokens: 1000, method: 'PROVIDER_COUNT_API', confidence: 'HIGH', tier: 1, covers: 'WHOLE_REQUEST' },
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.components).toHaveLength(1);
    expect(r.total).toEqual({ p50: 1000, p90: 1000, p99: null });
    expect(r.components[0]!.note).toMatch(/bill the same tokens twice/);
  });

  it('WHOLE_REQUEST does not block on unmeasured framing — the count already measured it', () => {
    // Before `covers` existed this was the harder half of the bug: an Anthropic
    // tier-1 count REFUSED, because framing_tokens_per_message is unpublished, on a
    // term the provider's own number already contained.
    const r = countTextTokens({
      ...base,
      metrics: metrics(),
      tokenizer: tokenizer({
        framing_tokens_per_message: src(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
        conversation_preamble_tokens: src(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
      }),
      exact: { tokens: 1000, method: 'PROVIDER_COUNT_API', confidence: 'HIGH', tier: 1, covers: 'WHOLE_REQUEST' },
    });
    expect(r.status).toBe('COUNTED');

    // The same row with a PROMPT_ONLY count still blocks, because then the framing
    // really is owed and really is unmeasured.
    const owed = countTextTokens({
      ...base,
      metrics: metrics(),
      tokenizer: tokenizer({
        framing_tokens_per_message: src(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
        conversation_preamble_tokens: src(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
      }),
      exact: { tokens: 1000, method: 'EXACT_TOKENIZER', confidence: 'HIGH', tier: 2, covers: 'PROMPT_ONLY' },
    });
    expect(owed.status).toBe('UNAVAILABLE');
  });

  it('WHOLE_REQUEST skips tool schemas even when the task has them', () => {
    const r = countTextTokens({
      ...base,
      metrics: metrics({ tool_schemas_present: true, tool_schema_character_count: 4000 }),
      exact: { tokens: 1000, method: 'PROVIDER_COUNT_API', confidence: 'HIGH', tier: 1, covers: 'WHOLE_REQUEST' },
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.components.map((c) => c.component)).not.toContain('tool_schema');
    expect(r.total.p50).toBe(1000);
  });

  it('carries a vendor caveat onto the line', () => {
    const r = countTextTokens({
      ...base,
      metrics: metrics(),
      exact: {
        tokens: 1000, method: 'PROVIDER_COUNT_API', confidence: 'HIGH', tier: 1,
        covers: 'WHOLE_REQUEST',
        note: 'May include system-added tokens that are not billed.',
      },
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.components[0]!.note).toMatch(/not billed/);
  });
});

describe('confidence propagates by minimum', () => {
  it('takes the weakest of the calibration row and the framing measurement', () => {
    const r = countTextTokens({
      ...base,
      metrics: metrics(),
      tokenizer: tokenizer({ framing_tokens_per_message: src(4, prov({ confidence: 'LOW' })) }),
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.confidence).toBe('LOW');
  });
});

describe('§A5.5 — multi-turn growth is quadratic, not linear', () => {
  const conv = { fixed_prefix_tokens: 1000, per_turn_input_tokens: 100, per_turn_output_tokens: 200 };

  it('matches the closed form for FULL_HISTORY', () => {
    const N = 10;
    const r = conversationInputTokens({ ...conv, turns: N, strategy: 'FULL_HISTORY' });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    // N(s+a) + (a+b)N(N-1)/2
    expect(r.total_input_tokens).toBe(N * 1100 + 300 * ((N * (N - 1)) / 2));
  });

  it('grows faster than linearly — doubling the turns more than doubles the cost', () => {
    const at = (n: number) => {
      const r = conversationInputTokens({ ...conv, turns: n, strategy: 'FULL_HISTORY' });
      return r.status === 'COUNTED' ? r.total_input_tokens : 0;
    };
    expect(at(20)).toBeGreaterThan(2 * at(10));
  });

  it('SLIDING_WINDOW flattens it, and requires the window size', () => {
    const missing = conversationInputTokens({ ...conv, turns: 10, strategy: 'SLIDING_WINDOW' });
    expect(missing.status).toBe('UNAVAILABLE');

    const r = conversationInputTokens({ ...conv, turns: 20, strategy: 'SLIDING_WINDOW', window_k: 3 });
    const full = conversationInputTokens({ ...conv, turns: 20, strategy: 'FULL_HISTORY' });
    if (r.status !== 'COUNTED' || full.status !== 'COUNTED') throw new Error('unexpected');
    expect(r.total_input_tokens).toBeLessThan(full.total_input_tokens);
    // Once past the window the per-turn cost is constant.
    expect(r.per_turn[19]).toBe(r.per_turn[18]);
  });

  it('refuses SUMMARIZED_ROLLUP without a stated summary size', () => {
    const r = conversationInputTokens({ ...conv, turns: 10, strategy: 'SUMMARIZED_ROLLUP' });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toContain('assumption');
  });

  it('prices SUMMARIZED_ROLLUP when the assumption is supplied', () => {
    const r = conversationInputTokens({
      ...conv, turns: 20, strategy: 'SUMMARIZED_ROLLUP', rollup_tokens: 400, rollup_every_n: 5,
    });
    const full = conversationInputTokens({ ...conv, turns: 20, strategy: 'FULL_HISTORY' });
    if (r.status !== 'COUNTED' || full.status !== 'COUNTED') throw new Error('unexpected');
    expect(r.total_input_tokens).toBeLessThan(full.total_input_tokens);
  });
});
