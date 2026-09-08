// /packages/parser/src/lexicon.ts
//
// §A4.4.3 — the action lexicon, in English, Arabic and Chinese.
//
// ⚠️ THE HEADLINE: this does NOT map verb → task. It maps **verb → task sequence**.
//
// §A4.4.3 names two misclassifications in the original matrix and says both
// undercount:
//
//   translate  READ only  →  actually READ + WRITE. Ingests the whole source AND
//              emits a full-length target. "Undercounts output by roughly one whole
//              document. On a long contract this is the dominant term."
//
//   summarize  WRITE only →  actually READ + WRITE. Ingests the whole source, emits
//              a short output. "Undercounts INPUT by the whole document."
//
// Expanded tasks carry `expands_from` so the UI can show one intent as its two
// billable halves — "you said summarize, here are the two things you are paying
// for", which §A4.4.3 calls "the product's best explanation of itself".
//
// A note on placement: §A4.4.3 suggests `/packages/router/lexicon.ts`. It lives
// here instead, because `packages/router` is §A7's ranking stage — it chooses
// between priced candidates. This is the analyzer that produces the input. Two
// different jobs; the spec's path hint predates the split.

import type { Task } from '@tokenomics/contracts';

type TaskType = Task['type'];
type SubKind = NonNullable<Task['sub_kind']>;

/** One step of an intent. `ratio_hint` is a shape, never a number (§A4.4.3). */
export interface ExpansionStep {
  type: TaskType;
  sub_kind: SubKind;
  ratio_hint?: 'OUTPUT_APPROX_EQUALS_INPUT' | 'OUTPUT_MUCH_SMALLER_THAN_INPUT';
}

export interface LexiconEntry {
  /** Stable key, used in `expands_from` and in assumption ids. */
  intent: string;
  /** Surface forms, already normalized the way normalize.ts normalizes input. */
  forms: readonly string[];
  expansion: readonly ExpansionStep[];
}

const READ = (sub_kind: SubKind): ExpansionStep => ({ type: 'READ', sub_kind });
const WRITE = (sub_kind: SubKind, ratio_hint?: ExpansionStep['ratio_hint']): ExpansionStep =>
  ratio_hint ? { type: 'WRITE', sub_kind, ratio_hint } : { type: 'WRITE', sub_kind };
const EDIT = (sub_kind: SubKind): ExpansionStep => ({ type: 'EDIT', sub_kind });

/**
 * Arabic forms are written as they come OUT of `normalizeArabic` — prefixes and
 * tashkeel stripped, ة→ه, ى→ي. Storing surface forms here and normalizing only the
 * input would mean the two sides never meet: §A4.4.3 says to "match against a
 * normalized-root lexicon, not surface forms".
 */
export const LEXICON: readonly LexiconEntry[] = [
  /* ── compound: the two §A4.4.3 calls out by name ────────────────────────── */
  {
    intent: 'translate',
    forms: ['translate', 'translation', 'ترجم', 'ترجمه', '翻译'],
    expansion: [
      READ('context_ingestion'),
      WRITE('completion', 'OUTPUT_APPROX_EQUALS_INPUT'),
    ],
  },
  {
    intent: 'summarize',
    forms: ['summarize', 'summarise', 'summary', 'tldr', 'لخص', 'تلخيص', 'موجز', '总结', '摘要'],
    expansion: [
      READ('context_ingestion'),
      WRITE('completion', 'OUTPUT_MUCH_SMALLER_THAN_INPUT'),
    ],
  },
  // §A4.4.3 leaves these three as `/* READ + WRITE */` stubs. Findings are output.
  {
    intent: 'review',
    forms: ['review', 'critique', 'راجع', 'مراجعه', '审阅', '评审'],
    expansion: [READ('context_ingestion'), WRITE('completion', 'OUTPUT_MUCH_SMALLER_THAN_INPUT')],
  },
  {
    intent: 'audit',
    forms: ['audit', 'دقق', 'تدقيق', '审计'],
    expansion: [READ('context_ingestion'), WRITE('completion', 'OUTPUT_MUCH_SMALLER_THAN_INPUT')],
  },
  {
    intent: 'compare',
    forms: ['compare', 'قارن', 'مقارنه', '对比', '比较'],
    // "READ × n sources + WRITE" — the n is the volume the quantity extractor finds.
    expansion: [READ('context_ingestion'), WRITE('completion', 'OUTPUT_MUCH_SMALLER_THAN_INPUT')],
  },

  /* ── READ ───────────────────────────────────────────────────────────────── */
  {
    intent: 'ingest',
    // ⚠️ `extract` was missing in English while its Arabic (استخرج) and Chinese (提取)
    // counterparts were present. An English "extract the clauses from the contract"
    // matched nothing, so the contract's READ never entered the workflow and its
    // whole input side vanished from the estimate — a silent undercount of the same
    // shape as the two misclassifications §A4.4.3 names. Found by a cross-language
    // audit of this table, which also flagged `analyze` (Arabic حلل is here, English
    // is not). `analyze` is NOT added here on purpose: "analyze this image" belongs
    // to `analyze_image`, and widening `ingest` would route it to text ingestion.
    // Recorded as a finding rather than papered over.
    forms: ['upload', 'read', 'ingest', 'parse', 'extract', 'extraction',
            'ارفع', 'حمل', 'اقرا', 'حلل', 'استخرج',
            '上传', '读取', '阅读', '解析', '提取'],
    expansion: [READ('context_ingestion')],
  },
  {
    intent: 'ocr',
    forms: ['ocr', 'scan', 'افحص', 'مسح', '扫描'],
    expansion: [READ('vision_ocr')],
  },
  {
    intent: 'classify',
    forms: ['classify', 'categorize', 'categorise', 'صنف', 'تصنيف', '分类'],
    expansion: [READ('context_ingestion')],
  },
  {
    intent: 'analyze_image',
    forms: ['describe', 'caption', 'صف', '描述'],
    expansion: [READ('image_analysis')],
  },

  /* ── WRITE ──────────────────────────────────────────────────────────────── */
  {
    intent: 'write',
    forms: ['write', 'draft', 'compose', 'generate text', 'اكتب', 'صغ', 'انشئ', 'ولد',
            '写', '撰写', '起草'],
    expansion: [WRITE('completion')],
  },
  {
    intent: 'brainstorm',
    forms: ['brainstorm', 'outline', 'اقترح', 'خطط', '头脑风暴'],
    expansion: [WRITE('creative_draft')],
  },
  {
    intent: 'expand',
    forms: ['expand', 'وسع', '扩写'],
    expansion: [READ('context_ingestion'), WRITE('completion', 'OUTPUT_APPROX_EQUALS_INPUT')],
  },

  /* ── EDIT ───────────────────────────────────────────────────────────────── */
  {
    intent: 'rewrite',
    forms: ['rewrite', 'refine', 'polish', 'fix', 'عدل', 'اصلح', 'نقح', 'حسن',
            '修改', '修复', '改写', '润色'],
    expansion: [READ('context_ingestion'), EDIT('text_rewrite')],
  },
  {
    intent: 'image_generate',
    forms: ['generate an image', 'generate image', 'create an image', 'make an image',
            'featured image', 'ولد صوره', 'انشئ صوره', '生成图片', '配图'],
    expansion: [EDIT('image_generate')],
  },
  {
    intent: 'inpaint',
    forms: ['inpaint', 'retouch', '重绘'],
    expansion: [EDIT('inpaint')],
  },
  {
    intent: 'upscale',
    forms: ['upscale', 'كبر', '放大'],
    expansion: [EDIT('upscale')],
  },
];

/* ═══════════════════════ negation ═══════════════════════ */

/**
 * §A4.4.3 — "A bare keyword matcher scores a `summarize` hit inside a negation."
 *
 * "don't summarize, just extract" / "لا تلخّص" / "不要总结". The window is short
 * and precedes the verb, because that is where negation sits in all three
 * languages; a whole-sentence scan would suppress the verb in "extract it, don't
 * bother with formatting", which negates something else entirely.
 */
const NEGATORS: readonly string[] = [
  "don't", 'dont', 'do not', 'never', 'without', 'no need to', 'skip', 'rather than',
  'instead of', 'لا ', 'بدون', 'ليس', 'دون',
  '不要', '不用', '别', '无需', '而不是',
];

/**
 * Words whose job is to close a negation and open a positive alternative. A window
 * alone cannot tell "don't summarize, just extract" (extract is REQUESTED, 17 chars
 * after the negator) from "don't summarize or extract" (extract is negated, at a
 * similar distance). Distance is the same in both; the contrast marker is the
 * difference, and it is the only signal in the sentence that carries it.
 *
 * Getting this wrong is not symmetric. Suppressing a verb that was actually
 * requested deletes its task from the workflow and its tokens from the estimate —
 * the undercount §A4.4.3 is written to prevent. Keeping a verb that was negated
 * overcounts, which is visible in the output and editable by the user.
 */
const CONTRAST_MARKERS: readonly string[] = [
  'just ', 'only ', 'but ', 'instead ', 'rather ', 'simply ',
  'فقط', 'بل ', 'انما', 'إنما',
  '只', '仅', '而是',
];

/** Characters of lookbehind. Wide enough for "please don't", short enough to be local. */
export const NEGATION_WINDOW = 24;

export function isNegated(haystack: string, matchIndex: number): boolean {
  const from = Math.max(0, matchIndex - NEGATION_WINDOW);
  const window = haystack.slice(from, matchIndex);
  // Latest negator in the window, not the first: "don't X, and don't Y" and
  // "don't X, just Y" differ only in what follows the LAST negator before the verb.
  let negEnd = -1;
  for (const n of NEGATORS) {
    const i = window.lastIndexOf(n);
    if (i >= 0 && i + n.length > negEnd) negEnd = i + n.length;
  }
  if (negEnd < 0) return false;
  // ⚠️ Scan from the END of the negator, never its start. Two negators contain a
  // contrast marker inside themselves — "rather than" contains "rather ", "instead
  // of" contains "instead " — so a scan that included the negator's own text would
  // let those two cancel their own negation and re-admit the verb they suppress.
  const between = window.slice(negEnd);
  return !CONTRAST_MARKERS.some((c) => between.includes(c));
}

/* ═══════════════════════ matching ═══════════════════════ */

export interface LexiconHit {
  entry: LexiconEntry;
  /** Where the surface form was found, in the normalized string. */
  index: number;
  form: string;
  negated: boolean;
}

/**
 * Longest-match, left to right.
 *
 * §A4.4.2 requires longest-match segmentation for Chinese ("rather than
 * character-by-character"), and it is equally necessary in English: matching
 * `write` before `rewrite` would classify an EDIT as a WRITE and drop the READ half.
 * Sorting the forms by length and consuming the matched span does both at once.
 */
export function matchIntents(normalized: string): LexiconHit[] {
  const forms: Array<{ entry: LexiconEntry; form: string }> = [];
  for (const entry of LEXICON) for (const form of entry.forms) forms.push({ entry, form });
  forms.sort((a, b) => b.form.length - a.form.length);

  const hits: LexiconHit[] = [];
  const consumed: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => consumed.some(([a, b]) => s < b && e > a);

  for (const { entry, form } of forms) {
    let from = 0;
    for (;;) {
      const i = normalized.indexOf(form, from);
      if (i === -1) break;
      const end = i + form.length;
      if (!overlaps(i, end)) {
        consumed.push([i, end]);
        hits.push({ entry, index: i, form, negated: isNegated(normalized, i) });
      }
      from = end;
    }
  }

  return hits.sort((a, b) => a.index - b.index);
}
