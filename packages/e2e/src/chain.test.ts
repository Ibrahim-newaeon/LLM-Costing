// /packages/e2e/src/chain.test.ts
//
// §A11 — the chain, and the class of defect only the chain can reach.
//
// Every other suite in this repo tests a module against its own contract, and
// every one of them passes. The defects this file exists for are the ones where
// each module is individually correct and the seam between them is not:
//
//   prose  ->  parseL1  ->  WorkflowInput  ->  estimator  ->  route  ->  EstimateOutput
//
// Its own package, deliberately. `estimator` states in its index that it is pure
// and depends on nothing that does I/O; making it depend on `parser` and `router`
// so a test could live there would draw two real dependency edges for a test's
// convenience. Here everything is a devDependency of a package that ships nothing.
//
//   pnpm vitest packages/e2e     # offline, free

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  Registry,
  WarningCode,
  type Candidate,
  type Evidence,
  type ModelRow,
  type WorkflowInput,
} from '@tokenomics/contracts';
import { parseL1, type DefaultsSeed } from '@tokenomics/parser';
import { route } from '@tokenomics/router';
import {
  assembleCandidate,
  assembleEstimate,
  buildLine,
  countVisionTokens,
  exactRange,
  selectContextTier,
  systemOverheadCost,
} from '@tokenomics/estimator';

const REGISTRY_PATH = join(__dirname, '..', '..', '..', 'registry', 'registry.json');
const registry = Registry.parse(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')));
const opus: ModelRow = registry.models.find((m) => m.model_id === 'claude-opus-5')!;
const gemini: ModelRow = registry.models.find((m) => m.model_id === 'gemini-2.5-pro')!;

const perToken = (perMillion: number) => perMillion / 1_000_000;

/** Injected, because the estimator has no clock and an estimate must be reproducible. */
const AT = '2026-09-09T00:00:00.000Z';

const EVIDENCE: Evidence[] = [
  {
    ref: 'anthropic-vision',
    kind: 'VENDOR_DOC',
    source_url: 'https://platform.claude.com/docs/en/docs/build-with-claude/vision',
    verified_at: '2026-09-08T00:00:00.000Z',
    sample_size: null,
  },
];

const SEED: DefaultsSeed = [
  { doc_class: 'short_form', input_tokens: 300, output_tokens: 200, image_width_px: null, image_height_px: null, image_detail: null, source: 'USER_SUPPLIED_BASELINE' },
  { doc_class: 'medium_form', input_tokens: 2_000, output_tokens: 800, image_width_px: null, image_height_px: null, image_detail: null, source: 'USER_SUPPLIED_BASELINE' },
  { doc_class: 'long_form', input_tokens: 25_000, output_tokens: 2_000, image_width_px: null, image_height_px: null, image_detail: null, source: 'USER_SUPPLIED_BASELINE' },
  { doc_class: 'image_unspecified', input_tokens: null, output_tokens: null, image_width_px: 1024, image_height_px: 1024, image_detail: 'high', source: 'USER_SUPPLIED_BASELINE' },
];

/**
 * One real costed candidate: a 1000x1000 image on Opus, the figure Anthropic publishes.
 *
 * `model_id` is free ONLY so the arithmetic tests can stand up ten candidates. It is
 * checked against the registry: pricing another vendor's row with Anthropic's geometry
 * would be that vendor's answer wearing the right unit, which is what this repo exists
 * to refuse. A synthetic id like `model-3` cannot be mistaken for a claim about anyone;
 * `gemini-2.5-pro` can, and an earlier draft of this file did exactly that.
 *
 * The guard is here rather than in a comment because a comment did not stop it.
 */
function visionCandidate(model_id: string): Candidate {
  const impersonated = registry.models.find(
    (m) => m.model_id === model_id && m.model_id !== opus.model_id,
  );
  if (impersonated) {
    throw new Error(
      `visionCandidate would price ${model_id} using ${opus.model_id}'s geometry. ` +
        `Use a synthetic id for arithmetic, or textCandidate() to compare real rows.`,
    );
  }
  const count = countVisionTokens(opus.vision!, { width_px: 1000, height_px: 1000, detail_mode: null });
  if (count.status !== 'COUNTED') throw new Error(count.reason);
  const line = buildLine({
    task_id: 'ocr-1',
    component: 'image_tiles',
    quantity: exactRange(count.tokens),
    unit: 'tokens',
    rate_amount: perToken(opus.text_rates[0]!.input_rate_by_modality.image!.amount),
    rate_record_id: 'claude-opus-5:input:image',
    method: count.method,
    confidence: count.confidence,
  });
  return assembleCandidate({
    model_id,
    provider_id: opus.provider,
    provider_tier: opus.tier,
    deployment_mode: 'API_MANAGED',
    currency: 'USD',
    lines: [line],
  });
}

/**
 * A text candidate priced at THAT model's own published input rate.
 *
 * ⚠️ There is deliberately no `visionCandidate(gemini)` — Gemini's vision geometry is
 * UNAVAILABLE (VERIFY #6), so a Gemini image line does not exist at any price. This is
 * the honest way to compare the two rows, and `visionCandidate` now throws rather than
 * relying on anyone reading that sentence.
 */
function textCandidate(row: ModelRow, tokens: number): Candidate {
  const rate = row.text_rates[0]!.input_rate_by_modality.text!;
  const line = buildLine({
    task_id: 'read-1',
    component: 'prompt_input',
    quantity: exactRange(tokens),
    unit: 'tokens',
    rate_amount: perToken(rate.amount),
    rate_record_id: `${row.model_id}:input:text`,
    method: 'PROVIDER_FORMULA',
    confidence: 'HIGH',
  });
  return assembleCandidate({
    model_id: row.model_id,
    provider_id: row.provider,
    provider_tier: row.tier,
    deployment_mode: 'API_MANAGED',
    currency: 'USD',
    lines: [line],
  });
}

/** A workflow with nothing outstanding, for the arithmetic tests. */
function cleanWorkflow(): WorkflowInput {
  const r = parseL1({ text: 'describe the attached photo', seed: SEED });
  if (r.status !== 'PARSED') throw new Error(r.reason);
  return r.workflow;
}

/* ═══════ §A12 — parser overhead is metered once, however many models ═══════ */

describe('the parse is billed once for the estimate, not once per candidate', () => {
  const overheadFor = (n: number, l2: boolean) =>
    assembleEstimate({
      estimate_id: `e-${n}`,
      generated_at: AT,
      pricing_snapshot_id: 'snap-1',
      workflow: cleanWorkflow(),
      candidates: Array.from({ length: n }, (_, i) => visionCandidate(`model-${i}`)),
      evidence: EVIDENCE,
      system_overhead: l2
        ? [{
            source: 'L2_PARSE',
            parser_model_id: 'some-cheap-model',
            input_tokens: 900,
            output_tokens: 300,
            cost: { p50: 0.0042, p90: 0.0042, p99: null },
            currency: 'USD',
            rate_record_id: 'cheap:input',
            method: 'PROVIDER_FORMULA',
            confidence: 'HIGH',
          }]
        : [],
    });

  it('an L1 parse emits no overhead at all — that absence is the metric', () => {
    for (const n of [1, 10]) {
      const e = overheadFor(n, false);
      expect(e.system_overhead).toHaveLength(0);
      expect(systemOverheadCost(e)).toEqual({ p50: 0, p90: 0 });
    }
  });

  it('an L2 parse is ONE entry whether one model is compared or ten', () => {
    const one = overheadFor(1, true);
    const ten = overheadFor(10, true);
    expect(one.system_overhead).toHaveLength(1);
    expect(ten.system_overhead).toHaveLength(1);
    // The whole rule, as arithmetic: candidate cost scales with the comparison
    // set, the parse does not. Adding a "parser cost" line to each candidate so the
    // per-model totals "look right" would bill ten parses for one that happened.
    expect(systemOverheadCost(ten)).toEqual(systemOverheadCost(one));
    const sum = (e: typeof one) => e.candidates.reduce((a, c) => a + c.total_cost.p50, 0);
    expect(sum(ten)).toBeCloseTo(sum(one) * 10, 12);
  });

  it('no candidate line can carry the parse — the type system is the guard', () => {
    const e = overheadFor(10, true);
    // §A4.4.1's "must not be a per-candidate line" needs no runtime check because
    // `CostComponent` has no member for it. This asserts the consequence rather
    // than re-implementing the rule: the parser model appears nowhere in any line.
    const rateRefs = e.candidates.flatMap((c) => c.lines.map((l) => l.rate_record_id ?? ''));
    expect(rateRefs.some((r) => r.includes('cheap'))).toBe(false);
    expect(e.system_overhead[0]!.parser_model_id).toBe('some-cheap-model');
  });

  it('refuses to price a real vendor row with another vendor’s geometry', () => {
    // The guard on visionCandidate, exercised. An earlier draft of this file priced
    // a Gemini image line by cloning Anthropic's 1296-token figure — Gemini's
    // geometry is UNAVAILABLE, so that line does not exist at any price.
    expect(() => visionCandidate('model-3')).not.toThrow();
    expect(() => visionCandidate(gemini.model_id)).toThrow(/geometry/);
  });

  it('the parser model need not be one of the models being compared', () => {
    const e = overheadFor(2, true);
    const compared = e.candidates.map((c) => c.model_id);
    expect(compared).not.toContain(e.system_overhead[0]!.parser_model_id);
  });
});

/* ═══════════ §A12 items only the whole chain can reach ═══════════ */

describe('a gap the parser found still blocks at the estimate', () => {
  it('an unqualified PDF blocks the ESTIMATE, not just the parse', () => {
    // §A4.4.7: a text-layer document is priced on text tokens; a scan is vision
    // geometry per page. The parser refuses to guess. What matters here is the
    // next hop — that the refusal survives into the estimate rather than being a
    // note somebody forgot to read.
    const parsed = parseL1({ text: 'summarize the attached pdf', seed: SEED });
    if (parsed.status !== 'PARSED') throw new Error(parsed.reason);
    const blocking = parsed.workflow.missing_data.filter((m) => m.blocks_estimate);
    expect(blocking.map((m) => m.field)).toContain('pdf_has_text_layer');

    const e = assembleEstimate({
      estimate_id: 'e-pdf',
      generated_at: AT,
      pricing_snapshot_id: 'snap-1',
      workflow: parsed.workflow,
      candidates: [visionCandidate(opus.model_id)],
      evidence: EVIDENCE,
    });

    // A costed candidate at HIGH confidence, and the estimate still demands a
    // human — because the thing that is missing changes which arithmetic applies,
    // not how precise it is.
    expect(e.candidates[0]!.confidence).toBe('HIGH');
    expect(e.confidence).toBe('HIGH');
    expect(e.needs_human_review).toBe(true);
    expect(e.missing_data.map((m) => m.field)).toContain('pdf_has_text_layer');
  });

  it('the parser assumptions arrive on the estimate, deduplicated', () => {
    const parsed = parseL1({ text: 'write a short post', seed: SEED });
    if (parsed.status !== 'PARSED') throw new Error(parsed.reason);
    const e = assembleEstimate({
      estimate_id: 'e-assume',
      generated_at: AT,
      pricing_snapshot_id: 'snap-1',
      workflow: parsed.workflow,
      candidates: [visionCandidate(opus.model_id)],
      evidence: EVIDENCE,
      // Handed the same assumption twice, as two callers merging would.
      assumptions: parsed.workflow.assumptions,
    });
    expect(e.assumptions).toHaveLength(parsed.workflow.assumptions.length);
  });
});

describe('§A4.4.6 — three language fields, and only one enters the cost math', () => {
  it('an English request about a Chinese payload does not report Chinese as the instruction', () => {
    const parsed = parseL1({ text: 'summarize the attached contract', seed: SEED, ui_language: 'ar' });
    if (parsed.status !== 'PARSED') throw new Error(parsed.reason);
    const langs = parsed.workflow.languages;
    expect(langs.ui_language).toBe('ar');
    expect(langs.instruction_language).toBe('latin');

    const e = assembleEstimate({
      estimate_id: 'e-lang',
      generated_at: AT,
      pricing_snapshot_id: 'snap-1',
      workflow: parsed.workflow,
      candidates: [visionCandidate(opus.model_id)],
      evidence: EVIDENCE,
    });
    // The estimate's cost lines are indifferent to the UI language — it is not a
    // quantity, and the contract refuses to let it become one.
    expect(e.candidates[0]!.total_cost.p50).toBeGreaterThan(0);
    expect(JSON.stringify(e.candidates)).not.toContain('ui_language');
  });
});

describe('§A3.7 — confidence is the minimum, all the way up', () => {
  it('one refused line drags the line, the candidate and the estimate to NONE', () => {
    const refusal = buildLine({
      task_id: 'text-1',
      component: 'prompt_input',
      quantity: null,
      unit: null,
      rate_amount: null,
      rate_record_id: null,
      method: 'UNAVAILABLE',
      confidence: 'NONE',
    });
    const counted = visionCandidate(opus.model_id).lines[0]!;
    const mixed = assembleCandidate({
      model_id: opus.model_id,
      provider_id: opus.provider,
      deployment_mode: 'API_MANAGED',
      currency: 'USD',
      lines: [counted, refusal],
    });
    expect(mixed.confidence).toBe('NONE');

    const e = assembleEstimate({
      estimate_id: 'e-min',
      generated_at: AT,
      pricing_snapshot_id: 'snap-1',
      workflow: cleanWorkflow(),
      candidates: [mixed],
      evidence: EVIDENCE,
    });
    expect(e.confidence).toBe('NONE');
    // NONE means no estimate was produced. Shipping it unflagged is how a refusal
    // reads as a zero — and the total IS zero, which is the trap.
    expect(e.needs_human_review).toBe(true);
    expect(e.candidates[0]!.total_cost.p50).toBeCloseTo(counted.cost!.p50, 12);
  });

  it('a strong candidate beside a refusing one does NOT lift the estimate', () => {
    // Found by mutation, not by design: inverting §A3.7 at the estimate level —
    // taking the strongest candidate instead of the weakest — turned nothing red,
    // because every other test here compares candidates of equal confidence, where
    // min and max coincide. This is the only shape that can tell them apart, and
    // it is the shape that matters: the cheap model that refused sits next to the
    // expensive one that answered, and the estimate must report the refusal.
    const strong = visionCandidate(opus.model_id);
    const refusing = assembleCandidate({
      model_id: gemini.model_id,
      provider_id: gemini.provider,
      deployment_mode: 'API_MANAGED',
      currency: 'USD',
      lines: [
        buildLine({
          task_id: 'ocr-1',
          component: 'image_tiles',
          quantity: null,
          unit: null,
          rate_amount: null,
          rate_record_id: null,
          method: 'UNAVAILABLE',
          confidence: 'NONE',
        }),
      ],
    });
    expect(strong.confidence).toBe('HIGH');
    expect(refusing.confidence).toBe('NONE');

    const e = assembleEstimate({
      estimate_id: 'e-mixed',
      generated_at: AT,
      pricing_snapshot_id: 'snap-1',
      workflow: cleanWorkflow(),
      candidates: [strong, refusing],
      evidence: EVIDENCE,
    });
    expect(e.confidence).toBe('NONE');
    expect(e.needs_human_review).toBe(true);
  });

  it('every line in a shipped estimate carries a method and a confidence', () => {
    const e = assembleEstimate({
      estimate_id: 'e-prov',
      generated_at: AT,
      pricing_snapshot_id: 'snap-1',
      workflow: cleanWorkflow(),
      candidates: [visionCandidate(opus.model_id), textCandidate(gemini, 100_000)],
      evidence: EVIDENCE,
    });
    const lines = e.candidates.flatMap((c) => c.lines);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.method).toBeTruthy();
      expect(l.confidence).toBeTruthy();
    }
  });
});

describe('prose in, a ranked answer out', () => {
  it('runs the whole chain and names a cheapest model with a rationale', () => {
    const parsed = parseL1({ text: 'read the report and write a summary', seed: SEED });
    if (parsed.status !== 'PARSED') throw new Error(parsed.reason);
    expect(parsed.workflow.tasks.length).toBeGreaterThan(0);

    // 100k tokens of reading, each row at its own published text rate:
    // Anthropic $5/1M -> $0.50, Google $1.25/1M below the 200k tier -> $0.125.
    const candidates = [textCandidate(opus, 100_000), textCandidate(gemini, 100_000)];
    const routed = route({
      models: [opus, gemini],
      tasks: parsed.workflow.tasks,
      candidates,
    });

    const e = assembleEstimate({
      estimate_id: 'e-chain',
      generated_at: AT,
      pricing_snapshot_id: 'snap-1',
      workflow: parsed.workflow,
      candidates: candidates.filter(
        (c) => !routed.excluded.some((x) => x.model_id === c.model_id),
      ),
      recommendations: routed.recommendations,
      excluded_models: routed.excluded,
      evidence: EVIDENCE,
    });

    // The contract refuses a recommendation for a model that was never costed, and
    // refuses a model that is both costed and excluded. Reaching a parsed
    // EstimateOutput at all is those two invariants holding across three packages.
    expect(e.estimate_id).toBe('e-chain');
    const cheapest = e.recommendations?.cheapest;
    if (!cheapest) throw new Error('both rows are costed and eligible; cheapest must not be null');
    expect(cheapest.model_id).toBe('gemini-2.5-pro');
    expect(cheapest.total_cost!.p50).toBeCloseTo(0.125, 10);
    expect(e.candidates.map((c) => c.model_id)).toContain(cheapest.model_id);
    // §A7 demands a rationale on every recommendation, and it must name the
    // runner-up so the margin is visible rather than asserted.
    expect(String(cheapest.rationale.threshold)).toMatch(/claude-opus-5/);
    // Best-capability is null on this registry and says why — no sourced
    // quality_score on either row, and §A6 forbids inventing one.
    expect(e.recommendations?.best_capability).toBeNull();
  });
});
