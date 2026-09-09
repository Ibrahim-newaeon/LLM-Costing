// /packages/e2e/src/priors.test.ts
//
// §A5.4 → §A11: the output side of a quote stops refusing once a prior exists.
//
//   response body → sampleFromResponse → OutputSample[]
//                 → buildOutputPriors  → OutputPrior + CALIBRATION_SAMPLE_TOO_SMALL
//                 → estimateOutputTokens → billable range
//                 → buildLine(completion_output) → assembleCandidate → assembleEstimate
//
// Every response body below is SYNTHETIC — shaped after the Anthropic reference
// cited in calibrate/usage.ts, with chosen counts. No key exists in this repo and
// no call was made. What is real is the registry rate the line is priced at.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Registry } from '@tokenomics/contracts';
import { parseL1 } from '@tokenomics/parser';
import {
  assembleCandidate,
  assembleEstimate,
  buildLine,
  estimateOutputTokens,
} from '@tokenomics/estimator';
import { buildOutputPriors, sampleFromResponse } from '@tokenomics/calibrate';

const ROOT = join(__dirname, '..', '..', '..');
const registry = Registry.parse(JSON.parse(readFileSync(join(ROOT, 'registry', 'registry.json'), 'utf8')));
const opus = registry.models.find((m) => m.model_id === 'claude-opus-5')!;
const outputRate = opus.text_rates[0]!.output_rate; // $25 per 1M, vendor-sourced

const SEED = [
  { doc_class: 'long_form' as const, input_tokens: 1_500, output_tokens: 300, image_width_px: null, image_height_px: null, image_detail: null, source: 'USER_SUPPLIED_BASELINE' as const },
];

/** SYNTHETIC response bodies: ten "summaries" with visible 80–300 and thinking 40–130. */
const bodies = [120, 80, 200, 150, 90, 300, 110, 130, 170, 100].map((visible, i) => ({
  id: `msg_synthetic_${i}`,
  usage: { input_tokens: 1_500, output_tokens: visible + 40 + i * 10, output_tokens_details: { thinking_tokens: 40 + i * 10 } },
}));

describe('§A5.4 → §A11: from captured responses to a priced output line', () => {
  it('today, with no prior, the output line refuses', () => {
    const r = estimateOutputTokens({ model_id: opus.model_id, band: 'medium', priors: [], is_reasoning_model: opus.is_reasoning_model, max_tokens: null, max_tokens_includes_reasoning: true });
    expect(r.status).toBe('UNAVAILABLE');
  });

  it('ten captured responses become a LOW prior, the line prices at the registry rate, and the warning reaches the estimate', () => {
    const samples = bodies.map((b, i) => {
      const r = sampleFromResponse('anthropic', b, { model_id: opus.model_id, band: 'medium', observed_at: `2026-09-09T12:${String(i).padStart(2, '0')}:00.000Z` });
      if (r.status !== 'CAPTURED') throw new Error(r.reason);
      return r.sample;
    });
    const built = buildOutputPriors(samples, { min_samples: 200, now: '2026-09-09T13:00:00.000Z' });
    expect(built.priors).toHaveLength(1);
    expect(built.warnings.map((w) => w.code)).toEqual(['CALIBRATION_SAMPLE_TOO_SMALL']);

    const out = estimateOutputTokens({
      model_id: opus.model_id,
      band: 'medium',
      priors: built.priors,
      is_reasoning_model: opus.is_reasoning_model,
      max_tokens: null,
      max_tokens_includes_reasoning: true,
    });
    expect(out.status).toBe('ESTIMATED');
    if (out.status !== 'ESTIMATED') return;
    // nearest-rank over ten: visible p50 120 / p90 200; thinking p50 80 / p90 120
    expect(out.billable_output).toMatchObject({ p50: 200, p90: 320 });
    expect(out.confidence).toBe('LOW');

    const line = buildLine({
      task_id: 't1',
      component: 'completion_output',
      quantity: out.billable_output,
      unit: 'tokens',
      rate_amount: outputRate.amount / 1_000_000,
      rate_record_id: 'claude-opus-5:output',
      method: out.method,
      confidence: out.confidence,
    });
    expect(line.cost?.p50).toBeCloseTo(0.005, 9); // 200 tokens × $25/M
    expect(line.cost?.p90).toBeCloseTo(0.008, 9); // 320 tokens × $25/M

    // "this text", not "the report": a document of unknown kind carries a blocking
    // pdf_has_text_layer gap, which would set needs_human_review for a reason that
    // has nothing to do with the warning under test.
    const parsed = parseL1({ text: 'summarize this text', seed: SEED });
    expect(parsed.status === 'PARSED' && parsed.workflow.missing_data.some((m) => m.blocks_estimate)).toBe(false);
    if (parsed.status !== 'PARSED') throw new Error(parsed.reason);
    const estimate = assembleEstimate({
      estimate_id: 'e-prior',
      generated_at: '2026-09-09T13:00:00.000Z',
      pricing_snapshot_id: 'snap-1',
      workflow: parsed.workflow,
      candidates: [assembleCandidate({ model_id: opus.model_id, provider_id: opus.provider, deployment_mode: 'API_MANAGED', currency: 'USD', lines: [line] })],
      evidence: [],
      warnings: built.warnings,
    });
    expect(estimate.warnings.map((w) => w.code)).toContain('CALIBRATION_SAMPLE_TOO_SMALL');
    // §A3.7 — a LOW prior makes a LOW estimate; a WARN does not force review.
    expect(estimate.confidence).toBe('LOW');
    expect(estimate.needs_human_review).toBe(false);
  });

  it('two hundred responses make the same prior MEDIUM with no warning — and the estimate follows', () => {
    const samples = Array.from({ length: 200 }, (_, i) => {
      const r = sampleFromResponse('anthropic', { id: `msg_synthetic_${i}`, usage: { output_tokens: 100 + (i % 50) + 60, output_tokens_details: { thinking_tokens: 60 } } }, { model_id: opus.model_id, band: 'medium', observed_at: '2026-09-09T12:00:00.000Z' });
      if (r.status !== 'CAPTURED') throw new Error(r.reason);
      return r.sample;
    });
    const built = buildOutputPriors(samples, { min_samples: 200, now: '2026-09-09T13:00:00.000Z' });
    expect(built.warnings).toEqual([]);
    expect(built.priors[0]!.provenance.confidence).toBe('MEDIUM');
    expect(built.priors[0]!.n_samples).toBe(200);
  });
});
