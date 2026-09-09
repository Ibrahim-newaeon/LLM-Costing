// /packages/calibrate/src/calibrate.test.ts
//
// §A5.4 capture, offline. Every usage object below is SYNTHETIC — shaped after the
// vendor references cited in usage.ts, with token counts chosen for the test. No
// response here was ever returned by a provider.
//
//   pnpm vitest packages/calibrate     # offline, free, keyless

import { describe, it, expect } from 'vitest';
import { estimateOutputTokens } from '@tokenomics/estimator';
import type { OutputSample } from '@tokenomics/contracts';
import {
  ANTHROPIC_USAGE_REFERENCE,
  GEMINI_USAGE_REFERENCE,
  OPENAI_RESPONSES_USAGE_REFERENCE,
  buildOutputPriors,
  nearestRank,
  sampleFromAnthropicUsage,
  sampleFromGeminiUsage,
  sampleFromOpenAIResponsesUsage,
  sampleFromResponse,
} from './index';

const CTX = { model_id: 'claude-opus-5', band: 'medium' as const, observed_at: '2026-09-09T12:00:00.000Z' };
const NOW = '2026-09-09T13:00:00.000Z';

/* ─────────────────────────── adapters ─────────────────────────── */

describe('Anthropic: thinking is a category OF output_tokens', () => {
  it('visible = output_tokens − thinking_tokens; reasoning = thinking_tokens', () => {
    const s = sampleFromAnthropicUsage({ input_tokens: 2095, output_tokens: 503, output_tokens_details: { thinking_tokens: 120 } }, CTX);
    expect(s.visible_output_tokens).toBe(383);
    expect(s.reasoning_tokens).toBe(120);
    expect(s.provider).toBe('anthropic');
    expect(s.provenance).toMatchObject({ method: 'PROVIDER_COUNT_API', confidence: 'HIGH', source_class: 'MEASURED', source_url: ANTHROPIC_USAGE_REFERENCE, verified_at: CTX.observed_at });
  });

  it('a null breakdown records the whole output as visible with reasoning UNKNOWN, and says so', () => {
    const s = sampleFromAnthropicUsage({ output_tokens: 503, output_tokens_details: null }, CTX);
    expect(s.visible_output_tokens).toBe(503);
    expect(s.reasoning_tokens).toBeNull();
    expect(s.provenance.notes).toContain('may include thinking nobody can see');
  });

  it('thinking larger than output contradicts the documented containment — refused, not clamped', () => {
    expect(() => sampleFromAnthropicUsage({ output_tokens: 100, output_tokens_details: { thinking_tokens: 150 } }, CTX)).toThrow(/exceeds output_tokens/);
  });

  it('a usage object with a non-integer count is refused at the boundary', () => {
    expect(() => sampleFromAnthropicUsage({ output_tokens: '503' }, CTX)).toThrow();
  });
});

describe('OpenAI Responses: reasoning is a category OF output_tokens', () => {
  it('visible = output_tokens − reasoning_tokens', () => {
    const s = sampleFromOpenAIResponsesUsage({ input_tokens: 8438, output_tokens: 398, output_tokens_details: { reasoning_tokens: 300 }, total_tokens: 8836 }, { ...CTX, model_id: 'synthetic-openai-model' });
    expect(s.visible_output_tokens).toBe(98);
    expect(s.reasoning_tokens).toBe(300);
    expect(s.provenance.source_url).toBe(OPENAI_RESPONSES_USAGE_REFERENCE);
  });

  it('zero reasoning is zero, not unknown', () => {
    const s = sampleFromOpenAIResponsesUsage({ output_tokens: 398, output_tokens_details: { reasoning_tokens: 0 } }, CTX);
    expect(s.reasoning_tokens).toBe(0);
    expect(s.visible_output_tokens).toBe(398);
  });

  // Added after a mutation survived: the Anthropic guard had this test, the OpenAI
  // one did not, and clamping the difference to zero went unnoticed.
  it('reasoning larger than output contradicts the documented containment — refused, not clamped', () => {
    expect(() => sampleFromOpenAIResponsesUsage({ output_tokens: 100, output_tokens_details: { reasoning_tokens: 150 } }, CTX)).toThrow(/exceeds output_tokens/);
  });
});

describe('Google Gemini: thoughts are ADDITIONAL to candidatesTokenCount', () => {
  it('visible = candidatesTokenCount as it stands; reasoning = thoughtsTokenCount', () => {
    const s = sampleFromGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 250, thoughtsTokenCount: 900, totalTokenCount: 1160 }, { ...CTX, model_id: 'gemini-2.5-pro' });
    expect(s.visible_output_tokens).toBe(250); // NOT 250 − 900
    expect(s.reasoning_tokens).toBe(900);
    expect(s.provenance.source_url).toBe(GEMINI_USAGE_REFERENCE);
  });

  it('an absent thoughtsTokenCount is UNKNOWN, not zero — proto3 omits zero-valued integers', () => {
    const s = sampleFromGeminiUsage({ candidatesTokenCount: 250, totalTokenCount: 260 }, { ...CTX, model_id: 'gemini-2.5-pro' });
    expect(s.reasoning_tokens).toBeNull();
    expect(s.provenance.notes).toContain('recorded as unknown (null), not zero');
  });

  it('a caller that knows thinking was off can say so, and then absent means zero', () => {
    const s = sampleFromGeminiUsage({ candidatesTokenCount: 250 }, { ...CTX, model_id: 'gemini-2.5-pro', thoughts_known_zero: true });
    expect(s.reasoning_tokens).toBe(0);
    expect(s.provenance.notes).toBeNull();
  });
});

describe('sampleFromResponse — the one call an integration makes', () => {
  it('finds usage where each provider puts it and keeps the response id for dedupe', () => {
    const a = sampleFromResponse('anthropic', { id: 'msg_synthetic_1', usage: { output_tokens: 50, output_tokens_details: { thinking_tokens: 5 } } }, CTX);
    const o = sampleFromResponse('openai', { id: 'resp_synthetic_1', usage: { output_tokens: 50, output_tokens_details: { reasoning_tokens: 5 } } }, CTX);
    const g = sampleFromResponse('google', { responseId: 'gem_synthetic_1', usageMetadata: { candidatesTokenCount: 45, thoughtsTokenCount: 5 } }, CTX);
    for (const r of [a, o, g]) {
      expect(r.status).toBe('CAPTURED');
      if (r.status === 'CAPTURED') { expect(r.sample.visible_output_tokens).toBe(45); expect(r.sample.reasoning_tokens).toBe(5); expect(r.sample.response_id).toMatch(/synthetic_1$/); }
    }
  });

  it('refuses, with a reason, rather than throwing into an integration', () => {
    expect(sampleFromResponse('anthropic', { id: 'x' }, CTX)).toEqual({ status: 'REFUSED', reason: expect.stringContaining('usage') });
    expect(sampleFromResponse('google', 'not json', CTX)).toEqual({ status: 'REFUSED', reason: expect.stringContaining('not a JSON object') });
    expect(sampleFromResponse('anthropic', { usage: { output_tokens: 1, output_tokens_details: { thinking_tokens: 2 } } }, CTX).status).toBe('REFUSED');
  });
});

/* ─────────────────────────── the builder ─────────────────────────── */

/** SYNTHETIC samples with chosen visible/reasoning counts. */
const sample = (visible: number, reasoning: number | null, over: Partial<OutputSample> = {}): OutputSample => ({
  ...sampleFromAnthropicUsage(
    { output_tokens: visible + (reasoning ?? 0), output_tokens_details: reasoning === null ? null : { thinking_tokens: reasoning } },
    CTX,
  ),
  ...over,
});

describe('nearestRank', () => {
  it('is the value at ceil(p/100 × n), never an interpolation', () => {
    expect(nearestRank([10, 20, 30, 40], 50)).toBe(20);
    expect(nearestRank([10, 20, 30, 40], 90)).toBe(40);
    expect(nearestRank([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90)).toBe(90);
    expect(nearestRank([7], 50)).toBe(7);
    expect(nearestRank([7], 90)).toBe(7);
  });
  it('refuses an empty sample', () => {
    expect(() => nearestRank([], 50)).toThrow();
  });
});

describe('buildOutputPriors — a prior from samples and from nothing else', () => {
  const ten = [120, 80, 200, 150, 90, 300, 110, 130, 170, 100].map((v, i) => sample(v, 40 + i * 10));

  it('min_samples is required and must be a positive integer', () => {
    expect(() => buildOutputPriors(ten, { min_samples: 0, now: NOW })).toThrow(/min_samples/);
    expect(() => buildOutputPriors(ten, { min_samples: Number.NaN, now: NOW })).toThrow(/min_samples/);
  });

  it('below min_samples: LOW, CALIBRATED_FROM_OBSERVED, and CALIBRATION_SAMPLE_TOO_SMALL raised with the numbers', () => {
    const r = buildOutputPriors(ten, { min_samples: 200, now: NOW });
    expect(r.priors).toHaveLength(1);
    const p = r.priors[0]!;
    expect(p).toMatchObject({ model_id: 'claude-opus-5', band: 'medium', n_samples: 10, seed_provenance: 'CALIBRATED_FROM_OBSERVED' });
    expect(p.output_tokens).toEqual({ p50: 120, p90: 200 }); // sorted: 80 90 100 110 120 130 150 170 200 300 → rank 5, rank 9
    expect(p.reasoning_tokens).toEqual({ p50: 80, p90: 120 });
    expect(p.provenance).toMatchObject({ method: 'CALIBRATED_HEURISTIC', confidence: 'LOW', source_class: 'MEASURED', verified_at: NOW });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ code: 'CALIBRATION_SAMPLE_TOO_SMALL', severity: 'WARN' });
    expect(r.warnings[0]!.message).toContain('10 sample(s)');
    expect(r.warnings[0]!.message).toContain('200');
    expect(r.refused).toEqual([]);
  });

  it('at min_samples: MEDIUM and no warning — never HIGH', () => {
    const r = buildOutputPriors(ten, { min_samples: 10, now: NOW });
    expect(r.priors[0]!.provenance.confidence).toBe('MEDIUM');
    expect(r.warnings).toEqual([]);
  });

  it('one unknown reasoning figure withholds the whole reasoning distribution', () => {
    const r = buildOutputPriors([...ten, sample(140, null)], { min_samples: 5, now: NOW });
    expect(r.priors[0]!.reasoning_tokens).toBeNull();
    expect(r.priors[0]!.provenance.notes).toContain('1 of 11 samples reported no reasoning figure');
  });

  it('groups by (model, band) and never mixes bands', () => {
    const r = buildOutputPriors([...ten, sample(2000, 500, { band: 'long' }), sample(2200, 600, { band: 'long' })], { min_samples: 2, now: NOW });
    expect(r.priors.map((p) => `${p.band}:${p.output_tokens.p50}`)).toEqual(['long:2000', 'medium:120']);
  });

  it('a re-captured response is one sample, not two', () => {
    const dup = sample(999, 1, { response_id: 'msg_same' });
    const r = buildOutputPriors([dup, { ...dup }, sample(100, 1)], { min_samples: 1, now: NOW });
    expect(r.duplicates).toBe(1);
    expect(r.priors[0]!.n_samples).toBe(2);
  });

  it('an unbounded band with no spread is refused, not given a fake width', () => {
    const r = buildOutputPriors([sample(500, 0, { band: 'unbounded' }), sample(500, 0, { band: 'unbounded' })], { min_samples: 1, now: NOW });
    expect(r.priors).toEqual([]);
    expect(r.refused[0]).toMatchObject({ band: 'unbounded', reason: expect.stringContaining('zero-width') });
  });

  it('samples naming two providers for one model are a mapping error, refused', () => {
    const r = buildOutputPriors([...ten, sample(100, 1, { provider: 'openai' })], { min_samples: 1, now: NOW });
    expect(r.priors).toEqual([]);
    expect(r.refused[0]!.reason).toContain('2 providers');
  });
});

/* ─────────────────────────── the guard downstream ─────────────────────────── */

describe('the estimator stops refusing when a prior exists — and still refuses what it should', () => {
  const ten = [120, 80, 200, 150, 90, 300, 110, 130, 170, 100].map((v, i) => sample(v, 40 + i * 10));

  it('no prior: UNAVAILABLE (today)', () => {
    const r = estimateOutputTokens({ model_id: 'claude-opus-5', band: 'medium', priors: [], is_reasoning_model: true, max_tokens: null, max_tokens_includes_reasoning: true });
    expect(r.status).toBe('UNAVAILABLE');
  });

  it('a built prior: ESTIMATED, billable = visible + reasoning, confidence from the prior', () => {
    const { priors } = buildOutputPriors(ten, { min_samples: 200, now: NOW });
    const r = estimateOutputTokens({ model_id: 'claude-opus-5', band: 'medium', priors, is_reasoning_model: true, max_tokens: null, max_tokens_includes_reasoning: true });
    expect(r.status).toBe('ESTIMATED');
    if (r.status !== 'ESTIMATED') return;
    expect(r.billable_output).toMatchObject({ p50: 200, p90: 320 });
    expect(r.method).toBe('CALIBRATED_HEURISTIC');
    expect(r.confidence).toBe('LOW');
    expect(r.warnings.map((w) => w.code)).toContain('REASONING_TOKENS_ESTIMATED');
  });

  it('a reasoning model whose samples never reported reasoning still refuses — the invisible term is not zero', () => {
    const { priors } = buildOutputPriors(ten.map((s) => ({ ...s, reasoning_tokens: null })), { min_samples: 1, now: NOW });
    expect(priors[0]!.reasoning_tokens).toBeNull();
    const r = estimateOutputTokens({ model_id: 'claude-opus-5', band: 'medium', priors, is_reasoning_model: true, max_tokens: null, max_tokens_includes_reasoning: true });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.missing_data.field).toContain('reasoning_tokens');
  });
});
