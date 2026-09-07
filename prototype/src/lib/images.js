function scaleToFit(w, h, maxEdge) {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h };
  const f = maxEdge / long;
  return { width: Math.round(w * f), height: Math.round(h * f) };
}

export function openAIVisionTokens(w, h, detail, cfg) {
  if (detail === 'low') return cfg.lowTokens ?? cfg.base ?? 85;
  let { width, height } = scaleToFit(w, h, cfg.maxEdge ?? 2048);
  if (cfg.shortSideTarget && Math.min(width, height) > cfg.shortSideTarget) {
    const f = cfg.shortSideTarget / Math.min(width, height);
    width = Math.round(width * f);
    height = Math.round(height * f);
  }
  const tiles = Math.ceil(width / cfg.tile) * Math.ceil(height / cfg.tile);
  let tokens = (cfg.base ?? 85) + (cfg.perTile ?? 170) * tiles;
  if (cfg.cap && tokens > cfg.cap) tokens = cfg.cap;
  return tokens;
}

export function gpt5VisionTokens(w, h, detail = 'auto') {
  const cfg = detail === 'high'
    ? { budget: 2500, maxDim: 2048 }
    : { budget: 10000, maxDim: 6000 };
  const { width, height } = scaleToFit(w, h, cfg.maxDim);
  const tokens = Math.min(cfg.budget, Math.ceil((width * height) / 1024));
  return tokens;
}

const CLAUDE_TIERS = {
  standard: { maxLong: 1568, maxVisualTokens: 1568 },
  high: { maxLong: 2576, maxVisualTokens: 4784 },
};

export function claudeVisionTokens(w, h, tier = 'standard') {
  const { maxLong, maxVisualTokens } = CLAUDE_TIERS[tier] ?? CLAUDE_TIERS.standard;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const ratio = long / short;
  const rawLong = Math.ceil(long / 28);
  const rawShort = Math.ceil(short / 28);
  if (long <= maxLong && rawLong * rawShort <= maxVisualTokens) {
    return { tokens: rawLong * rawShort, width: w, height: h, scaled: false };
  }
  const countAt = (l2px) =>
    Math.ceil(l2px / 28) * Math.ceil((l2px / ratio) / 28);
  let lo = 1;
  let hi = Math.max(1, Math.min(long, maxLong));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (countAt(mid) <= maxVisualTokens) lo = mid;
    else hi = mid - 1;
  }
  const l2 = lo;
  const shortDone = Math.round(l2 / ratio);
  return {
    tokens: countAt(l2),
    width: ratio >= 1 ? l2 : shortDone,
    height: ratio >= 1 ? shortDone : l2,
    scaled: true,
  };
}