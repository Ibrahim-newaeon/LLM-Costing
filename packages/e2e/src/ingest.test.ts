// /packages/e2e/src/ingest.test.ts
//
// Rule 5, end to end: a disagreement found by ingestion reaches an estimate.
//
//   feed → snapshot → observations → compareRates → applyConflicts → registry
//   registry rate → rateConflictWarnings → assembleEstimate → needs_human_review
//
// Every step exists and is unit-tested in its own package. What no package test
// can show is that the conflict written by one is the conflict read by the other,
// and that the estimate at the end says so — which is the whole of rule 5.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Registry, type RateObservation } from '@tokenomics/contracts';
import { parseL1 } from '@tokenomics/parser';
import {
  assembleCandidate,
  assembleEstimate,
  buildLine,
  exactRange,
  rateConflictWarnings,
} from '@tokenomics/estimator';
import {
  applyConflicts,
  compareRates,
  diffObservations,
  extractLiteLLM,
  fixturePort,
  LiteLLMKeyMap,
  openConflicts,
  priceChangeWarnings,
  takeSnapshot,
} from '@tokenomics/ingest';

const ROOT = join(__dirname, '..', '..', '..');
const registry = Registry.parse(JSON.parse(readFileSync(join(ROOT, 'registry', 'registry.json'), 'utf8')));
const fixture = JSON.parse(readFileSync(join(ROOT, 'packages', 'ingest', 'src', 'fixtures', 'litellm.excerpt.json'), 'utf8'));
const source = JSON.parse(readFileSync(join(ROOT, 'registry', 'sources', 'litellm.json'), 'utf8'));

const SEED = [
  { doc_class: 'long_form' as const, input_tokens: 1_500, output_tokens: 300, image_width_px: null, image_height_px: null, image_detail: null, source: 'USER_SUPPLIED_BASELINE' as const },
];

async function ingest() {
  const spec = { source_id: source.source_id, source_class: source.source_class, source_url: source.source_url };
  const body = JSON.stringify(fixture.feed);
  const snap = await takeSnapshot(fixturePort({ [spec.source_url]: body }), spec, new Date(fixture._fixture.retrieved_at));
  if (snap.status !== 'OK') throw new Error(snap.reason);
  return { snapshot: snap.snapshot, ...extractLiteLLM({ body, snapshot: snap.snapshot, keys: LiteLLMKeyMap.parse(source.keys), currency: source.currency.value }) };
}

describe('§A6 → §A11: a conflict travels from the feed to the estimate', () => {
  it('on the real feed there is nothing to travel — every comparable figure agrees, and the estimate needs no review', async () => {
    const { observations } = await ingest();
    const cs = registry.models.flatMap((m) => compareRates(m, observations, 0));
    expect(cs.filter((c) => c.outcome === 'CONFLICT')).toEqual([]);
    expect(cs.filter((c) => c.outcome === 'AGREE').length).toBeGreaterThanOrEqual(8);
    expect(openConflicts(applyConflicts(registry, cs).registry)).toEqual([]);
  });

  it('a SYNTHETIC disagreement lands on the rate, is read back as BLOCKING, and flips needs_human_review', async () => {
    const { observations } = await ingest();
    const opus = registry.models.find((m) => m.model_id === 'claude-opus-5')!;
    const real = observations.find(
      (o): o is RateObservation => o.kind === 'RATE' && o.model_id === opus.model_id && o.key.direction === 'input' && o.key.modality === 'text',
    )!;
    // SYNTHETIC: the real reading doubled, from a reserved-domain "source".
    const doubled: RateObservation = {
      ...real,
      amount: real.amount * 2,
      snapshot_id: 'SYNTHETIC@2026-09-09T00:00:00.000Z',
      provenance: { ...real.provenance, source_url: 'https://example.invalid/synthetic-second-source.json' },
    };

    const { registry: next, applied } = applyConflicts(registry, compareRates(opus, [doubled], 5));
    expect(applied).toHaveLength(1);
    const rate = next.models.find((m) => m.model_id === opus.model_id)!.text_rates[0]!.input_rate_by_modality.text!;

    // The estimate is priced at the REGISTRY figure — the conflict changes the flag, not the number.
    const line = buildLine({
      task_id: 't1',
      component: 'prompt_input',
      quantity: exactRange(1_500),
      unit: 'tokens',
      rate_amount: rate.amount / 1_000_000,
      rate_record_id: 'claude-opus-5:input:text',
      method: 'PROVIDER_FORMULA',
      confidence: 'HIGH',
    });
    const parsed = parseL1({ text: 'summarize the report', seed: SEED });
    if (parsed.status !== 'PARSED') throw new Error(parsed.reason);

    const estimate = assembleEstimate({
      estimate_id: 'e-conflict',
      generated_at: '2026-09-09T00:00:00.000Z',
      pricing_snapshot_id: 'snap-1',
      workflow: parsed.workflow,
      candidates: [
        assembleCandidate({ model_id: opus.model_id, provider_id: opus.provider, deployment_mode: 'API_MANAGED', currency: 'USD', lines: [line] }),
      ],
      evidence: [],
      warnings: rateConflictWarnings([rate]),
    });

    const w = estimate.warnings.find((x) => x.code === 'RATE_CONFLICT_UNRESOLVED')!;
    expect(w.severity).toBe('BLOCKING');
    expect(w.message).toContain('5 per_1m_tokens USD');
    expect(w.message).toContain('states 10');
    expect(estimate.needs_human_review).toBe(true);
    expect(estimate.candidates[0]!.lines[0]!.cost!.p50).toBeCloseTo(0.0075, 9); // 1500 tokens at $5/M — the registry rate, not 10, not 7.5
  });

  it('a price that moved between two pulls reaches the estimate as PRICE_CHANGED_SINCE_LAST_RUN', async () => {
    const { observations } = await ingest();
    const real = observations.find((o): o is RateObservation => o.kind === 'RATE' && o.model_id === 'gemini-2.5-pro' && o.key.direction === 'output' && o.key.above_tokens === null)!;
    // SYNTHETIC previous pull: the same figure 20% lower (0.000008, not 0.8 × 0.00001, which is float residue).
    const previous = observations.map((o) => (o === real ? { ...real, amount: 0.000008, snapshot_id: 'SYNTHETIC-previous' } : o));
    const warnings = priceChangeWarnings(diffObservations(previous, observations));
    expect(warnings).toHaveLength(1);

    const parsed = parseL1({ text: 'summarize the report', seed: SEED });
    if (parsed.status !== 'PARSED') throw new Error(parsed.reason);
    const estimate = assembleEstimate({
      estimate_id: 'e-moved',
      generated_at: '2026-09-09T00:00:00.000Z',
      pricing_snapshot_id: 'snap-1',
      workflow: parsed.workflow,
      candidates: [],
      evidence: [],
      warnings,
    });
    const w = estimate.warnings.find((x) => x.code === 'PRICE_CHANGED_SINCE_LAST_RUN')!;
    expect(w.severity).toBe('WARN');
    expect(w.message).toContain('gemini-2.5-pro output moved from 0.000008 to 0.00001 per_token USD (+25%)');
  });
});
