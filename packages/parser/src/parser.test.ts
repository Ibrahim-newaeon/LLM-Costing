// /packages/parser/src/parser.test.ts
//
// §A4.4 names the mistakes it expects an implementation to make. Each one gets a
// test here, and the two most expensive get a mutation on record.
//
//   pnpm vitest packages/parser     # offline, free

import { describe, it, expect } from 'vitest';
import {
  normalize, scriptMix, westernizeArabicNumerals, westernizeChineseNumerals,
  diacriticDensity, normalizeArabic,
  matchIntents, isNegated,
  extractVolume, detectConditional, classifyDocument, detectPdfKind,
  applyDefaults, type DefaultsSeed,
  parseL1, payloadLanguages, PARSE_CONFIDENCE_FLOOR,
} from './index';

/**
 * §A4.4.4's seed table, as it would arrive from `defaults_seed`. NOT in the source
 * — these are the operator's baselines, tagged USER_SUPPLIED_BASELINE, "not facts".
 */
const SEED: DefaultsSeed = [
  { doc_class: 'short_form', input_tokens: 300, output_tokens: 200, image_width_px: null, image_height_px: null, image_detail: null, source: 'USER_SUPPLIED_BASELINE' },
  { doc_class: 'medium_form', input_tokens: 2_000, output_tokens: 800, image_width_px: null, image_height_px: null, image_detail: null, source: 'USER_SUPPLIED_BASELINE' },
  { doc_class: 'long_form', input_tokens: 25_000, output_tokens: 2_000, image_width_px: null, image_height_px: null, image_detail: null, source: 'USER_SUPPLIED_BASELINE' },
  { doc_class: 'image_unspecified', input_tokens: null, output_tokens: null, image_width_px: 1024, image_height_px: 1024, image_detail: 'high', source: 'USER_SUPPLIED_BASELINE' },
];

/* ══════════════ §A4.4.3 — the two misclassifications, by name ══════════════ */

describe('the lexicon maps verb to task SEQUENCE, not verb to task', () => {
  it('translate is READ + WRITE — output was undercounted by a whole document', () => {
    const hits = matchIntents(normalize('translate the contract').matchable);
    const t = hits.find((h) => h.entry.intent === 'translate')!;
    expect(t.entry.expansion.map((e) => e.type)).toEqual(['READ', 'WRITE']);
    expect(t.entry.expansion[1]!.ratio_hint).toBe('OUTPUT_APPROX_EQUALS_INPUT');
  });

  it('summarize is READ + WRITE — INPUT was undercounted by a whole document', () => {
    const hits = matchIntents(normalize('summarize it').matchable);
    const s = hits.find((h) => h.entry.intent === 'summarize')!;
    expect(s.entry.expansion.map((e) => e.type)).toEqual(['READ', 'WRITE']);
    expect(s.entry.expansion[1]!.ratio_hint).toBe('OUTPUT_MUCH_SMALLER_THAN_INPUT');
  });

  it('one intent renders as exactly two billable parts, the second linked to the first', () => {
    const r = parseL1({ text: 'summarize the contract', seed: SEED });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    const pair = r.workflow.tasks.filter((t) => t.task_id.startsWith('intent:summarize'));
    expect(pair).toHaveLength(2);
    expect(pair.map((t) => t.type)).toEqual(['READ', 'WRITE']);
    // The link runs second→first. Anchoring on a synthetic parent instead would put
    // a third row in `tasks` that no line bills, and would name an id that does not
    // exist — WorkflowInput rejects the second, which is how the first got caught.
    expect(pair[0]!.expands_from).toBeNull();
    expect(pair[1]!.expands_from).toBe(pair[0]!.task_id);
  });

  it('every expands_from resolves to a task in the same workflow', () => {
    const r = parseL1({ text: 'translate and summarize the contract', seed: SEED });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    const ids = new Set(r.workflow.tasks.map((t) => t.task_id));
    for (const t of r.workflow.tasks) {
      if (t.expands_from !== null) expect(ids.has(t.expands_from)).toBe(true);
    }
  });

  it('a single-step intent does NOT get a spurious expands_from', () => {
    const r = parseL1({ text: 'upload the report', seed: SEED });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    expect(r.workflow.tasks.every((t) => t.expands_from === null)).toBe(true);
  });

  it('matches longest-first, so "rewrite" is not read as "write"', () => {
    const hits = matchIntents(normalize('rewrite the intro').matchable);
    expect(hits.map((h) => h.entry.intent)).toContain('rewrite');
    expect(hits.map((h) => h.entry.intent)).not.toContain('write');
  });
});

/* ══════════════ §A4.4.2 — the silent numeral drop ══════════════ */

describe('numerals are westernized BEFORE any quantity regex', () => {
  it('Arabic-Indic digits survive into the volume', () => {
    // "a quantity regex that only matches [0-9] silently drops every number in an
    // Arabic prompt, and a dropped quantity becomes a default, which becomes a
    // wrong estimate". 500 contracts read as 1 is a 500x underestimate.
    expect(westernizeArabicNumerals('٥٠٠')).toBe('500');
    const v = extractVolume(normalize('لخص ٥٠٠ عقد').matchable);
    expect(v.volume).toBe(500);
    expect(v.basis).toBe('EXPLICIT_COUNT');
  });

  it('Chinese numerals survive, including the compositional forms', () => {
    expect(westernizeChineseNumerals('五份合同')).toBe('5份合同');
    expect(westernizeChineseNumerals('二十份')).toBe('20份');
    expect(westernizeChineseNumerals('两千')).toBe('2000');
    expect(westernizeChineseNumerals('十五')).toBe('15');
    expect(extractVolume(normalize('总结五份合同').matchable).volume).toBe(5);
  });

  it('a measure word is the strongest signal and beats a bare number', () => {
    const v = extractVolume(normalize('处理 2024 年的 5 份合同').matchable);
    expect(v.volume).toBe(5);
    expect(v.basis).toBe('MEASURE_WORD');
  });

  it('converts numerals regardless of the dominant script', () => {
    // A Gulf prompt in English carrying Arabic-Indic digits. Keying the conversion
    // off the dominant script would reintroduce the drop.
    expect(extractVolume(normalize('summarize ٤٠ documents').matchable).volume).toBe(40);
  });
});

/* ══════════════ §A4.4.2 — Arabic normalization ══════════════ */

describe('normalizeArabic applies the six steps', () => {
  it('strips tashkeel, folds alef forms, and normalizes ة and ى', () => {
    expect(normalizeArabic('اَلْعَقْد')).toBe('العقد'.replace(/^ال/, ''));
    expect(normalizeArabic('أحمد إبراهيم آسيا')).toContain('ا');
    expect(normalizeArabic('مراجعة')).toContain('مراجعه');
  });

  it('a vocalized verb and a bare one match the same lexicon entry', () => {
    const a = matchIntents(normalize('لخّص العقد').matchable).map((h) => h.entry.intent);
    const b = matchIntents(normalize('لخص العقد').matchable).map((h) => h.entry.intent);
    expect(a).toContain('summarize');
    expect(b).toContain('summarize');
  });

  it('measures diacritic density on the ORIGINAL — tashkeel is billable', () => {
    // §A4.4.5: "Vocalization is a spectrum, not a boolean." The normalized string
    // has the diacritics stripped, so measuring there would report every text as
    // unvocalized and misprice the ones that are.
    const vocalized = 'اَلْحَمْدُ لِلَّهِ';
    const bare = 'الحمد لله';
    expect(diacriticDensity(vocalized)).toBeGreaterThan(0.3);
    expect(diacriticDensity(bare)).toBe(0);
    expect(normalize(vocalized).diacritic_density).toBeGreaterThan(0.3);
    expect(normalize(vocalized).matchable).not.toMatch(/[ً-ْ]/);
  });
});

/* ══════════════ §A4.4.2 — script PROPORTIONS, not a label ══════════════ */

describe('scriptMix reports proportions', () => {
  it('a Gulf mixed document reports all three shares', () => {
    // "an Arabic contract with English legal terms, Western numerals and a Chinese
    // counterparty name" — the tokenizer follows the mix, not the majority.
    const mix = scriptMix('هذا العقد force majeure مع 深圳科技 بتاريخ 2026');
    expect(mix.arabic).toBeGreaterThan(0);
    expect(mix.latin).toBeGreaterThan(0);
    expect(mix.han).toBeGreaterThan(0);
    expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('digits and punctuation are excluded from the denominator', () => {
    // Otherwise a number-heavy Arabic document drifts toward `latin` in proportion
    // to how many figures it happens to contain.
    const withNumbers = scriptMix('عقد 123456789 عقد');
    const without = scriptMix('عقد عقد');
    expect(withNumbers.arabic).toBeCloseTo(without.arabic!, 10);
    expect(withNumbers.latin).toBeUndefined();
  });
});

/* ══════════════ §A4.4.3 — negation ══════════════ */

describe('a negated verb is not a task', () => {
  it('"don\'t summarize, just extract" does not produce a summarize task', () => {
    const r = parseL1({ text: "don't summarize, just extract the clauses", seed: SEED });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    const intents = r.workflow.tasks.map((t) => t.task_id);
    expect(intents.some((i) => i.includes('summarize'))).toBe(false);
  });

  it('works in Arabic and Chinese', () => {
    expect(matchIntents(normalize('لا تلخص، فقط استخرج').matchable)
      .find((h) => h.entry.intent === 'summarize')!.negated).toBe(true);
    expect(matchIntents(normalize('不要总结，只提取').matchable)
      .find((h) => h.entry.intent === 'summarize')!.negated).toBe(true);
  });

  it('the window is local — a later negation does not suppress an earlier verb', () => {
    const text = normalize("extract the clauses, don't bother with formatting").matchable;
    const extract = matchIntents(text).find((h) => h.entry.intent === 'ingest');
    expect(extract?.negated).toBe(false);
  });

  it('isNegated only looks backwards, within the window', () => {
    const s = "please don't summarize";
    expect(isNegated(s, s.indexOf('summarize'))).toBe(true);
    expect(isNegated('summarize this', 0)).toBe(false);
  });

  it('a contrast marker closes the negation — "just X" is a request, not a refusal', () => {
    const s = "don't summarize, just extract the clauses";
    expect(isNegated(s, s.indexOf('summarize'))).toBe(true);
    expect(isNegated(s, s.indexOf('extract'))).toBe(false);
  });

  it('without a contrast marker the negation carries across the conjunction', () => {
    const s = "don't summarize or extract anything";
    expect(isNegated(s, s.indexOf('extract'))).toBe(true);
  });

  it('a negator that contains a contrast word does not cancel itself', () => {
    // "rather than" contains "rather ", "instead of" contains "instead ". Scanning
    // from the negator's start rather than its end would re-admit both verbs.
    const a = 'rather than summarize it';
    const b = 'instead of summarize it';
    expect(isNegated(a, a.indexOf('summarize'))).toBe(true);
    expect(isNegated(b, b.indexOf('summarize'))).toBe(true);
  });

  it('the contrast rule holds in Arabic and Chinese', () => {
    const ar = normalize('لا تلخص، فقط استخرج البنود').matchable;
    const arHits = matchIntents(ar);
    expect(arHits.find((h) => h.entry.intent === 'summarize')!.negated).toBe(true);
    expect(arHits.find((h) => h.entry.intent === 'ingest')!.negated).toBe(false);

    const zh = normalize('不要总结，只提取条款').matchable;
    const zhHits = matchIntents(zh);
    expect(zhHits.find((h) => h.entry.intent === 'summarize')!.negated).toBe(true);
    expect(zhHits.find((h) => h.entry.intent === 'ingest')!.negated).toBe(false);
  });
});

/* ══════════════ §A4.4.3 — volume and conditionals ══════════════ */

describe('iteration language, the 100x underestimate', () => {
  it('an explicit count sets the volume', () => {
    expect(extractVolume(normalize('for each of the 40 documents').matchable).volume).toBe(40);
  });

  it('iteration WITHOUT a count is a question, not a volume of 1', () => {
    // Defaulting to 1 here IS the underestimate the spec warns about.
    const v = extractVolume(normalize('for each contract, summarize it').matchable);
    expect(v.basis).toBe('ITERATION_BARE_PLURAL');
    const d = applyDefaults({ task_id: 't1', doc_class: 'long_form', seed: SEED, volume_unquantified: true });
    expect(d.missing.map((m) => m.field)).toContain('volume');
    expect(d.missing[0]!.why_it_matters).toMatch(/100x underestimate/);
  });

  it('a conditional is recorded as a branch, and its probability is NOT invented', () => {
    // "could be almost always or almost never depending on the corpus, and nothing
    // in the text says which."
    expect(detectConditional(normalize('summarize it if it is over 10 pages').matchable).is_conditional).toBe(true);
    const r = parseL1({ text: 'summarize the contract if it is over 10 pages', seed: SEED, confidence_floor: 0 });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    expect(r.workflow.missing_data.map((m) => m.field)).toContain('execution_probability');
    expect(r.workflow.tasks.every((t) => t.execution_probability === 1)).toBe(true);
  });
});

/* ══════════════ §A4.4.4 — the defaults engine ══════════════ */

describe('guess quantities, never over a measurement', () => {
  it('a default fires when nothing is attached, labelled and editable', () => {
    const d = applyDefaults({ task_id: 't1', doc_class: 'long_form', seed: SEED });
    const input = d.applied.find((a) => a.field === 'input_tokens')!;
    expect(input.value).toBe(25_000);
    expect(input.assumption.basis).toBe('DEFAULT_APPLIED');
    expect(input.assumption.seed_provenance).toBe('SEED_UNCALIBRATED');
    expect(input.assumption.user_editable).toBe(true);
    expect(input.assumption.sensitivity_rank).toBeNull();
  });

  it('rule 4: a measured value always beats a default', () => {
    const d = applyDefaults({
      task_id: 't1', doc_class: 'long_form', seed: SEED,
      measured: { character_count: 48_000, asset_attached: true },
    });
    expect(d.applied.find((a) => a.field === 'input_tokens')).toBeUndefined();
    expect(d.suppressed.join(' ')).toMatch(/measured value always beats a default/);
  });

  it('an absent seed row means NO default, not a constant standing in', () => {
    // §A4.4.4 keeps the baselines out of code. An empty table has to behave like
    // one, or the "not in code" rule is decorative.
    const d = applyDefaults({ task_id: 't1', doc_class: 'long_form', seed: [] });
    expect(d.applied).toHaveLength(0);
    expect(d.suppressed.join(' ')).toMatch(/no defaults_seed row/);
  });

  it('no document class means a question rather than the middle option', () => {
    const d = applyDefaults({ task_id: 't1', doc_class: null, seed: SEED });
    expect(d.applied).toHaveLength(0);
    expect(d.missing.map((m) => m.field)).toContain('document_length');
  });

  it('two stacked defaults cap the workflow at LOW (§A4.4.4 rule 3)', () => {
    // Computed by stackedAssumptionCeiling in the contracts, not restated here.
    const r = parseL1({ text: 'write an article', seed: SEED });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    expect(r.workflow.assumptions.length).toBeGreaterThanOrEqual(2);
    expect(r.workflow.confidence).toBe('LOW');
    expect(r.workflow.needs_human_review).toBe(true);
  });
});

/* ══════════════ §A4.4.7 — the question no default can answer ══════════════ */

describe('scanned or text-layer is asked, never assumed', () => {
  it('an unqualified PDF blocks with a question', () => {
    const r = parseL1({ text: 'upload the contract pdf and summarize it', seed: SEED });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    const q = r.workflow.missing_data.find((m) => m.field === 'pdf_has_text_layer')!;
    expect(q.blocks_estimate).toBe(true);
    expect(q.why_it_matters).toMatch(/once per page/);
    expect(r.workflow.needs_human_review).toBe(true);
  });

  it('does not ask when the text says which', () => {
    expect(detectPdfKind(normalize('a scanned contract').matchable)).toBe('SCANNED');
    expect(detectPdfKind(normalize('a searchable pdf').matchable)).toBe('TEXT_LAYER');
    const r = parseL1({ text: 'summarize the scanned contract pdf', seed: SEED });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    expect(r.workflow.missing_data.map((m) => m.field)).not.toContain('pdf_has_text_layer');
  });

  it('does not ask when a real asset is attached — it can be measured', () => {
    const r = parseL1({
      text: 'summarize the contract pdf', seed: SEED,
      measured: { character_count: 40_000, asset_attached: true },
    });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    expect(r.workflow.missing_data.map((m) => m.field)).not.toContain('pdf_has_text_layer');
  });
});

/* ══════════════ §A4.4.1 — L1, the floor, and the free parse ══════════════ */

describe('L1 emits or escalates, and an L1 parse costs nothing', () => {
  it('an L1 parse records no parser model — that absence IS the margin metric', () => {
    const r = parseL1({ text: 'summarize the contract', seed: SEED });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    expect(r.workflow.parse_meta!.layer).toBe('L1_DETERMINISTIC');
    expect(r.workflow.parse_meta!.parser_model_id).toBeNull();
    expect(r.workflow.parse_meta!.parser_input_tokens).toBeNull();
  });

  it('escalates when no verb matches, rather than emitting an empty workflow', () => {
    const r = parseL1({ text: 'hmm, the thing about the other thing', seed: SEED });
    expect(r.status).toBe('ESCALATE');
    if (r.status === 'ESCALATE') {
      expect(r.parse_confidence).toBeLessThan(PARSE_CONFIDENCE_FLOOR);
      expect(r.reason).toMatch(/No actionable verb/);
    }
  });

  it('hands L2 what L1 managed, rather than only the raw string', () => {
    // Three independent penalties, deliberately: a suppressed verb (don't translate),
    // a conditional (if), and three scripts. Each is priced in parseConfidence; only
    // together do they clear the floor. A text that escalates on one penalty would
    // make this test pass for a reason it is not testing.
    const r = parseL1({
      text: "summarize this if it is long, but don't translate it — العقد 合同",
      seed: SEED,
    });
    if (r.status !== 'ESCALATE') throw new Error('expected escalation');
    expect(r.parse_confidence).toBeLessThan(PARSE_CONFIDENCE_FLOOR);
    // What L1 did manage survives: the verb it matched and the scripts it measured.
    expect(r.partial.intents).toContain('summarize');
    expect(Object.keys(r.partial.script_mix).length).toBeGreaterThan(2);
  });

  it('a conditional pulls confidence down toward escalation', () => {
    const plain = parseL1({ text: 'summarize the contract', seed: SEED });
    const cond = parseL1({ text: 'summarize the contract if it is over 10 pages', seed: SEED, confidence_floor: 0 });
    if (plain.status !== 'PARSED' || cond.status !== 'PARSED') throw new Error('parse');
    expect(cond.workflow.parse_meta!.parse_confidence)
      .toBeLessThan(plain.workflow.parse_meta!.parse_confidence);
  });
});

/* ══════════════ §A4.4.6 — three language fields ══════════════ */

describe('instruction language is not payload language', () => {
  it('an English request about a Chinese payload does not report Chinese as the instruction', () => {
    // §A4.4.6's own example. Conflating them is "a direct mispricing".
    const r = parseL1({ text: 'upload a Chinese contract pdf and summarize it', seed: SEED, ui_language: 'ar' });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    expect(r.workflow.languages.instruction_language).toBe('latin');
    expect(r.workflow.languages.ui_language).toBe('ar');
  });

  it('payloadLanguages reads the ASSET, and shares sum to 1', () => {
    const langs = payloadLanguages('本合同由深圳科技有限公司 and Acme Ltd 签订');
    expect(langs[0]!.code).toBe('zh-Hans');
    expect(langs.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 10);
  });
});

/* ══════════════ §A4.4's own worked trace ══════════════ */

describe('the spec\'s worked example', () => {
  const TEXT =
    'I want to upload a Chinese contract PDF, summarize it, and generate a featured image for the article';

  it('produces four tasks from three verbs', () => {
    // §A4.4.7's trace: t1 READ ingest, t2+t3 the summarize halves, t4 image_generate.
    const r = parseL1({ text: TEXT, seed: SEED, confidence_floor: 0 });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    const kinds = r.workflow.tasks.map((t) => `${t.type}:${t.sub_kind}`);
    expect(kinds).toContain('READ:context_ingestion');
    expect(kinds).toContain('WRITE:completion');
    expect(kinds).toContain('EDIT:image_generate');
    expect(r.workflow.tasks.length).toBeGreaterThanOrEqual(4);
  });

  it('blocks on the scan question and lands at LOW with review required', () => {
    const r = parseL1({ text: TEXT, seed: SEED, confidence_floor: 0 });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    expect(r.workflow.missing_data.map((m) => m.field)).toContain('pdf_has_text_layer');
    expect(r.workflow.confidence).toBe('LOW');
    expect(r.workflow.needs_human_review).toBe(true);
  });

  it('defaults the image dimensions, labelled and editable', () => {
    const r = parseL1({ text: TEXT, seed: SEED, confidence_floor: 0 });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    const dims = r.workflow.assumptions.find((a) => a.field === 'image_dimensions')!;
    expect(dims.value).toMatchObject({ width_px: 1024, height_px: 1024, detail: 'high' });
    expect(dims.seed_provenance).toBe('SEED_UNCALIBRATED');
  });

  it('flags the doc-class overlap rather than silently taking the larger', () => {
    // "contract" and "article" both appear; they differ by 12.5x in seed input.
    const r = parseL1({ text: TEXT, seed: SEED, confidence_floor: 0 });
    if (r.status !== 'PARSED') throw new Error(r.reason);
    const amb = r.workflow.ambiguities.find((a) => a.field === 'doc_class');
    expect(amb).toBeDefined();
    expect(amb!.impact).toBe('ORDER_OF_MAGNITUDE');
  });
});
