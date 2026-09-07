// Regex-based intent parser: turns a natural-language task description into a
// concrete API workflow (list of steps with estimated token counts + volume).
// No LLM needed — everything is local heuristics for a static calculator.

const LENGTH_DEFAULTS = {
  long: {
    re: /(book|contract|thesis|dissertation|legal|regulation|policy|report|manual|document|multi-?page|ebook|pdf|whitepaper)/i,
    input: 25000,
    output: 2000,
    label: 'long-form (book / contract / PDF)',
  },
  medium: {
    re: /\b(article|essay|blog|newsletter|story|chapter|resume|cv|case study|guide|memo)\b/i,
    input: 2000,
    output: 800,
    label: 'medium-form (article / report)',
  },
  short: {
    re: /(tweet|email|e-?mail|comment|message|caption|headline|sms|brief)/i,
    input: 300,
    output: 200,
    label: 'short-form (tweet / email)',
  },
};

const LANGUAGE_RE = /(chinese|mandarin|中文|russian|arabic|hindi|japanese|korean|spanish|portuguese|french|german|italian|polish|turkish|bengali|urdu|thai|vietnamese)/i;
const VOLUME_RE = /(\d+)\s+(?:[\w-]+\s+)?(emails?|posts?|pages?|images?|photos?|pictures?|variations?|drafts?|tweets?|copies?|instances?|times|articles|documents)/i;
const IMAGE_MENTION_RE = /(image|photo|picture|screenshot|scan|thumbnail|png|jpe?g|illustration|artwork|banner|logo|poster|flyer|album cover|avatar|icon)/i;
const IMAGE_GEN_RE = /(featured image|cover image|banner|thumbnail|illustration|generate (an? )?(image|photo|picture|artwork)|create (an? )?(image|photo|picture|artwork)|image for|graphic)/i;
// Image-to-image: acting on an existing image (needs the source as reference input).
const IMAGE_EDIT_RE = /(edit (the|this|an) image|edit this|regenerate|regen\b|a new version|new version of|make an? (edited|variation|version)|edit(ed)? version|variant|variation|upscale|recolor|relight|redesign|redraw|redo|turn (it|this) into|change (the|it) (to|into)|add (a|an) )/i;
// Quality cue for image steps → output quality tier.
const IMAGE_HIGH_RE = /(upscale|hi-?res|high.?res|4k|8k|refined|detailed|polish)/i;

// Coding intent + stack detection: full coding prompts describe whole repos / screens.
const CODE_RE = /(code|implement|function|class|module|api|endpoint|refactor|debug|unit test|test suite|script|algorithm|sql|schema|database|frontend|backend|microservice|widget|component|regression|code review|compile|deploy|pipeline|build (out|the))|feature/i;
const STACK_RE = /\b(python|javascript|typescript|java|go|rust|sql|react|vue|angular|node|django|flask|fastapi|rails|spring|kubernetes|k8s|docker|terraform|aws|gcp|azure|bash|shell|powershell|graphql|postgresql|mysql|redis|c\+\+|c#)\b/i;

const ACTION = {
  write: /(draft|write|summar|compos|brainstorm|create|generate (text|copy|content|headlines)|outline|explain|expand|elaborat|paraphrase|translate|implement|code|build|develop|program|scaffold|write (code|function|class|tests?)|create (a )?(function|class|module|component|service|api))/i,
  edit: /(fix|rewrite|redraft|rephrase|edit|modify|update|revise|correct|reword|restructure|improve|proofread|regenerate|shorten|lengthen|refactor|debug|optim|migrat|trace|profile|annotat|document|upgrade|integrat|patching|hotfix|investigat|diagnos)/i,
  read: /(upload|read|analy|scan|review|extract|ingest|parse|evaluate|classif|check|audit|understand|categoriz|summari|translate|assess|triage|walk through)/i,
};

const SPLIT_RE = /(?<=[.!?])\s+|\s*;\s*|\s*,\s*|\s+(?:and|then|also)\s+/i;

export function parseTask(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { steps: [], calls: 0, volume: 1, language: 'english', length: null };

  const volumeMatch = raw.match(VOLUME_RE);
  const volume = volumeMatch ? Math.max(1, Number(volumeMatch[1])) : 1;
  const nonEnglish = LANGUAGE_RE.test(raw);

  const length = Object.values(LENGTH_DEFAULTS).find((l) => l.re.test(raw)) ??
    (CODE_RE.test(raw)
      ? { input: 4000, output: 1200, label: 'coding prompt (repo/screen scale)' }
      : { input: 500, output: 300, label: 'unspecified length' });
  // Non-English text (esp. CJK) packs more tokens per character: 1.5–2.5×.
  const factor = nonEnglish ? 2 : 1;

  const sentences = raw.split(SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  const steps = [];
  let cur = null;
  let imagePresent = false;

  for (const sentence of sentences) {
    const imgMention = IMAGE_MENTION_RE.test(sentence);
    // "regenerate it / make it into / a variation of this" after an image has
    // appeared = image-to-image edit; a fresh "generate an image" = text-to-image.
    const imgEdit =
      IMAGE_EDIT_RE.test(sentence) &&
      (imgMention || (/(it|this|those|them)/i.test(sentence) && imagePresent));
    const genImage = IMAGE_GEN_RE.test(sentence) || imgEdit;
    const kind = genImage
      ? 'image'
      : ACTION.write.test(sentence)
        ? 'write'
        : ACTION.edit.test(sentence)
          ? 'edit'
          : ACTION.read.test(sentence)
            ? 'read'
            : null;
    if (imgMention || kind === 'image') imagePresent = true;
    if (kind) {
      // A phrase led by "then / and / after / …" is a NEW logical call even if the
      // same action verb recurs ("implement the API, then write tests" = 2 calls,
      // while "write a summary and a conclusion" reads as one request).
      const newCall = /^(then|also|and|after|once|finally|next|first|second|third|so|meanwhile)\b/i.test(sentence);
      if (cur && cur.kind === kind && !newCall) {
        cur.raw += ' ' + sentence;
      } else {
        cur = { id: `s${steps.length + 1}`, kind, raw: sentence };
        steps.push(cur);
      }
    } else if (cur) {
      cur.raw += ' ' + sentence;
    } else {
      cur = { id: `s${steps.length + 1}`, kind: 'read', raw: sentence };
      steps.push(cur);
    }
  }

  const withDims = steps.map((step) => {
    const vision = step.kind !== 'image' && IMAGE_MENTION_RE.test(step.raw);
    const code = CODE_RE.test(step.raw);
    const stack = (STACK_RE.exec(step.raw) ?? [null])[0];
    let estInput = Math.round(length.input * factor);
    let estOutput = Math.round(length.output * factor);
    let costNote = length.label;
    let mode = 'gen';
    let quality = 'medium';
    if (step.kind === 'image') {
      estInput = Math.round(200 * factor);
      estOutput = 0;
      const editing = IMAGE_EDIT_RE.test(step.raw);
      mode = editing ? 'edit' : 'gen';
      quality = IMAGE_HIGH_RE.test(step.raw) ? 'high' : 'medium';
      costNote = editing
        ? 'image-to-image edit — the source image(s) bill as image-input + per-image output'
        : 'image generation (per image)';
    } else if (step.kind === 'edit') {
      estOutput = Math.max(200, Math.round(estOutput / 2));
      costNote = `${length.label} — edit keeps full context, output is the delta`;
    } else if (step.kind === 'read') {
      estOutput = Math.max(150, Math.round(estOutput / 2));
      costNote = `${length.label} — input carries the source`;
    }
    return {
      ...step,
      vision,
      code,
      stack,
      mode,
      quality,
      estInput,
      estOutput,
      note: costNote + (code && stack ? ` · stack ${stack}` : '') + (nonEnglish ? ' · non-English ×2' : ''),
    };
  });

  const calls = Math.max(1, withDims.length) * volume;

  return {
    steps: withDims,
    calls,
    volume,
    language: nonEnglish ? 'non-english' : 'english',
    length,
  };
}