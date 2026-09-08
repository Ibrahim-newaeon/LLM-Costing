// /packages/parser/src/normalize.ts
//
// §A4.4.2 — "Normalize before you match (this is where Arabic and Chinese break)".
//
// A lexicon lookup against raw user text works for English and fails for the other
// two. Everything here runs BEFORE any matching or quantity extraction.
//
// ⚠️ The single most expensive line in this file is the numeral conversion, and
// §A4.4.2 says why: "a quantity regex that only matches [0-9] silently drops every
// number in an Arabic prompt, and a dropped quantity becomes a default, which
// becomes a wrong estimate". The failure is silent twice over — the number vanishes,
// and then a plausible default takes its place. `٥٠٠ عقد` becomes one contract.

import type { ScriptFamily } from '@tokenomics/contracts';

/* ═══════════════════════ numerals ═══════════════════════ */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹'; // Persian/Urdu forms, seen in Gulf input

/** Arabic-Indic → Western. Runs before every quantity regex, without exception. */
export function westernizeArabicNumerals(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => {
    const a = ARABIC_INDIC.indexOf(d);
    if (a !== -1) return String(a);
    return String(EASTERN_ARABIC_INDIC.indexOf(d));
  });
}

const ZH_DIGIT: Readonly<Record<string, number>> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};
const ZH_UNIT: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000, 万: 10_000 };

/**
 * Chinese numerals → Western. `五份合同` is five contracts, and a `[0-9]+` regex
 * sees zero.
 *
 * Handles the compositional forms that actually appear in a count — 十五, 二十,
 * 三百, 两千 — rather than only bare digits. `两` is included because it is the
 * counting form of 2 and is what a native speaker writes before a measure word.
 */
export function westernizeChineseNumerals(text: string): string {
  return text.replace(/[〇零一二两三四五六七八九十百千万]+/g, (run) => {
    const n = parseChineseNumber(run);
    return n === null ? run : String(n);
  });
}

function parseChineseNumber(s: string): number | null {
  let total = 0;
  let current = 0;
  let sawAny = false;

  for (const ch of s) {
    if (ch in ZH_DIGIT) {
      current = ZH_DIGIT[ch]!;
      sawAny = true;
      continue;
    }
    const unit = ZH_UNIT[ch];
    if (unit === undefined) return null;
    sawAny = true;
    if (unit === 10_000) {
      total = (total + (current || 1)) * unit;
      current = 0;
    } else {
      // 十五 = 15: a bare 十 with no preceding digit means one ten.
      total += (current || 1) * unit;
      current = 0;
    }
  }
  const n = total + current;
  return sawAny ? n : null;
}

/* ═══════════════════════ Arabic ═══════════════════════ */

/** Tashkeel and the superscript alef. Stripped for MATCHING only — see below. */
const TASHKEEL = /[ً-ْٰـ]/g;

/**
 * §A4.4.2's six steps, in order.
 *
 * ⚠️ This is a MATCHING transform, not a measurement one. §A4.4.5: "Tashkeel is
 * billable" — a vocalized text carries a diacritic on nearly every consonant and
 * most tokenizers bill them. So the normalized string is for lexicon lookup, and
 * `diacritic_density` is measured on the ORIGINAL. Counting characters on this
 * output would undercount a vocalized Arabic document by the diacritics.
 */
export function normalizeArabic(text: string): string {
  let t = westernizeArabicNumerals(text);
  t = t.replace(TASHKEEL, '');
  t = t.replace(/[أإآٱ]/g, 'ا');
  t = t.replace(/ى/g, 'ي');
  t = t.replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  // Conjunctive and definite prefixes. Applied to word starts only — stripping
  // these mid-word would maul roots that legitimately contain them.
  t = t.replace(/(^|\s)(?:ولل|فال|بال|كال|وال|ال|و|ف|ب|ك)(?=\S{3,})/g, '$1');
  // Pronominal suffixes, likewise only at word ends and only where a root remains.
  t = t.replace(/(\S{3,})(?:ها|هم|هن|كم|نا|ني|ه|ك)(?=\s|$)/g, '$1');
  // ⚠️ ORDER: ta-marbuta folds LAST, after suffix stripping, and the order is the
  // whole point. Folding ة→ه first turns every feminine noun into a word that ends
  // in ه — indistinguishable from the 3ms pronominal suffix — and the suffix rule
  // above then eats it: مراجعة → مراجعه → مراجع. The stem loses its final letter,
  // stops matching the lexicon, and the verb it carried disappears from the parse.
  // Stripping first is safe because a real suffix never attaches to a bare ة.
  t = t.replace(/ة/g, 'ه');
  return t;
}

/**
 * §A4.4.5 — "Vocalization is a spectrum, not a boolean."
 *
 * Diacritics per consonant, measured on the raw text. The calibration table is
 * keyed on this; a true/false flag "forces that continuous variable into one of two
 * extremes, mispricing whichever end it snaps to".
 */
export function diacriticDensity(text: string): number {
  const consonants = (text.match(/[ء-غف-ي]/g) ?? []).length;
  if (consonants === 0) return 0;
  const marks = (text.match(/[ً-ْٰ]/g) ?? []).length;
  return marks / consonants;
}

/* ═══════════════════════ Chinese ═══════════════════════ */

/**
 * The Traditional→Simplified pairs that appear in the §A4.4.3 lexicon and in
 * document vocabulary.
 *
 * Deliberately NOT a general T→S table: a complete one is a data asset with its own
 * provenance, and a half-complete one that looks general is worse than a short one
 * that admits its scope. `traditionalCoverage()` reports what fell outside it.
 */
const T2S: Readonly<Record<string, string>> = {
  上傳: '上传', 讀取: '读取', 閱讀: '阅读', 分析: '分析', 掃描: '扫描',
  提取: '提取', 解析: '解析', 分類: '分类', 對比: '对比',
  寫: '写', 撰寫: '撰写', 起草: '起草', 生成: '生成', 創建: '创建', 擴寫: '扩写',
  修改: '修改', 修復: '修复', 改寫: '改写', 更新: '更新', 潤色: '润色',
  重繪: '重绘', 放大: '放大', 翻譯: '翻译', 總結: '总结',
  合同: '合同', 報告: '报告', 文章: '文章', 圖片: '图片', 頁: '页', 張: '张', 條: '条',
};

export function simplify(text: string): string {
  let t = text;
  // Longest-first, so 撰寫 is not half-converted by a 寫 rule.
  for (const from of Object.keys(T2S).sort((a, b) => b.length - a.length)) {
    t = t.split(from).join(T2S[from]!);
  }
  return t;
}

/* ═══════════════════════ script mix ═══════════════════════ */

/**
 * §A4.4.2 — "detect script by Unicode range PROPORTIONS, not by a single label."
 *
 * "Gulf documents are routinely mixed: an Arabic contract with English legal terms,
 * Western numerals and a Chinese counterparty name." The tokenizer's behaviour
 * follows the mix, not the majority, so a single label throws away the thing that
 * decides the cost.
 *
 * Digits, punctuation and whitespace are excluded from the denominator: they are
 * script-neutral, and counting them would drag every mix toward `latin` in
 * proportion to how many numbers the document happens to contain.
 */
export function scriptMix(text: string): Partial<Record<ScriptFamily, number>> {
  const counts: Record<ScriptFamily, number> = {
    latin: 0, arabic: 0, han: 0, cyrillic: 0, other: 0,
  };
  let total = 0;

  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (/[\s\d\p{P}\p{S}]/u.test(ch)) continue;
    total += 1;
    if ((c >= 0x0041 && c <= 0x024f)) counts.latin += 1;
    else if (c >= 0x0600 && c <= 0x06ff) counts.arabic += 1;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) counts.han += 1;
    else if (c >= 0x0400 && c <= 0x04ff) counts.cyrillic += 1;
    else counts.other += 1;
  }

  if (total === 0) return {};
  const mix: Partial<Record<ScriptFamily, number>> = {};
  for (const [k, v] of Object.entries(counts) as [ScriptFamily, number][]) {
    if (v > 0) mix[k] = v / total;
  }
  return mix;
}

/** The family with the largest share, for lexicon selection only. */
export function dominantScript(mix: Partial<Record<ScriptFamily, number>>): ScriptFamily | null {
  const entries = Object.entries(mix) as [ScriptFamily, number][];
  if (entries.length === 0) return null;
  return entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

/* ═══════════════════════ the entry point ═══════════════════════ */

export interface Normalized {
  /** For lexicon matching. Lossy by design — never measure on this. */
  matchable: string;
  /** Untouched. Character counts and diacritic density are measured here. */
  original: string;
  script_mix: Partial<Record<ScriptFamily, number>>;
  dominant: ScriptFamily | null;
  diacritic_density: number;
}

export function normalize(text: string): Normalized {
  const mix = scriptMix(text);
  const dominant = dominantScript(mix);

  // Numerals are converted for EVERY script, not just the dominant one. A Gulf
  // prompt in English can carry Arabic-Indic digits, and an Arabic prompt can carry
  // Chinese ones for a Chinese counterparty's quantities. Keying the conversion off
  // the dominant script would reintroduce the exact silent drop this guards.
  let matchable = westernizeArabicNumerals(text);
  matchable = westernizeChineseNumerals(matchable);
  matchable = simplify(matchable);
  if ((mix.arabic ?? 0) > 0) matchable = normalizeArabic(matchable);

  return {
    matchable: matchable.toLowerCase(),
    original: text,
    script_mix: mix,
    dominant,
    diacritic_density: diacriticDensity(text),
  };
}
