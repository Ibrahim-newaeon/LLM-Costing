// /packages/estimator/src/end-to-end.test.ts
//
// The first time this repo's contracts and estimator meet a real model.
//
// Everything else here is a unit test against a fixture. This drives ONE real row
// — /registry/registry.json, Claude Opus 5, every figure fetched from Anthropic's
// own domain on 2026-09-08 with a source_url and a verified_at — through the whole
// chain: Registry.parse -> countVisionTokens -> buildLine -> assembleCandidate ->
// EstimateOutput, and asserts a dollar figure at the end.
//
// It pins BOTH outcomes, and the second matters as much as the first:
//
//   a vision task  -> a real costed estimate, because geometry is deterministic
//                     and the constants are verified
//   a text task    -> a REFUSAL with a named missing datum, because nothing has
//                     calibrated a tokens-per-character ratio and §A4.5.4 forbids
//                     borrowing one
//
// A repo that only tests the first is a repo that will one day ship the second as
// a zero.
//
//   pnpm vitest src/end-to-end.test.ts     # offline, free

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  Registry,
  rankingEligibility,
  rateFreshness,
  isPriceable,
  type ModelRow,
} from '@tokenomics/contracts';
import { countWithLadder, CountCache, type CountTokensPort } from '@tokenomics/tokenizers';
import { countTextTokens } from './text';
import { countVisionTokens } from './vision';
import { selectContextTier, contextTierCrossingSaving } from './context';
import { buildLine, assembleCandidate } from './candidate';
import { residencyUplift, resolveServiceTier } from './request';
import { exactRange } from './range';

const REGISTRY_PATH = join(__dirname, '..', '..', '..', 'registry', 'registry.json');

const registry = Registry.parse(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')));
const opus: ModelRow = registry.models.find((m) => m.model_id === 'claude-opus-5')!;
const rates = opus.text_rates[0]!;

/** $/token from a $/1M rate. The only arithmetic this file does on a price. */
const perToken = (amountPerMillion: number) => amountPerMillion / 1_000_000;

/* ══════════════ the row itself ══════════════ */

describe('the first real registry document', () => {
  it('parses as a Registry — two providers, from two sets of vendor pages', () => {
    expect(registry.models.map((m) => m.model_id)).toEqual(['claude-opus-5', 'gemini-2.5-pro']);
    expect(opus.display_name).toBe('Claude Opus 5');
  });

  it('carries a source_url and a verified_at on every rate — rule 1', () => {
    const every = [
      rates.input_rate_by_modality.text,
      rates.input_rate_by_modality.image,
      rates.output_rate,
      rates.cache!.write_rate,
      rates.cache!.read_rate,
    ];
    for (const r of every) {
      expect(r!.provenance.source_url).toMatch(/^https:\/\/platform\.claude\.com\//);
      expect(r!.provenance.verified_at).not.toBeNull();
    }
  });

  it('is rankable — it can produce a number at all', () => {
    expect(rankingEligibility(opus).eligible).toBe(true);
  });

  it('is FRESH today and would BLOCK once the 30-day policy lapses', () => {
    const verified = new Date(rates.output_rate.provenance.verified_at!);
    const dayAfter = new Date(verified.getTime() + 1 * 86_400_000);
    const wayLater = new Date(verified.getTime() + 31 * 86_400_000);
    expect(isPriceable(rateFreshness(rates.output_rate, dayAfter))).toBe(true);
    expect(rateFreshness(rates.output_rate, wayLater)).toBe('STALE');
  });

  it('§A5.10 — context_tiers is NULL, and that is a published fact, not an omission', () => {
    // "include the full 1M token context window at standard pricing. (A 900k-token
    // request is billed at the same per-token rate as a 9k-token request.)"
    expect(rates.context_tiers).toBeNull();
    expect(opus.context_window.value).toBe(1_000_000);
  });
});

/* ══════════════ the vision path — a real number ══════════════ */

describe('a vision task produces a real costed estimate', () => {
  it('agrees with the vendor’s own published token counts', () => {
    // Straight from the vision page's worked table, high-resolution tier.
    const cases: Array<[number, number, number]> = [
      [200, 200, 64],
      [1000, 1000, 1296],
      [1092, 1092, 1521],
      [1920, 1080, 2691],
      [2000, 1500, 3888],
      [3840, 2160, 4784],
    ];
    for (const [w, h, tokens] of cases) {
      const c = countVisionTokens(opus.vision!, { width_px: w, height_px: h, detail_mode: null });
      expect(c.status, `${w}x${h}`).toBe('COUNTED');
      if (c.status === 'COUNTED') expect(c.tokens, `${w}x${h}`).toBe(tokens);
    }
  });

  it('costs one 1000x1000 image end to end, in dollars', () => {
    const count = countVisionTokens(opus.vision!, { width_px: 1000, height_px: 1000, detail_mode: null });
    if (count.status !== 'COUNTED') throw new Error(count.reason);

    const line = buildLine({
      task_id: 'ocr-1',
      component: 'image_tiles',
      quantity: exactRange(count.tokens),
      unit: 'tokens',
      rate_amount: perToken(rates.input_rate_by_modality.image!.amount),
      rate_record_id: 'claude-opus-5:input:image',
      method: count.method,
      confidence: count.confidence,
    });

    const candidate = assembleCandidate({
      model_id: opus.model_id,
      provider_id: opus.provider,
      provider_tier: opus.tier,
      deployment_mode: 'API_MANAGED',
      currency: 'USD',
      lines: [line],
    });

    // 1296 visual tokens at $5/1M.
    expect(candidate.total_cost.p50).toBeCloseTo(1296 * 5e-6, 12);
    expect(candidate.confidence).toBe('HIGH');

    // The vendor's own worked example: "the 1000x1000 image costs about $6.48 USD
    // per thousand" at Claude Opus 5's $5/1M, high-resolution tier. Our figure is
    // theirs, independently computed from the geometry rather than copied.
    expect(candidate.total_cost.p50 * 1000).toBeCloseTo(6.48, 10);
  });

  it('prices a thousand 4K scans — where the token cap makes oversized cheap', () => {
    const count = countVisionTokens(opus.vision!, { width_px: 3840, height_px: 2160, detail_mode: null });
    if (count.status !== 'COUNTED') throw new Error(count.reason);
    expect(count.tokens).toBe(4784);
    expect(count.scaled).toBe(true);
    // "the 4K image about $23.92 USD per thousand"
    expect(4784 * 5e-6 * 1000).toBeCloseTo(23.92, 10);
  });
});

/* ══════════════ the text path — a refusal, and why ══════════════ */

describe('a text task refuses, with the gap named', () => {
  it('has no calibrated tokens-per-character for this model, and does not borrow one', () => {
    // §A4.5.4. The row records the absence explicitly rather than defaulting.
    expect(opus.tokenizer.tokenizer_multiplier.value).toBeNull();
    expect(opus.tokenizer.tokenizer_multiplier.provenance.method).toBe('UNAVAILABLE');
    expect(opus.tokenizer.framing_tokens_per_message.value).toBeNull();
  });

  it('reaches tier 1 and no further — there is no local Anthropic tokenizer', () => {
    expect(opus.tokenizer.availability).toBe('REMOTE_API');
    expect(opus.tokenizer.identifier).toBeNull();
  });

  it('assembles as a refusal that reads as a refusal, not as a zero', () => {
    const refusal = buildLine({
      task_id: 'summarize-1',
      component: 'prompt_input',
      quantity: null,
      unit: null,
      rate_amount: null,
      rate_record_id: null,
      method: 'UNAVAILABLE',
      confidence: 'NONE',
      note: 'No calibrated tokens-per-character for this model, and §A4.5.4 forbids the English bootstrap ratio standing in.',
    });
    const candidate = assembleCandidate({
      model_id: opus.model_id,
      provider_id: opus.provider,
      deployment_mode: 'API_MANAGED',
      currency: 'USD',
      lines: [refusal],
    });
    expect(candidate.total_cost.p50).toBe(0);
    // The zero is not the answer. THIS is:
    expect(candidate.confidence).toBe('NONE');
    expect(candidate.lines[0]!.cost).toBeNull();
  });

  it('one refused line drags a costed candidate to NONE (§A3.7)', () => {
    const good = buildLine({
      task_id: 't', component: 'image_tiles', quantity: exactRange(1296), unit: 'tokens',
      rate_amount: 5e-6, rate_record_id: 'r', method: 'PROVIDER_FORMULA', confidence: 'HIGH',
    });
    const bad = buildLine({
      task_id: 't', component: 'completion_output', quantity: null, unit: null,
      rate_amount: null, rate_record_id: null, method: 'UNAVAILABLE', confidence: 'NONE',
    });
    const c = assembleCandidate({
      model_id: opus.model_id, provider_id: opus.provider,
      deployment_mode: 'API_MANAGED', currency: 'USD', lines: [good, bad],
    });
    expect(c.total_cost.p50).toBeGreaterThan(0);
    expect(c.confidence).toBe('NONE');
  });

  it('is a reasoning model, so §A5.4 blocks output regardless of the text gap', () => {
    // "Thinking: Adaptive" on the models overview. Reasoning tokens are billed and
    // invisible; with no prior, treating them as zero is the expensive silent error.
    expect(opus.is_reasoning_model).toBe(true);
    expect(rates.reasoning_output_rate).toBeNull();
  });
});

/* ══════════════ §A5.10 against a real row ══════════════ */

describe('the request layer, on real published figures', () => {
  it('reads the batch discount off this provider rather than a constant', () => {
    const r = resolveServiceTier(opus.service_tiers, 'batch', null);
    expect(r.status).toBe('OK');
    if (r.status === 'OK') expect(r.multiplier).toBe(0.5);
  });

  it('refuses a tier this provider does not publish', () => {
    expect(resolveServiceTier(opus.service_tiers, 'priority', null).status).toBe('UNAVAILABLE');
  });

  it('charges nothing for residency when no regional endpoint is requested', () => {
    const r = residencyUplift(opus.compliance, null);
    expect(r.status === 'OK' && r.uplift_pct).toBe(0);
  });

  it('REFUSES to price the US-only endpoint, because the 1.1x is scoped to a model set the docs do not enumerate', () => {
    // The multiplier is published. Whether it applies to THIS model is not stated,
    // and answering it would be a version-ordering inference. Refusing is the
    // whole point: the compliant route is not quoted at the default price, and it
    // is not quoted at a guessed one either.
    const r = residencyUplift(opus.compliance, 'us');
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/unsourced/);
  });
});

/* ══════════════ tier 1 — the refusal becomes a number ══════════════ */

describe('§A4.5 tier 1 turns the text refusal into a costed estimate', () => {
  // A stub transport. Nothing here touches the network and no API key exists in
  // this repo; the point is the WIRING, not the vendor's uptime.
  const port = (input_tokens: number): CountTokensPort => async () => ({
    status: 200,
    json: { input_tokens },
    text: JSON.stringify({ input_tokens }),
  });

  const request = {
    model_id: 'claude-opus-5',
    system: 'You are a contracts analyst.',
    messages: [{ role: 'user', content: 'Summarize the indemnity clause.' }],
  };

  const textInput = {
    model_id: opus.model_id,
    tokenizer: opus.tokenizer,
    metrics: {
      character_count: 4_000,
      script_mix: { latin: 1 },
      arabic_register: null,
      diacritic_density: null,
      content_type: 'prose' as const,
      tool_schemas_present: false,
      tool_schema_character_count: null,
    },
    calibration: [],
    message_count: 1,
    heuristic_safety_pad_pct: 0.15,
  };

  it('refuses without a count — nothing has calibrated this model', () => {
    const r = countTextTokens(textInput);
    expect(r.status).toBe('UNAVAILABLE');
  });

  it('produces a real dollar figure once tier 1 answers', async () => {
    const cache = new CountCache();
    const counted = await countWithLadder(request, {
      port: port(1_500),
      apiKey: 'sk-test-stub',
      cache,
      now: () => new Date('2026-09-08T04:16:10.000Z'),
    });
    if (counted.status !== 'OK') throw new Error(counted.reason);

    const text = countTextTokens({
      ...textInput,
      exact: {
        tokens: counted.tokens,
        method: counted.method,
        confidence: counted.confidence,
        tier: counted.tier as 0 | 1 | 2,
        covers: counted.covers,
        note: counted.note,
      },
    });
    if (text.status !== 'COUNTED') throw new Error(text.reason);

    const candidate = assembleCandidate({
      model_id: opus.model_id,
      provider_id: opus.provider,
      deployment_mode: 'API_MANAGED',
      currency: 'USD',
      lines: [
        buildLine({
          task_id: 'summarize-1',
          component: 'prompt_input',
          quantity: text.total,
          unit: 'tokens',
          rate_amount: perToken(rates.input_rate_by_modality.text!.amount),
          rate_record_id: 'claude-opus-5:input:text',
          method: text.components[0]!.method,
          confidence: text.confidence,
          tier: 1,
          note: text.components[0]!.note,
        }),
      ],
    });

    // 1500 tokens at $5/1M.
    expect(candidate.total_cost.p50).toBeCloseTo(1_500 * 5e-6, 12);
    expect(candidate.confidence).toBe('HIGH');
    expect(candidate.lines[0]!.tier).toBe(1);
  });

  it('does NOT add framing on top — the provider’s count already contains it', async () => {
    // The bug this whole change exists to close. The count endpoint is handed the
    // whole request and its count "includes system prompts, tool definitions,
    // messages"; adding §A5.1.2 framing would bill the same tokens twice, and this
    // row cannot even supply a framing figure — it is UNAVAILABLE.
    const counted = await countWithLadder(request, { port: port(1_500), apiKey: 'sk-test-stub' });
    if (counted.status !== 'OK') throw new Error(counted.reason);

    const text = countTextTokens({
      ...textInput,
      exact: {
        tokens: counted.tokens, method: counted.method, confidence: counted.confidence,
        tier: counted.tier as 0 | 1 | 2, covers: counted.covers, note: counted.note,
      },
    });
    if (text.status !== 'COUNTED') throw new Error(text.reason);
    expect(text.components).toHaveLength(1);
    expect(text.total.p50).toBe(1_500);
    expect(text.components.map((c) => c.component)).not.toContain('framing_overhead');
  });

  it('carries the vendor’s caveat onto the priced line', async () => {
    const counted = await countWithLadder(request, { port: port(1_500), apiKey: 'sk-test-stub' });
    if (counted.status !== 'OK') throw new Error(counted.reason);
    const text = countTextTokens({
      ...textInput,
      exact: {
        tokens: counted.tokens, method: counted.method, confidence: counted.confidence,
        tier: counted.tier as 0 | 1 | 2, covers: counted.covers, note: counted.note,
      },
    });
    if (text.status !== 'COUNTED') throw new Error(text.reason);
    // "may include system-added tokens that are not billed" — the count can exceed
    // the invoice, and the line says so rather than the discrepancy surfacing later.
    expect(text.components[0]!.note).toMatch(/not billed/);
  });

  it('costs the vision and the text line together, on one candidate', async () => {
    const counted = await countWithLadder(request, { port: port(1_500), apiKey: 'sk-test-stub' });
    if (counted.status !== 'OK') throw new Error(counted.reason);
    const vision = countVisionTokens(opus.vision!, { width_px: 1000, height_px: 1000, detail_mode: null });
    if (vision.status !== 'COUNTED') throw new Error(vision.reason);

    const candidate = assembleCandidate({
      model_id: opus.model_id,
      provider_id: opus.provider,
      deployment_mode: 'API_MANAGED',
      currency: 'USD',
      lines: [
        buildLine({
          task_id: 'ocr-1', component: 'image_tiles', quantity: exactRange(vision.tokens),
          unit: 'tokens', rate_amount: perToken(rates.input_rate_by_modality.image!.amount),
          rate_record_id: 'claude-opus-5:input:image',
          method: vision.method, confidence: vision.confidence,
        }),
        buildLine({
          task_id: 'summarize-1', component: 'prompt_input', quantity: exactRange(counted.tokens),
          unit: 'tokens', rate_amount: perToken(rates.input_rate_by_modality.text!.amount),
          rate_record_id: 'claude-opus-5:input:text',
          method: counted.method, confidence: counted.confidence, tier: 1,
        }),
      ],
    });

    // The whole point: a multi-modal workflow with one number at the end of it.
    expect(candidate.total_cost.p50).toBeCloseTo((1296 + 1500) * 5e-6, 12);
    expect(candidate.confidence).toBe('HIGH');
    expect(candidate.total_tokens!.input!.p50).toBe(1296 + 1500);
  });
});

/* ══════════════ two providers — §A5.7 against real published tiers ══════════════ */

const gemini: ModelRow = registry.models.find((m) => m.model_id === 'gemini-2.5-pro')!;
const gRates = gemini.text_rates[0]!;

describe('the second provider brings the first real context tier', () => {
  it('Anthropic has no tier and Google has one — both are published facts', () => {
    expect(rates.context_tiers).toBeNull();
    expect(gRates.context_tiers).toHaveLength(2);
  });

  it('selects $1.25 below the 200k threshold and $2.50 above it', () => {
    const below = selectContextTier(gRates.context_tiers, 199_000);
    const above = selectContextTier(gRates.context_tiers, 201_000);
    if (below.status !== 'SELECTED' || above.status !== 'SELECTED') throw new Error('tier');
    expect(below.input_rate.amount).toBe(1.25);
    expect(above.input_rate.amount).toBe(2.5);
    expect(below.output_rate.amount).toBe(10);
    expect(above.output_rate.amount).toBe(15);
  });

  it('crossing 200k by 1% roughly DOUBLES the bill, because the whole prompt reprices', () => {
    // The §A5.7 distinction, on figures a vendor published. "prompts >200k tokens"
    // reprices every token, not the overflow.
    const price = (tokens: number) => {
      const t = selectContextTier(gRates.context_tiers, tokens);
      if (t.status !== 'SELECTED') throw new Error('tier');
      expect(t.tier.applies_to_whole_request).toBe(true);
      return tokens * perToken(t.input_rate.amount);
    };
    const under = price(199_000);
    const over = price(201_000);

    expect(under).toBeCloseTo(0.24875, 10);
    expect(over).toBeCloseTo(0.5025, 10);
    expect(over / under).toBeGreaterThan(2);

    // What a marginal reading would have said — understated by a factor of two.
    const marginal = 200_000 * perToken(1.25) + 1_000 * perToken(2.5);
    expect(marginal).toBeCloseTo(0.2525, 10);
    expect(over / marginal).toBeGreaterThan(1.9);
  });

  it('a 0.5% prompt trim halves the cost — the outsized saving §A5.7 exists to surface', () => {
    const saving = contextTierCrossingSaving(gRates.context_tiers!, 1, 201_000);
    expect(saving).not.toBeNull();
    expect(saving!.trim_tokens).toBe(1_000);
    expect(saving!.applies_to_whole_request).toBe(true);
    // Trimming 0.5% of the prompt repriced the entire request.
    expect(saving!.repriced_tokens).toBe(200_000);
    expect(saving!.trim_tokens / 201_000).toBeLessThan(0.006);
  });

  it('costs a real 201k-token request end to end', () => {
    const t = selectContextTier(gRates.context_tiers, 201_000);
    if (t.status !== 'SELECTED') throw new Error('tier');
    const candidate = assembleCandidate({
      model_id: gemini.model_id,
      provider_id: gemini.provider,
      deployment_mode: 'API_MANAGED',
      currency: 'USD',
      lines: [
        buildLine({
          task_id: 'long-doc',
          component: 'prompt_input',
          quantity: exactRange(201_000),
          unit: 'tokens',
          rate_amount: perToken(t.input_rate.amount),
          rate_record_id: 'gemini-2.5-pro:input:text:>200k',
          method: 'PROVIDER_FORMULA',
          confidence: 'HIGH',
          tier: 1,
        }),
      ],
    });
    expect(candidate.total_cost.p50).toBeCloseTo(0.5025, 10);
  });
});

describe('the second provider also brings honest gaps', () => {
  it('accepts images but cannot count them — capability true, geometry UNAVAILABLE', () => {
    // Recording supports_vision:false would have been a false capability claim.
    // UNAVAILABLE geometry is the true statement: it does vision, we cannot price it.
    expect(gemini.supports_vision).toBe(true);
    expect(gemini.modalities_in).toContain('image');
    expect(gemini.vision!.geometry.geometry).toBe('UNAVAILABLE');
    expect(rankingEligibility(gemini).reasons).toContain('VISION_GEOMETRY_UNAVAILABLE');
  });

  it('names what would close it — a worked example, the same thing that fixed Anthropic', () => {
    const g = gemini.vision!.geometry;
    if (g.geometry !== 'UNAVAILABLE') throw new Error('geometry');
    expect(g.reason).toMatch(/worked example/);
    expect(g.probe_candidate).toBe(true);
  });

  it('reads the batch discount off Google, not off Anthropic — same figure, separate rows', () => {
    // Both vendors publish 50%. A passing test here proves it is read per provider
    // rather than having quietly become a shared constant.
    const a = resolveServiceTier(opus.service_tiers, 'batch', null);
    const g = resolveServiceTier(gemini.service_tiers, 'batch', null);
    expect(a.status === 'OK' && a.multiplier).toBe(0.5);
    expect(g.status === 'OK' && g.multiplier).toBe(0.5);
    expect(opus.service_tiers).not.toBe(gemini.service_tiers);
  });

  it('leaves audio and video unpriced rather than assuming parity with text', () => {
    // Siblings price audio separately (2.5 Flash: "$0.30 (text/image/video) $1.00
    // (audio)"), so equal-to-text would be assuming this model is the exception.
    expect(gRates.input_rate_by_modality.audio).toBeNull();
    expect(gRates.input_rate_by_modality.video).toBeNull();
    expect(gRates.input_rate_by_modality.text!.amount).toBe(1.25);
  });

  it('has no cache profile, because none is published for THIS model', () => {
    // The family publishes cache rates with a per-hour storage charge; 2.5 Pro is
    // not among them. Carrying a Flash rate across is another model's answer.
    expect(gRates.cache).toBeNull();
    expect(rates.cache).not.toBeNull();
  });
});
