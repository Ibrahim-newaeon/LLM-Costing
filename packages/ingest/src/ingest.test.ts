// /packages/ingest/src/ingest.test.ts
//
// §A4.2 / §A6 — the pipeline, offline. The feed is a verbatim excerpt of LiteLLM's
// file (fixtures/litellm.excerpt.json, hash and retrieval time recorded there); the
// registry is the real one. Every synthetic figure below says so in its name.
//
//   pnpm vitest packages/ingest     # offline, free

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Registry, type Observation, type RateObservation } from '@tokenomics/contracts';
import { fixturePort, takeSnapshot, unchangedSince, type SourceSpec } from './index';
import { extractLiteLLM, LiteLLMKeyMap } from './litellm';
import { compareRates, perToken } from './compare';
import { diffObservations, priceChangeWarnings } from './diff';
import { applyConflicts } from './apply';
import { openConflicts } from './queue';

/* ─────────────────────────── evidence ─────────────────────────── */

const ROOT = join(__dirname, '..', '..', '..');
const registry = Registry.parse(JSON.parse(readFileSync(join(ROOT, 'registry', 'registry.json'), 'utf8')));
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'litellm.excerpt.json'), 'utf8')) as {
  _fixture: { source_url: string; retrieved_at: string };
  feed: Record<string, unknown>;
};
const sourceConfig = JSON.parse(readFileSync(join(ROOT, 'registry', 'sources', 'litellm.json'), 'utf8')) as {
  source_id: string;
  source_class: 'AGGREGATOR';
  source_url: string;
  currency: { value: string };
  keys: unknown;
};

const SOURCE: SourceSpec = {
  source_id: sourceConfig.source_id,
  source_class: sourceConfig.source_class,
  source_url: sourceConfig.source_url,
};
const KEYS = LiteLLMKeyMap.parse(sourceConfig.keys);
const BODY = JSON.stringify(fixture.feed);
const NOW = new Date(fixture._fixture.retrieved_at);
const opus = registry.models.find((m) => m.model_id === 'claude-opus-5')!;
const gemini = registry.models.find((m) => m.model_id === 'gemini-2.5-pro')!;

async function pull() {
  const snap = await takeSnapshot(fixturePort({ [SOURCE.source_url]: BODY }), SOURCE, NOW);
  if (snap.status !== 'OK') throw new Error(snap.reason);
  const extracted = extractLiteLLM({ body: snap.body, snapshot: snap.snapshot, keys: KEYS, currency: sourceConfig.currency.value });
  return { ...snap, ...extracted };
}

const find = (obs: readonly Observation[], model_id: string, pred: (o: RateObservation) => boolean): RateObservation => {
  const hit = obs.find((o): o is RateObservation => o.kind === 'RATE' && o.model_id === model_id && pred(o));
  if (!hit) throw new Error(`no RATE observation for ${model_id} matching predicate`);
  return hit;
};

/* ─────────────────────────── snapshot ─────────────────────────── */

describe('takeSnapshot — an immutable record of one read', () => {
  it('records the source, the time it was given, and the hash of exactly the bytes received', async () => {
    const r = await takeSnapshot(fixturePort({ [SOURCE.source_url]: BODY }), SOURCE, NOW);
    expect(r.status).toBe('OK');
    if (r.status !== 'OK') return;
    expect(r.snapshot.snapshot_id).toBe(`litellm@${NOW.toISOString()}`);
    expect(r.snapshot.retrieved_at).toBe(NOW.toISOString());
    expect(r.snapshot.byte_length).toBe(Buffer.byteLength(BODY, 'utf8'));
    expect(r.snapshot.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body).toBe(BODY);
  });

  it('the same bytes hash the same; one changed byte does not', async () => {
    const a = await takeSnapshot(fixturePort({ [SOURCE.source_url]: BODY }), SOURCE, NOW);
    const b = await takeSnapshot(fixturePort({ [SOURCE.source_url]: BODY }), SOURCE, new Date(NOW.getTime() + 1));
    const c = await takeSnapshot(fixturePort({ [SOURCE.source_url]: BODY + ' ' }), SOURCE, NOW);
    if (a.status !== 'OK' || b.status !== 'OK' || c.status !== 'OK') throw new Error('fixture failed');
    expect(unchangedSince(a.snapshot, b.snapshot)).toBe(true);
    expect(unchangedSince(a.snapshot, c.snapshot)).toBe(false);
  });

  it('a non-2xx leaves NO snapshot — a 503 is a fact about the fetch, not the prices', async () => {
    const r = await takeSnapshot(async () => ({ status: 503, text: '' }), SOURCE, NOW);
    expect(r).toEqual({ status: 'FAILED', reason: expect.stringContaining('HTTP 503'), http_status: 503 });
  });

  it('a transport that throws is reported, not propagated', async () => {
    const r = await takeSnapshot(async () => { throw new Error('ECONNRESET'); }, SOURCE, NOW);
    expect(r.status).toBe('FAILED');
    if (r.status === 'FAILED') expect(r.reason).toContain('ECONNRESET');
  });

  it('the fixture port refuses a URL it has no evidence for', async () => {
    await expect(fixturePort({})({ url: 'https://example.invalid/other' })).rejects.toThrow(/no fixture/);
  });
});

/* ─────────────────────────── extraction ─────────────────────────── */

describe('extractLiteLLM — the feed, read verbatim in its own unit', () => {
  it('reads the Anthropic row: four rates, two limits, one lifecycle claim', async () => {
    const { observations } = await pull();
    const o = observations.filter((x) => x.model_id === 'claude-opus-5');
    expect(find(o, 'claude-opus-5', (r) => r.key.direction === 'input' && r.key.modality === 'text').amount).toBe(0.000005);
    expect(find(o, 'claude-opus-5', (r) => r.key.direction === 'output').amount).toBe(0.000025);
    expect(find(o, 'claude-opus-5', (r) => r.key.direction === 'cache_write').amount).toBe(0.00000625);
    expect(find(o, 'claude-opus-5', (r) => r.key.direction === 'cache_read').amount).toBe(5e-7);
    for (const r of o) if (r.kind === 'RATE') { expect(r.unit).toBe('per_token'); expect(r.currency).toBe('USD'); }
    expect(o.find((x) => x.kind === 'LIMIT' && x.which === 'context_window')).toMatchObject({ value: 1_000_000 });
    expect(o.find((x) => x.kind === 'LIMIT' && x.which === 'max_output')).toMatchObject({ value: 128_000 });
    const life = o.find((x) => x.kind === 'LIFECYCLE');
    expect(life).toMatchObject({ which: 'deprecation_date', value: '2027-07-24T00:00:00.000Z' });
    expect(life?.provenance.notes).toContain('feed states date only: 2027-07-24');
  });

  it('reads the Gemini row including the 200k context-tier fields by pattern', async () => {
    const { observations } = await pull();
    const above = (dir: RateObservation['key']['direction']) =>
      find(observations, 'gemini-2.5-pro', (r) => r.key.direction === dir && r.key.above_tokens === 200_000).amount;
    expect(find(observations, 'gemini-2.5-pro', (r) => r.key.direction === 'input' && r.key.above_tokens === null).amount).toBe(0.00000125);
    expect(above('input')).toBe(0.0000025);
    expect(find(observations, 'gemini-2.5-pro', (r) => r.key.direction === 'output' && r.key.above_tokens === null).amount).toBe(0.00001);
    expect(above('output')).toBe(0.000015);
    expect(above('cache_read')).toBe(2.5e-7);
    // `cache_creation_input_token_cost_above_1hr` on the Anthropic row is a TTL
    // variant, not a context tier, and must not be read as one.
    expect(observations.some((o) => o.kind === 'RATE' && o.key.above_tokens === 1)).toBe(false);
  });

  it('every observation is AGGREGATOR at MEDIUM, cites the snapshot, and keeps the feed key', async () => {
    const { observations, snapshot } = await pull();
    for (const o of observations) {
      expect(o.provenance.source_class).toBe('AGGREGATOR');
      expect(o.provenance.confidence).toBe('MEDIUM');
      expect(o.provenance.source_url).toBe(snapshot.source_url);
      expect(o.provenance.verified_at).toBe(snapshot.retrieved_at);
      expect(o.snapshot_id).toBe(snapshot.snapshot_id);
      expect(o.provenance.notes).toContain(`LiteLLM key "${o.source_key}"`);
    }
  });

  it('a mapped key the feed no longer carries is reported as missing, never guessed from a similar key', async () => {
    const { snapshot } = await pull();
    const r = extractLiteLLM({
      body: BODY,
      snapshot,
      keys: { 'claude-opus-5': { key: 'anthropic/claude-opus-5-not-in-excerpt', reason: 'test' } },
      currency: 'USD',
    });
    expect(r.observations).toEqual([]);
    expect(r.missing).toEqual([{ model_id: 'claude-opus-5', key: 'anthropic/claude-opus-5-not-in-excerpt' }]);
  });

  it('a known field with the wrong shape makes the entry malformed, not silently partial', async () => {
    const { snapshot } = await pull();
    const feed = { ...fixture.feed, 'claude-opus-5': { ...(fixture.feed['claude-opus-5'] as object), input_cost_per_token: '5e-6' } };
    const r = extractLiteLLM({ body: JSON.stringify(feed), snapshot, keys: KEYS, currency: 'USD' });
    expect(r.malformed).toHaveLength(1);
    expect(r.malformed[0]).toMatchObject({ model_id: 'claude-opus-5', issue: expect.stringContaining('input_cost_per_token') });
    expect(r.observations.some((o) => o.model_id === 'claude-opus-5')).toBe(false);
  });

  it('a body that is not a JSON object is refused outright (§A4.2 — validate before it touches anything)', async () => {
    const { snapshot } = await pull();
    expect(() => extractLiteLLM({ body: '<html>', snapshot, keys: KEYS, currency: 'USD' })).toThrow(/not JSON/);
    expect(() => extractLiteLLM({ body: '[1,2]', snapshot, keys: KEYS, currency: 'USD' })).toThrow(/not a JSON object/);
  });
});

/* ─────────────────────────── comparison (rule 5) ─────────────────────────── */

/** SYNTHETIC — the real observation with its amount scaled. Named so nothing mistakes it for a reading. */
const synthetic = (o: RateObservation, factor: number, over: Partial<RateObservation> = {}): RateObservation => ({
  ...o,
  amount: o.amount * factor,
  snapshot_id: 'SYNTHETIC-second-source@2026-09-09T00:00:00.000Z',
  provenance: { ...o.provenance, source_url: 'https://example.invalid/synthetic-second-source.json' },
  ...over,
});

describe('compareRates — the registry against the feed', () => {
  it('perToken normalizes the three token units and refuses the rest', () => {
    expect(perToken(5, 'per_1m_tokens')).toBe(0.000005);
    expect(perToken(0.005, 'per_1k_tokens')).toBe(0.000005);
    expect(perToken(0.000005, 'per_token')).toBe(0.000005);
    expect(perToken(3, 'per_image')).toBeNull();
  });

  it('tolerance is required: no default policy', () => {
    expect(() => compareRates(opus, [], Number.NaN)).toThrow(/tolerance_pct/);
    expect(() => compareRates(opus, [], -1)).toThrow(/tolerance_pct/);
  });

  it('on the real data every comparable Anthropic figure AGREES with the vendor-sourced row', async () => {
    const { observations } = await pull();
    const cs = compareRates(opus, observations, 0);
    const byDir = Object.fromEntries(cs.map((c) => [`${c.key.direction}|${c.key.above_tokens ?? '-'}`, c.outcome]));
    expect(byDir).toEqual({ 'input|-': 'AGREE', 'output|-': 'AGREE', 'cache_write|-': 'AGREE', 'cache_read|-': 'AGREE' });
    for (const c of cs) { expect(c.delta_pct).toBe(0); expect(c.conflict).toBeNull(); expect(c.registry?.unit).toBe('per_1m_tokens'); }
  });

  it('on the real data every Gemini figure the feed states — six of them, cache read at both tiers included — AGREES', async () => {
    // The two cache-read slots were REGISTRY_UNSOURCED leads when this pipeline
    // first ran (2026-09-09 morning). The pricing page was then read in the browser
    // and the row filled in; the same run now agrees on all six.
    const { observations } = await pull();
    const cs = compareRates(gemini, observations, 0);
    const outcome = (dir: string, above: number | null) =>
      cs.find((c) => c.key.direction === dir && c.key.above_tokens === above)?.outcome;
    expect(outcome('input', null)).toBe('AGREE');
    expect(outcome('output', null)).toBe('AGREE');
    expect(outcome('input', 200_000)).toBe('AGREE');
    expect(outcome('output', 200_000)).toBe('AGREE');
    expect(outcome('cache_read', null)).toBe('AGREE');
    expect(outcome('cache_read', 200_000)).toBe('AGREE');
    expect(cs.filter((c) => c.outcome !== 'AGREE')).toEqual([]);
  });

  it('a slot the registry never sourced is REGISTRY_UNSOURCED — a lead with a path, not a value', async () => {
    // SYNTHETIC: the real row with its cache profile removed, which is exactly the
    // state the row was in before the pricing page was read.
    const { observations } = await pull();
    const bare = structuredClone(gemini);
    bare.text_rates[0]!.cache = null;
    bare.text_rates[0]!.context_tiers![1]!.cache_read_rate = null;
    const cs = compareRates(bare, observations, 0);
    const lead = cs.find((c) => c.key.direction === 'cache_read' && c.key.above_tokens === null)!;
    expect(lead.outcome).toBe('REGISTRY_UNSOURCED');
    expect(lead.path).toBe('text_rates[standard].cache.read_rate');
    expect(lead.registry).toBeNull();
    expect(lead.reason).toContain('not a value to write');
    expect(cs.find((c) => c.key.direction === 'cache_read' && c.key.above_tokens === 200_000)?.outcome).toBe('REGISTRY_UNSOURCED');
  });

  it('a tier boundary the registry does not draw is NO_SLOT, not the nearest tier', async () => {
    const { observations } = await pull();
    const o = find(observations, 'gemini-2.5-pro', (r) => r.key.direction === 'input' && r.key.above_tokens === 200_000);
    const cs = compareRates(gemini, [synthetic(o, 1, { key: { ...o.key, above_tokens: 128_000 } })], 0);
    expect(cs[0]?.outcome).toBe('NO_SLOT');
    expect(cs[0]?.reason).toContain('128000');
  });

  it('beyond tolerance is a CONFLICT carrying both figures in the registry unit and a signed delta — nothing averaged', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'input' && r.key.modality === 'text');
    const [c] = compareRates(opus, [synthetic(o, 2)], 5);
    expect(c?.outcome).toBe('CONFLICT');
    expect(c?.delta_pct).toBe(100);
    expect(c?.registry).toMatchObject({ amount: 5, unit: 'per_1m_tokens', currency: 'USD' });
    expect(c?.conflict).toMatchObject({
      competing_record_id: 'SYNTHETIC-second-source@2026-09-09T00:00:00.000Z',
      competing_amount: 10,
      competing_source_url: 'https://example.invalid/synthetic-second-source.json',
      delta_pct: 100,
      resolved: false,
    });
    expect(c?.reason).toContain('neither averaged');
    expect(c?.reason).not.toContain('7.5'); // the average of 5 and 10 appears nowhere
  });

  it('a lower competing figure keeps its sign', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    const [c] = compareRates(opus, [synthetic(o, 0.5)], 5);
    expect(c?.outcome).toBe('CONFLICT');
    expect(c?.delta_pct).toBe(-50);
    expect(c?.conflict?.competing_amount).toBe(12.5);
  });

  it('inside tolerance is reported as WITHIN_TOLERANCE with its delta, not folded into AGREE', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    const [c] = compareRates(opus, [synthetic(o, 1.01)], 5);
    expect(c?.outcome).toBe('WITHIN_TOLERANCE');
    expect(c?.delta_pct).toBeCloseTo(1, 6);
    expect(c?.conflict).toBeNull();
  });

  it('tolerance 0 makes any difference a CONFLICT', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    expect(compareRates(opus, [synthetic(o, 1.01)], 0)[0]?.outcome).toBe('CONFLICT');
  });

  it('a different currency is NOT_COMPARABLE — never converted', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    const [c] = compareRates(opus, [synthetic(o, 1, { currency: 'CNY' })], 5);
    expect(c?.outcome).toBe('NOT_COMPARABLE');
    expect(c?.reason).toContain('CNY');
  });

  it('a non-token unit is NOT_COMPARABLE', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    expect(compareRates(opus, [synthetic(o, 1, { unit: 'per_image' })], 5)[0]?.outcome).toBe('NOT_COMPARABLE');
  });

  it('a registry rate of zero has no finite percentage: ZERO_BASE, reported without a delta', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    const free = structuredClone(opus);
    free.text_rates[0]!.output_rate.amount = 0; // SYNTHETIC
    const [c] = compareRates(free, [o], 5);
    expect(c?.outcome).toBe('ZERO_BASE');
    expect(c?.delta_pct).toBeNull();
    expect(c?.conflict).toBeNull();
    expect(compareRates(free, [synthetic(o, 0)], 5)[0]?.outcome).toBe('AGREE');
  });

  it('observations about another model are ignored, not compared to the wrong row', async () => {
    const { observations } = await pull();
    expect(compareRates(opus, observations.filter((o) => o.model_id === 'gemini-2.5-pro'), 0)).toEqual([]);
  });
});

/* ─────────────────────────── diff between two pulls ─────────────────────────── */

describe('diffObservations — what moved between two snapshots of one source', () => {
  it('identical pulls produce no events', async () => {
    const { observations } = await pull();
    expect(diffObservations(observations, observations)).toEqual([]);
  });

  it('a moved figure is CHANGED with both amounts, both snapshot ids and a signed delta', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    const previous = observations.map((x) => (x === o ? synthetic(o, 0.8, { snapshot_id: 'SYNTHETIC-previous' }) : x));
    const events = diffObservations(previous, observations);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      model_id: 'claude-opus-5',
      change: 'CHANGED',
      previous_amount: 0.00002,
      current_amount: 0.000025,
      previous_snapshot_id: 'SYNTHETIC-previous',
      current_snapshot_id: o.snapshot_id,
    });
    // Exactly 25, not 24.999999999999993: the stored delta is rounded once, at the display boundary.
    expect(events[0]?.delta_pct).toBe(25);
  });

  it('a model that appears is ADDED; one that vanishes is REMOVED; neither has a delta', async () => {
    const { observations } = await pull();
    const opusOnly = observations.filter((o) => o.model_id === 'claude-opus-5');
    const added = diffObservations(opusOnly, observations);
    expect(added.every((e) => e.change === 'ADDED' && e.model_id === 'gemini-2.5-pro' && e.delta_pct === null && e.previous_amount === null)).toBe(true);
    const removed = diffObservations(observations, opusOnly);
    expect(removed.every((e) => e.change === 'REMOVED' && e.current_amount === null)).toBe(true);
    expect(added.length).toBe(removed.length);
  });

  it('a figure restated in another unit is REMOVED + ADDED, never a 1000× CHANGED', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    const previous = observations.map((x) => (x === o ? synthetic(o, 1000, { unit: 'per_1k_tokens' }) : x));
    const events = diffObservations(previous, observations);
    expect(events.map((e) => e.change).sort()).toEqual(['ADDED', 'REMOVED']);
  });

  it('a move away from zero has no finite percentage', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    const previous = observations.map((x) => (x === o ? synthetic(o, 0) : x));
    const [e] = diffObservations(previous, observations);
    expect(e?.change).toBe('CHANGED');
    expect(e?.delta_pct).toBeNull();
    expect(priceChangeWarnings([e!])[0]?.message).toContain('no finite percentage');
  });

  it('each event earns a PRICE_CHANGED_SINCE_LAST_RUN warning that names the model, the rate and both figures', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    const previous = observations.map((x) => (x === o ? synthetic(o, 0.8, { snapshot_id: 'SYNTHETIC-previous' }) : x));
    const [w] = priceChangeWarnings(diffObservations(previous, observations));
    expect(w?.code).toBe('PRICE_CHANGED_SINCE_LAST_RUN');
    expect(w?.severity).toBe('WARN');
    expect(w?.message).toContain('claude-opus-5 output moved from 0.00002 to 0.000025 per_token USD (+25%)');
    expect(w?.message).toContain('SYNTHETIC-previous');
  });
});

/* ─────────────────────────── apply + queue ─────────────────────────── */

describe('applyConflicts and openConflicts — the slot is written, then read', () => {
  it('the registry starts with no open conflict', () => {
    expect(openConflicts(registry)).toEqual([]);
  });

  it('a CONFLICT lands on the rate it is about, the figure beside it is untouched, and the queue lists it', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'input' && r.key.modality === 'text');
    const cs = compareRates(opus, [synthetic(o, 2)], 5);
    const { registry: next, applied, unapplied } = applyConflicts(registry, cs);
    expect(applied).toEqual([{ model_id: 'claude-opus-5', path: 'text_rates[standard].input_rate_by_modality.text' }]);
    expect(unapplied).toEqual([]);
    const rate = next.models.find((m) => m.model_id === 'claude-opus-5')!.text_rates[0]!.input_rate_by_modality.text!;
    expect(rate.amount).toBe(5);
    expect(rate.conflict).toMatchObject({ competing_amount: 10, resolved: false });
    expect(registry.models[0]!.text_rates[0]!.input_rate_by_modality.text!.conflict).toBeNull(); // input untouched
    const queue = openConflicts(next);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ model_id: 'claude-opus-5', kind: 'RATE', path: 'text_rates[0].input_rate_by_modality.text' });
  });

  it('non-CONFLICT outcomes write nothing', async () => {
    const { observations } = await pull();
    const r = applyConflicts(registry, compareRates(opus, observations, 0));
    expect(r.applied).toEqual([]);
    expect(openConflicts(r.registry)).toEqual([]);
  });

  it('an unresolved conflict from ANOTHER source is not overwritten — a lost disagreement is a merge', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    const first = applyConflicts(registry, compareRates(opus, [synthetic(o, 2)], 5));
    const third = synthetic(o, 3, { provenance: { ...o.provenance, source_url: 'https://example.invalid/synthetic-third-source.json' } });
    const second = applyConflicts(first.registry, compareRates(first.registry.models[0]!, [third], 5));
    expect(second.applied).toEqual([]);
    expect(second.unapplied[0]?.reason).toContain('synthetic-second-source');
    expect(openConflicts(second.registry)[0]?.conflict).toMatchObject({ competing_amount: 50 });
  });

  it('the same source re-pulled replaces its own conflict; a resolved one is history and is replaced too', async () => {
    const { observations } = await pull();
    const o = find(observations, 'claude-opus-5', (r) => r.key.direction === 'output');
    const first = applyConflicts(registry, compareRates(opus, [synthetic(o, 2)], 5));
    const again = applyConflicts(first.registry, compareRates(first.registry.models[0]!, [synthetic(o, 2.2)], 5));
    expect(again.applied).toHaveLength(1);
    expect(openConflicts(again.registry)[0]?.conflict).toMatchObject({ competing_amount: 55 });

    const resolved = structuredClone(again.registry);
    resolved.models[0]!.text_rates[0]!.output_rate.conflict!.resolved = true;
    expect(openConflicts(resolved)).toEqual([]);
  });

  it('a SourcedConflict on a constant is in the same queue, so rule 5 has one review list', () => {
    const r = structuredClone(registry);
    const g = r.models.find((m) => m.model_id === 'gemini-2.5-pro')!;
    // SYNTHETIC placement: the shape VERIFY #7 will take once the Gemini video_in
    // row exists. The values are the three figures docs/README record from
    // https://ai.google.dev/gemini-api/docs/tokens; the field chosen here is only
    // a sourced slot the row already has.
    g.context_window.conflict = {
      candidates: [
        { value: 263, source_url: 'https://ai.google.dev/gemini-api/docs/tokens', retrieved_at: '2026-09-08T00:00:00.000Z', locator: 'bullet' },
        { value: 300, source_url: 'https://ai.google.dev/gemini-api/docs/tokens', retrieved_at: '2026-09-08T00:00:00.000Z', locator: 'table' },
      ],
      resolved: false,
      notes: null,
    };
    const q = openConflicts(r);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ model_id: 'gemini-2.5-pro', kind: 'CONSTANT', path: 'context_window' });
  });
});
