// /packages/parser/src/quantities.ts
//
// §A4.4.3 — volume, conditionals, and the measure words that carry a count.
//
// "Missing iteration language is the most common cause of a 100× underestimate."
// That is the whole reason this file is separate and tested on its own: a workflow
// costed at volume 1 when the user said "for each of the 500 contracts" is not
// slightly wrong, it is wrong by the volume.
//
// Every function here runs on the NORMALIZED string, which means the numerals have
// already been westernized (§A4.4.2). Running them on raw text would see no digits
// in an Arabic or Chinese prompt at all.

/* ═══════════════════════ measure words ═══════════════════════ */

/**
 * §A4.4.2 — "Watch measure words: 份 篇 张 个 页 条 immediately follow a count and
 * are your strongest quantity signal."
 *
 * Strongest because they are unambiguous: a bare number in Chinese can be a date, a
 * version or a price, but `5份` is five of something countable.
 */
const ZH_MEASURE = '份篇张个页条本册项';

/** Arabic and English plural/iteration markers, on the normalized forms. */
const ITERATION_MARKERS: readonly string[] = [
  'for each', 'each of', 'every', 'per ', 'batch of', 'all of the', 'all the',
  'لكل', 'كل ', 'جميع',
  '每个', '每一', '所有', '批量',
];

export interface VolumeResult {
  volume: number;
  /** How it was established. `DEFAULT_SINGLE` is the only one that is a guess. */
  basis: 'EXPLICIT_COUNT' | 'MEASURE_WORD' | 'ITERATION_BARE_PLURAL' | 'DEFAULT_SINGLE';
  /** The text that produced it, for the assumption trail. */
  evidence: string | null;
}

/**
 * The count this workflow repeats over.
 *
 * Ordered by how load-bearing the signal is. A measure word beats a bare number
 * because it proves the number is a count; an explicit count beats a bare plural
 * because "the contracts" tells you there are several and not how many.
 */
export function extractVolume(normalized: string): VolumeResult {
  // 1. Chinese measure word: 5份, 20页
  const measure = new RegExp(`(\\d+)\\s*[${ZH_MEASURE}]`).exec(normalized);
  if (measure) {
    return { volume: Number(measure[1]), basis: 'MEASURE_WORD', evidence: measure[0] };
  }

  // 2. An explicit count attached to iteration language, in any of the three.
  //    "each of the 40 documents", "لكل 40", "每个 40"
  const iterCount =
    /(?:for each|each of|every|batch of|all of the|all the|لكل|كل|جميع|每个|所有|批量)[^\d]{0,12}(\d+)/.exec(
      normalized,
    ) ?? /(\d+)\s*(?:documents?|files?|contracts?|pages?|images?|records?|rows?|عقود|عقد|ملفات|صفحات|صور)/.exec(
      normalized,
    );
  if (iterCount) {
    return { volume: Number(iterCount[1]), basis: 'EXPLICIT_COUNT', evidence: iterCount[0] };
  }

  // 3. Iteration language with no number. Real, and unquantified — the volume is
  //    unknown, NOT one. Returning 1 here would be the 100× underestimate. The
  //    caller turns this into a missing_data entry rather than a silent default.
  const marker = ITERATION_MARKERS.find((m) => normalized.includes(m));
  if (marker) {
    return { volume: 1, basis: 'ITERATION_BARE_PLURAL', evidence: marker };
  }

  return { volume: 1, basis: 'DEFAULT_SINGLE', evidence: null };
}

/** True when iteration was stated but no count was found — a question, not a guess. */
export const volumeIsUnquantified = (v: VolumeResult): boolean =>
  v.basis === 'ITERATION_BARE_PLURAL';

/* ═══════════════════════ conditionals ═══════════════════════ */

/**
 * §A4.4.3 — "'summarize it IF it's over 10 pages' is a probabilistic branch. Record
 * `execution_probability` on the task and multiply the volume; do not treat it as
 * certain."
 *
 * ⚠️ The probability itself is NOT inferable from the sentence. "if it's over 10
 * pages" could be almost always or almost never depending on the corpus, and
 * nothing in the text says which. So this reports THAT the branch exists and leaves
 * the number to the defaults engine, which labels it an assumption. Picking 0.5
 * here and calling it parsed would be inventing a quantity and hiding it as a
 * measurement.
 */
const CONDITIONAL_MARKERS: readonly string[] = [
  ' if ', 'only if', 'when ', 'in case', 'should it',
  'اذا', 'إن ', 'في حال', 'عندما',
  '如果', '若', '当', '要是',
];

export interface ConditionalResult {
  is_conditional: boolean;
  marker: string | null;
}

export function detectConditional(normalized: string): ConditionalResult {
  const marker = CONDITIONAL_MARKERS.find((m) => normalized.includes(m)) ?? null;
  return { is_conditional: marker !== null, marker };
}

/* ═══════════════════════ document class ═══════════════════════ */

/**
 * §A4.4.4's seed table is keyed on these. The trigger phrases are the spec's own.
 *
 * This picks the CLASS, not the token count. The count is the defaults engine's
 * job, and it arrives from `defaults_seed` tagged SEED_UNCALIBRATED — never from a
 * constant in this file.
 */
export type DocClass = 'short_form' | 'medium_form' | 'long_form' | 'image_unspecified';

const CLASS_TRIGGERS: ReadonlyArray<[DocClass, readonly string[]]> = [
  ['long_form', ['book', 'contract', 'multi-page', 'multipage', 'pdf', 'agreement', 'thesis',
                 'عقد', 'كتاب', 'اتفاقيه', '合同', '书', '协议']],
  ['medium_form', ['article', 'essay', 'report', 'blog post', 'paper', 'whitepaper',
                   'مقال', 'تقرير', 'بحث', '文章', '报告']],
  ['short_form', ['tweet', 'email', 'post', 'caption', 'sms', 'headline', 'subject line',
                  'تغريده', 'منشور', 'بريد', '推文', '帖子']],
  ['image_unspecified', ['image', 'picture', 'photo', 'graphic', 'صوره', '图片', '配图']],
];

/**
 * Longest trigger wins, and long_form is checked first.
 *
 * The order matters: "multi-page PDF report" contains both a long_form and a
 * medium_form trigger, and the seed input differs by 12.5× between them
 * (25,000 vs 2,000). Preferring the larger class means an unresolved overlap
 * over-quotes rather than under-quotes — the safe direction for a quote, and the
 * overlap is reported so the user can correct it.
 */
export function classifyDocument(normalized: string): { doc_class: DocClass | null; trigger: string | null; ambiguous_with: DocClass[] } {
  const found: Array<[DocClass, string]> = [];
  for (const [cls, triggers] of CLASS_TRIGGERS) {
    for (const t of triggers) if (normalized.includes(t)) found.push([cls, t]);
  }
  if (found.length === 0) return { doc_class: null, trigger: null, ambiguous_with: [] };

  const textClasses = found.filter(([c]) => c !== 'image_unspecified');
  const pick = (textClasses.length > 0 ? textClasses : found)[0]!;
  const others = [...new Set(found.map(([c]) => c))].filter((c) => c !== pick[0]);
  return { doc_class: pick[0], trigger: pick[1], ambiguous_with: others };
}

/* ═══════════════════════ scanned vs text-layer ═══════════════════════ */

/**
 * §A4.4.7 — "Upload a Chinese contract PDF" is two completely different cost
 * models and the sentence does not say which.
 *
 * Text-layer PDF is §A5.1 on text tokens. A scan is §A5.2 vision geometry ONCE PER
 * PAGE, and the magnitude "can be far higher, and scales with page count".
 *
 * "The parser must not choose silently... no default is defensible across a gap
 * this size." So this returns UNKNOWN unless the text names it, and UNKNOWN becomes
 * a BLOCKING missing_data entry, not a default.
 */
export type PdfKind = 'TEXT_LAYER' | 'SCANNED' | 'UNKNOWN';

export function detectPdfKind(normalized: string): PdfKind {
  if (/scanned|scan of|photocopy|photographed|ممسوح|مصور|扫描件|扫描版/.test(normalized)) {
    return 'SCANNED';
  }
  if (/searchable|text layer|text-layer|digital pdf|نص|文字版|可搜索/.test(normalized)) {
    return 'TEXT_LAYER';
  }
  return 'UNKNOWN';
}

/** Does the request involve a PDF or document at all? Gates the question above. */
export const mentionsDocument = (normalized: string): boolean =>
  /pdf|document|docx|contract|report|file|وثيقه|مستند|عقد|ملف|文件|文档|合同/.test(normalized);
