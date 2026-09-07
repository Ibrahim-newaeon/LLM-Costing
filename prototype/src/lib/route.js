import { countTokensByTokenizer } from './text.js';

// Recommendation engine: given the current task shape, ranks candidate models
// and picks Option A (cheapest) and Option B (best performance).
// The task shape is tokenizer-independent text counts so every model is priced
// with its own matching tokenizer (shared-dimensions matrix, row 1).

const APPROX_TAG = (m) => (m.approx ? ' (approx)' : '');

export async function countAllTokenizers(textOnly) {
  const entries = [
    ['o200k', 'o200k'],
    ['cl100k', 'cl100k'],
    ['claude', 'claude'],
    ['llama', 'llama'],
  ];
  const out = {};
  await Promise.all(
    entries.map(async ([key, tokenizer]) => {
      out[key] = textOnly.trim().length ? countTokensByTokenizer(tokenizer, textOnly) : 0;
    }),
  );
  return out;
}

export function rateFor(model, inputTokens, outputTokens, cached) {
  const inputRate = ((cached ? model.cachedInput : model.input) ?? model.input) / 1e6;
  const outputRate = (model.output ?? 0) / 1e6;
  return inputTokens * inputRate + outputTokens * outputRate;
}

function qualityScore(m) {
  return m.quality ?? 1;
}

export function recommendModels(models, { counts, outputTokens, imageTokens, needsVision, cached }) {
  const candidates = models
    .map((m) => {
      if (needsVision && !m.vision) return null;
      const mult = m.newTokenizer ? 1.3 : 1;
      const inputTokens = Math.round((counts[m.tokenizer] ?? 0) * mult) + (m.vision ? imageTokens : 0);
      const cost = rateFor(m, inputTokens, outputTokens, cached);
      return {
        model: m,
        inputTokens,
        outputTokens,
        cost,
        quality: qualityScore(m),
        rate: cached ? m.cachedInput : m.input,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.cost - b.cost);

  if (candidates.length === 0) return { rows: [], cheapest: null, best: null };

  const cheapest = candidates[0];
  const best = [...candidates].sort((a, b) => b.quality - a.quality || a.cost - b.cost)[0];
  return {
    rows: candidates,
    cheapest,
    best,
    needsVision,
    rationale: {
      A: {
        triggering_metric: 'cost',
        observed_value: cheapest.cost,
        threshold: 'lowest total among capability-valid candidates',
        evidence_ref: `rate: models.js#${cheapest.model.id}`,
      },
      B: {
        triggering_metric: 'quality (cost tiebreak)',
        observed_value: `quality ${best.quality}`,
        threshold: 'highest quality among capability-valid candidates',
        evidence_ref: `registry: models.js#${best.model.id}`,
      },
    },
  };
}

export function modelHeadsUp(m) {
  return `${m.name}${APPROX_TAG(m)}`;
}

export const QUALITY_STARS = (q) => '★'.repeat(Math.max(1, Math.min(5, q ?? 1)));