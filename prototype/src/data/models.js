export const MODELS = [
  // ---------- OpenAI ----------
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    provider: 'OpenAI',
    tokenizer: 'o200k',
    input: 10,
    output: 50,
    cachedInput: 1,
    cacheWriteInput: 12.5,
    longInput: 20,
    longOutput: 75,
    longThreshold: 128000,
    vision: 'gpt5',
    reasoning: true,
    note: 'Long-context window (>128K) bills at 2x input / 1.5x output for the whole request.',
    quality: 5,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    provider: 'OpenAI',
    tokenizer: 'o200k',
    input: 4,
    output: 20,
    cachedInput: 0.4,
    longInput: 8,
    longOutput: 30,
    longThreshold: 128000,
    vision: 'gpt5',
    reasoning: true,
    note: 'Promotional rate through at least Nov 21, 2026.',
    quality: 5,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    provider: 'OpenAI',
    tokenizer: 'o200k',
    input: 2,
    output: 12,
    cachedInput: 0.2,
    longInput: 4,
    longOutput: 18,
    longThreshold: 128000,
    vision: 'gpt5',
    reasoning: true,
    quality: 4,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    provider: 'OpenAI',
    tokenizer: 'o200k',
    input: 0.2,
    output: 1.2,
    cachedInput: 0.02,
    longInput: 0.4,
    longOutput: 1.8,
    longThreshold: 128000,
    vision: 'gpt5',
    reasoning: true,
    quality: 3,
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o (legacy)',
    provider: 'OpenAI',
    tokenizer: 'o200k',
    input: 2.5,
    output: 10,
    cachedInput: 1.25,
    vision: 'tile',
    visionCfg: { maxEdge: 2048, shortSideTarget: 768, tile: 512, base: 85, perTile: 170, lowTokens: 85 },
    quality: 4,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini (legacy)',
    provider: 'OpenAI',
    tokenizer: 'o200k',
    input: 0.15,
    output: 0.6,
    cachedInput: 0.075,
    vision: 'tile',
    visionCfg: { maxEdge: 2048, shortSideTarget: 768, tile: 512, base: 85, perTile: 170, lowTokens: 85, cap: 2833 },
    quality: 2,
  },
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1 (legacy)',
    provider: 'OpenAI',
    tokenizer: 'cl100k',
    input: 2,
    output: 8,
    cachedInput: 0.5,
    vision: 'tile',
    visionCfg: { maxEdge: 2048, shortSideTarget: 768, tile: 512, base: 85, perTile: 170, lowTokens: 85 },
    quality: 4,
  },

  // ---------- Anthropic ----------
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    provider: 'Anthropic',
    tokenizer: 'claude',
    input: 10,
    output: 50,
    cachedInput: 1,
    vision: 'claude',
    visionTier: 'high',
    newTokenizer: true,
    quality: 5,
  },
  {
    id: 'claude-mythos-5',
    name: 'Claude Mythos 5',
    provider: 'Anthropic',
    tokenizer: 'claude',
    input: 10,
    output: 50,
    cachedInput: 1,
    vision: 'claude',
    visionTier: 'high',
    newTokenizer: true,
    quality: 5,
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'Anthropic',
    tokenizer: 'claude',
    input: 5,
    output: 25,
    cachedInput: 0.5,
    vision: 'claude',
    visionTier: 'high',
    newTokenizer: true,
    quality: 5,
  },
  {
    id: 'claude-opus-4.8',
    name: 'Claude Opus 4.8',
    provider: 'Anthropic',
    tokenizer: 'claude',
    input: 5,
    output: 25,
    cachedInput: 0.5,
    vision: 'claude',
    visionTier: 'high',
    newTokenizer: true,
    quality: 5,
  },
  {
    id: 'claude-opus-4.7',
    name: 'Claude Opus 4.7',
    provider: 'Anthropic',
    tokenizer: 'claude',
    input: 5,
    output: 25,
    cachedInput: 0.5,
    vision: 'claude',
    visionTier: 'high',
    newTokenizer: true,
    quality: 4,
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'Anthropic',
    tokenizer: 'claude',
    input: 2,
    output: 10,
    cachedInput: 0.2,
    vision: 'claude',
    visionTier: 'high',
    newTokenizer: true,
    quality: 4,
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    tokenizer: 'claude',
    input: 3,
    output: 15,
    cachedInput: 0.3,
    vision: 'claude',
    visionTier: 'standard',
    quality: 4,
  },
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'Anthropic',
    tokenizer: 'claude',
    input: 3,
    output: 15,
    cachedInput: 0.3,
    vision: 'claude',
    visionTier: 'standard',
    quality: 3,
  },
  {
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    tokenizer: 'claude',
    input: 1,
    output: 5,
    cachedInput: 0.1,
    vision: 'claude',
    visionTier: 'standard',
    quality: 2,
  },

  // ---------- Open models (approximate) ----------
  {
    id: 'open-llama3.1-8b',
    name: 'Llama 3.1 8B (open)',
    provider: 'Open',
    tokenizer: 'llama',
    input: 0.05,
    output: 0.05,
    cachedInput: 0.05,
    approx: true,
    note: 'Tokenizer = Llama 3; rough price midpoint across open providers.',
    quality: 2,
  },
  {
    id: 'open-llama3.1-70b',
    name: 'Llama 3.1 70B / DeepSeek R1 (open, approx)',
    provider: 'Open',
    tokenizer: 'llama',
    input: 0.6,
    output: 2.5,
    cachedInput: 0.6,
    approx: true,
    note: 'Uses the Llama 3 tokenizer as an approximation for DeepSeek R1/V3.',
    quality: 3,
  },
  {
    id: 'open-mistral',
    name: 'Mistral small / medium (open, approx)',
    provider: 'Open',
    tokenizer: 'llama',
    input: 0.2,
    output: 0.6,
    cachedInput: 0.2,
    approx: true,
    note: 'Llama 3 tokenizer stands in for Mistral v0.x (close but not identical).',
    quality: 2,
  },
];

export function getModel(id) {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export const GEN_MODELS = [
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    input: 5,
    imageInput: 8,
    imageOutput: 30,
    cachedInput: 1.25,
    perImage: {
      low: { square: 0.006, wide: 0.005 },
      medium: { square: 0.053, wide: 0.041 },
      high: { square: 0.211, wide: 0.165 },
    },
    quality: 4,
  },
  {
    id: 'gpt-image-1.5',
    name: 'GPT Image 1.5',
    input: 5,
    imageInput: 8,
    imageOutput: 32,
    cachedInput: 1.25,
    perImage: {
      low: { square: 0.009, wide: 0.0135 },
      medium: { square: 0.034, wide: 0.051 },
      high: { square: 0.133, wide: 0.2 },
    },
    quality: 4,
  },
  {
    id: 'gpt-image-1',
    name: 'GPT Image 1 (retires Oct 2026)',
    input: 5,
    imageInput: 10,
    imageOutput: 40,
    cachedInput: 1.25,
    perImage: {
      low: { square: 0.011, wide: 0.016 },
      medium: { square: 0.042, wide: 0.063 },
      high: { square: 0.167, wide: 0.25 },
    },
    quality: 3,
  },
  {
    id: 'gpt-image-1-mini',
    name: 'GPT Image 1 Mini (retires Dec 2026)',
    input: 2,
    imageInput: 2.5,
    imageOutput: 8,
    cachedInput: 0.5,
    perImage: {
      low: { square: 0.005, wide: 0.0075 },
      medium: { square: 0.011, wide: 0.0165 },
      high: { square: 0.036, wide: 0.052 },
    },
    quality: 2,
  },
];

export const IMAGE_INPUT_TILE = {
  tile: 512,
  base: 65,
  perTile: 129,
  lowTokens: 65,
  shortSideTarget: 512,
  maxEdge: 2048,
};

export const CLAUDE_TOKENIZER_MULTIPLIER = 1.3;

// Signed model-card architecture for the self-hosted VRAM feasibility gate.
// Missing rows → the gate returns UNAVAILABLE, never a guessed number.
export const OPEN_ARCH = {
  'open-llama3.1-8b': { paramsB: 8, layers: 32, kvHeads: 8, headDim: 128 },
  'open-llama3.1-70b': { paramsB: 70, layers: 80, kvHeads: 8, headDim: 128 },
  'open-mistral': { paramsB: 7, layers: 32, kvHeads: 8, headDim: 128 },
};

export const QUANTIZATION = {
  fp16: { bytes: 2, label: 'FP16 (native)' },
  bf16: { bytes: 2, label: 'BF16 (native)' },
  fp8: { bytes: 1, label: 'FP8 dynamic' },
  int8: { bytes: 1, label: 'INT8 (AWQ/GPTQ)' },
  int4: { bytes: 0.5, label: 'INT4 (AWQ/GGUF)' },
};

// Task / language profile → estimated tokens per word for output-length planning.
export const TEXT_PROFILES = {
  prose: { label: 'English prose / creative writing', tokensPerWord: 1.3 },
  code: { label: 'Code', tokensPerWord: 1.7 },
  json: { label: 'Structured JSON / tool schemas', tokensPerWord: 1.6 },
  multilingual: { label: 'Non-English / multilingual text', tokensPerWord: 2.0 },
};

// ---- curated price overlay (generated by scripts/refresh-rates.mjs) ----
import { PRICE_OVERLAYS, PRICE_META } from './rates.generated.js';
export { PRICE_META };

function applyRates(arr, overlay) {
  if (!overlay) return;
  for (const rec of overlay) {
    const m = arr.find((x) => x.id === rec.id);
    if (!m) continue;
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'id' || v == null) continue;
      m[k] = v;
    }
  }
}

applyRates(MODELS, PRICE_OVERLAYS.chat);
applyRates(GEN_MODELS, PRICE_OVERLAYS.gen);