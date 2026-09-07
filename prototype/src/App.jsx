import { useEffect, useState } from 'react';
import {
  MODELS,
  GEN_MODELS,
  IMAGE_INPUT_TILE,
  CLAUDE_TOKENIZER_MULTIPLIER,
  TEXT_PROFILES,
  OPEN_ARCH,
  QUANTIZATION,
  getModel,
  PRICE_META,
} from './data/models.js';
import { countTokensByTokenizer } from './lib/text.js';
import { openAIVisionTokens, gpt5VisionTokens, claudeVisionTokens } from './lib/images.js';
import { parseTask } from './lib/task.js';
import { recommendModels, countAllTokenizers, QUALITY_STARS, modelHeadsUp } from './lib/route.js';

function useCount(fn, dep) {
  const [state, setState] = useState({ value: null, loading: true, error: null });
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          if (alive) setState({ value, loading: false, error: null });
        },
        (err) => {
          if (alive)
            setState({ value: null, loading: false, error: String(err?.message ?? err) });
        },
      );
    return () => {
      alive = false;
    };
  }, [dep, fn]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

const num = (s) => {
  if (s === undefined || s === null || s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

const fmtInt = (n) => n.toLocaleString('en-US');

function usd(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs === 0 ? 2 : abs >= 100 ? 2 : abs >= 1 ? 3 : 4;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
  }).format(n);
}

// ---------------------------------------------------------------- helpers

function visionOptions(model) {
  if (model.vision === 'gpt5') return ['auto', 'high'];
  if (model.vision === 'tile') return ['auto', 'low', 'high'];
  return [];
}

function imageTokenCount(model, w, h, detail) {
  if (model.vision === 'gpt5') return gpt5VisionTokens(w, h, detail === 'auto' ? 'auto' : detail);
  if (model.vision === 'tile') return openAIVisionTokens(w, h, detail, model.visionCfg);
  if (model.vision === 'claude') return claudeVisionTokens(w, h, model.visionTier).tokens;
  return 0;
}

function tokenizerLabel(tokenizer) {
  return {
    o200k: 'o200k_base (OpenAI)',
    cl100k: 'cl100k_base (OpenAI)',
    claude: 'Claude BPE (Anthropic)',
    llama: 'Llama 3 (open models)',
  }[tokenizer];
}

function Disclaimer() {
  return (
    <div className="disclaimer">
      All prices and token counts are <strong>approximate estimates</strong> built from published
      rate cards and local tokenizers — actual invoices can differ (rate changes, rounding,
      batching, cache behavior, provider-side counts). Always confirm against the provider before
      committing spend.
    </div>
  );
}

// ---------------------------------------------------------------- primitives

function Segmented({ options, value, onChange, disabled }) {
  return (
    <div className="segmented">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={opt.value === value ? 'seg active' : 'seg'}
          onClick={() => !disabled && onChange(opt.value)}
          disabled={disabled}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function Dropdown({ value, onChange, options, disabled }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function ImageDrop({ onFiles }) {
  return (
    <label className="drop">
      <input
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
      />
      <span>+ Add images (reads real pixel dimensions)</span>
    </label>
  );
}

function Stat({ label, value, accent, tag }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={accent ? 'stat-value accent' : 'stat-value'}>{value}</span>
      {tag ? <Tag m={tag.m} c={tag.c} /> : null}
    </div>
  );
}

// Method + confidence badge — the spec's core contract: a number without a
// traceable method is a bug. Every rendered figure carries one.
function Tag({ m, c }) {
  const cls = {
    exact: 'tag-exact',
    proxy: 'tag-proxy',
    heuristic: 'tag-heur',
    formula: 'tag-formula',
    user: 'tag-user',
    derived: 'tag-deriv',
    unavail: 'tag-unavail',
  }[m] || 'tag-deriv';
  return (
    <span className={`tag ${cls}`}>
      {m}
      <i>{c}</i>
    </span>
  );
}

function Section({ title, hint, children }) {
  return (
    <div className="section">
      <div className="section-title">
        {title}
        {hint ? <span className="field-hint">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- price editor

function PriceEditor({ model, price, onChange, gen }) {
  const fields = gen
    ? [
        ['input', 'Text input $/1M'],
        ['cachedInput', 'Cached $/1M'],
        ['imageInput', 'Image input $/1M'],
        ['imageOutput', 'Image output $/1M'],
      ]
    : [
        ['input', 'Input $/1M'],
        ['cachedInput', 'Cached input $/1M'],
        ['output', 'Output $/1M'],
      ];
  return (
    <div className="price-editor">
      <div className="price-editor-title">Rate card (editable)</div>
      <div className="price-grid">
        {fields.map(([key, label]) => (
          <label key={key} className="price-field">
            <span>{label}</span>
            <input
              type="number"
              step="any"
              value={price[key] ?? 0}
              onChange={(e) => onChange(key, num(e.target.value))}
            />
          </label>
        ))}
      </div>
      {model?.approx ? <div className="note inline">Pricing is approximate — edit as needed.</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- model picker

function ModelPicker({ modelId, onChange, gen }) {
  const groups = {};
  for (const m of gen ? GEN_MODELS : MODELS) {
    (groups[m.provider] ??= []).push(m);
  }
  const list = [];
  for (const [provider, ms] of Object.entries(groups)) {
    list.push(
      <optgroup key={provider} label={provider}>
        {ms.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </optgroup>,
    );
  }
  return (
    <Field label={gen ? 'Image model' : 'Model'}>
      <select value={modelId} onChange={(e) => onChange(e.target.value)}>
        {list}
      </select>
    </Field>
  );
}

// ---------------------------------------------------------------- read / edit tab

function ReadTab() {
  const [modelId, setModelId] = useState('gpt-6-astra');
  const [text, setText] = useState('');
  const [system, setSystem] = useState('');
  const [tools, setTools] = useState('');
  const [overhead, setOverhead] = useState('0');
  const [estIn, setEstIn] = useState('0');
  const [quickText, setQuickText] = useState('');
  const [plan, setPlan] = useState(null);
  const [rec, setRec] = useState(null);
  const [recLoading, setRecLoading] = useState(false);
  const [images, setImages] = useState([]);
  const [profile, setProfile] = useState('prose');
  const [outWords, setOutWords] = useState('200');
  const [maxTok, setMaxTok] = useState('');
  const [p90Ratio, setP90Ratio] = useState('1.5');
  const [reasoning, setReasoning] = useState('0');
  const [reasonP90Ratio, setReasonP90Ratio] = useState('1.5');
  const [eosStr, setEosStr] = useState('0');
  const [cacheHit, setCacheHit] = useState('80');
  const [cacheWrite, setCacheWrite] = useState(true);
  const [histStrategy, setHistStrategy] = useState('full');
  const [historyTurns, setHistoryTurns] = useState('0');
  const [historyPerTurn, setHistoryPerTurn] = useState('0');
  const [histK, setHistK] = useState('5');
  const [histEvery, setHistEvery] = useState('4');
  const [longCtx, setLongCtx] = useState(false);
  const [hosting, setHosting] = useState('managed');
  const [gpuCph, setGpuCph] = useState('2.5');
  const [tps, setTps] = useState('40');
  const [overheadSecs, setOverheadSecs] = useState('2');
  const [utilPct, setUtilPct] = useState('50');
  const [quant, setQuant] = useState('fp16');
  const [gpuVram, setGpuVram] = useState('24');
  const [gpuCount, setGpuCount] = useState('1');
  const [usablePct, setUsablePct] = useState('90');
  const [requestsPerDay, setRequestsPerDay] = useState('10000');
  const [fixedIdle, setFixedIdle] = useState('150');
  const [fixedStorage, setFixedStorage] = useState('20');
  const [egressGb, setEgressGb] = useState('100');
  const [egressRate, setEgressRate] = useState('0.09');
  const [opsMonthly, setOpsMonthly] = useState('200');
  const [newTok, setNewTok] = useState(true);
  const [overrides, setOverrides] = useState({});

  const model = getModel(modelId);
  const hasLong = model.longInput != null && model.longOutput != null;
  const price = overrides[modelId] ?? {
    input: model.input,
    output: model.output,
    cachedInput: model.cachedInput,
    longInput: model.longInput,
    longOutput: model.longOutput,
  };
  const setPrice = (key, v) =>
    setOverrides((p) => ({
      ...p,
      [modelId]: {
        input: model.input,
        output: model.output,
        cachedInput: model.cachedInput,
        longInput: model.longInput,
        longOutput: model.longOutput,
        ...p[modelId] ?? {},
        [key]: v,
      },
    }));

  // ---- tokenizer counts (EXACT when a real tokenizer exists) ----
  const counts = useCount(
    async () => {
      const t = text.trim() ? countTokensByTokenizer(model.tokenizer, text) : 0;
      const s = system.trim() ? countTokensByTokenizer(model.tokenizer, system) : 0;
      const tl = tools.trim() ? countTokensByTokenizer(model.tokenizer, tools) : 0;
      return { text: t, system: s, tools: tl };
    },
    model.tokenizer + '\u0000' + text + '\u0000' + system + '\u0000' + tools,
  );

  const multiplier = model.newTokenizer && newTok ? CLAUDE_TOKENIZER_MULTIPLIER : 1;
  const graphTokens = counts.value
    ? Math.ceil((counts.value.text + counts.value.system + counts.value.tools) * multiplier)
    : 0;

  const imageRows = images.map((img) => ({
    ...img,
    tokens: model.vision ? imageTokenCount(model, img.w, img.h, img.detail) : 0,
  }));
  const imageTokens = imageRows.reduce((a, b) => a + b.tokens, 0);

  const framingTokens = Math.max(0, Math.floor(num(overhead)));
  const estTokens = Math.max(0, Math.floor(num(estIn)));

  // ---- multi-turn history: three strategies, cost deltas shown ----
  const turns = Math.max(0, Math.floor(num(historyTurns)));
  const perTurn = Math.max(0, Math.floor(num(historyPerTurn)));
  const fullHist = turns * perTurn;
  const hist = (() => {
    if (histStrategy === 'sliding') {
      const k = Math.max(1, Math.floor(num(histK)));
      return { tokens: Math.min(turns, k) * perTurn, label: `SLIDING_WINDOW(k=${k})` };
    }
    if (histStrategy === 'rollup') {
      const ev = Math.max(1, Math.floor(num(histEvery)));
      const recent = Math.min(turns, ev) * perTurn;
      const old = Math.max(0, turns - ev) * perTurn * 0.15;
      return { tokens: Math.round(recent + old), label: `SUMMARIZED_ROLLUP(every ${ev})` };
    }
    return { tokens: fullHist, label: 'FULL_HISTORY' };
  })();
  const historyTokens = hist.tokens;
  const histSavePct = fullHist > 0 ? Math.round((1 - historyTokens / fullHist) * 100) : 0;

  const inputTokens = graphTokens + framingTokens + historyTokens + imageTokens + estTokens;

  // ---- output + reasoning as P50/P90 distributions, clamped by max_tokens ----
  const profileTpw = TEXT_PROFILES[profile].tokensPerWord;
  const maxCap = num(maxTok) || Infinity;
  const outP50Raw = Math.max(0, Math.floor(num(outWords) * profileTpw));
  const outP90Raw = Math.floor(outP50Raw * Math.max(1, num(p90Ratio) || 1.5));
  const outP50 = Math.min(outP50Raw, maxCap);
  const outP90 = Math.min(outP90Raw, maxCap);
  const reasonP50 = Math.max(0, Math.floor(num(reasoning)));
  const reasonP90 = Math.floor(reasonP50 * Math.max(1, num(reasonP90Ratio) || 1.5));
  const eosTokens = Math.max(0, Math.floor(num(eosStr)));
  const billableP50 = eosTokens + outP50 + reasonP50;
  const billableP90 = eosTokens + outP90 + reasonP90;
  const truncation = Number.isFinite(maxCap) && (outP90Raw + reasonP90 + eosTokens > maxCap);
  const overCap = Number.isFinite(maxCap) && billableP50 > maxCap;
  const contextTotal = inputTokens + billableP90;

  // ---- managed rates (plain / long-context tier) ----
  const selfhost = hosting === 'selfhost';
  const absolute = longCtx && hasLong;
  const inputRatePerM = absolute ? price.longInput : price.input;
  const outputRatePerM = absolute ? price.longOutput : price.output;
  const readRatePerM =
    !absolute && price.cachedInput > 0 ? price.cachedInput : inputRatePerM;
  const writeRatePerM =
    cacheWrite && model.cacheWriteInput != null ? model.cacheWriteInput : null;
  const inputRate = inputRatePerM / 1e6;
  const outputRate = outputRatePerM / 1e6;

  // ---- cache model: cached × read + uncached × standard + write premium ----
  const hitRatio = Math.min(1, Math.max(0, num(cacheHit) / 100));
  const cachedTokens = Math.round(inputTokens * hitRatio);
  const uncachedTokens = inputTokens - cachedTokens;
  const inputCost =
    uncachedTokens * inputRate +
    cachedTokens * (readRatePerM / 1e6) +
    (writeRatePerM != null ? cachedTokens * (writeRatePerM / 1e6) : 0);
  const outputCostP50 = (eosTokens + outP50 + reasonP50) * outputRate;
  const outputCostP90 = (eosTokens + outP90 + reasonP90) * outputRate;
  const totalP50 = inputCost + outputCostP50;
  const totalP90 = inputCost + outputCostP90;
  const over128 = hasLong && contextTotal > model.longThreshold;
  const near128 = hasLong && !over128 && contextTotal > model.longThreshold * 0.9;

  // ---- self-hosted: per-request GPU time, utilization, fixed monthly, VRAM ----
  const calls = Math.max(1, Math.floor(num(historyTurns)) + 1);
  const totalTokens = inputTokens + billableP90;
  const secsPerRequest = totalTokens / Math.max(1, num(tps)) + num(overheadSecs);
  const utilF = Math.max(0.01, num(utilPct) / 100);
  const selfPerRequest = (num(gpuCph) / 3600) * secsPerRequest / utilF;
  const selfSecs = calls * secsPerRequest;
  const selfCost = selfPerRequest * calls;
  const callsPerMonth = Math.max(1, Math.floor(num(requestsPerDay)) * 30);
  const fixedMonthly =
    num(fixedIdle) + num(fixedStorage) + num(egressGb) * num(egressRate) + num(opsMonthly);
  const selfMonthly = selfPerRequest * callsPerMonth + fixedMonthly;
  const apiPerReq = totalP50;
  const breakeven =
    apiPerReq - selfPerRequest > 0
      ? Math.ceil(fixedMonthly / (apiPerReq - selfPerRequest))
      : Infinity;

  // ---- VRAM feasibility gate (refuse, don't guess) ----
  const arch = OPEN_ARCH[model.id];
  const dtypeBytes = QUANTIZATION[quant]?.bytes ?? 2;
  let vram = null;
  let feasible = null;
  let archNote = '';
  if (!arch) {
    archNote =
      'UNAVAILABLE — no signed model card (weights + KV layout) in the registry for this model. Refusing to guess VRAM.';
  } else {
    const weightsGB = arch.paramsB * dtypeBytes;
    const kvGBperTok =
      (arch.layers * arch.kvHeads * arch.headDim * 2 * dtypeBytes) / 1e9;
    vram = weightsGB + kvGBperTok * Math.max(totalTokens, 1) + 4; // + activation overhead
    const available =
      Math.max(1, Math.floor(num(gpuCount))) * num(gpuVram) * (num(usablePct) / 100);
    feasible = vram <= available;
  }
  const total = selfhost ? selfCost : totalP50;

  const isReasoner = model.reasoning;

  // ---- multi-step workflow (intent parser) ----
  const planSteps = (plan?.steps ?? []).map((st) => {
    if (st.kind === 'image') {
      const g = GEN_MODELS[0];
      const tier = st.quality === 'high' ? 'high' : 'medium';
      const out = g.perImage[tier]?.square ?? g.perImage.medium.square;
      // image-to-image: the uploaded source images bill as image-input tokens
      // (65 + 129/tile via IMAGE_INPUT_TILE) + per-image output.
      const refTokens = st.mode === 'edit' ? imageTokens : 0;
      const refCost = refTokens * (g.imageInput / 1e6);
      return {
        ...st,
        cost: refCost + out,
        inputT: refTokens,
        rate: st.mode === 'edit'
          ? `i2i · ${fmtInt(refTokens)} ref tok @ $${g.imageInput}/1M + ${out}/img${refTokens === 0 ? ' (no source loaded → billed as text-to-image)' : ''}`
          : `${out}/img`,
      };
    }
    const inputT =
      st.estInput +
      (st.vision && model.vision ? imageTokenCount(model, 1024, 1024, 'high') : 0);
    const cost = inputT * inputRate + st.estOutput * outputRate;
    return { ...st, cost, inputT, rate: null };
  });
  const planTotal = planSteps.reduce((a, s) => a + s.cost, 0) * (plan?.volume ?? 1);

  // ---- split routing: per-task model assignment (cheap READ, frontier WRITE/EDIT) ----
  const pickForStep = (st) => {
    if (st.kind === 'image') {
      const g = GEN_MODELS[0];
      const tier = st.quality === 'high' ? 'high' : 'medium';
      const refTokens = st.mode === 'edit' ? imageTokens : 0;
      const cost = refTokens * (g.imageInput / 1e6) + (g.perImage[tier]?.square ?? g.perImage.medium.square);
      return { name: g.name, cost, id: g.id, tokenizer: 'per image' };
    }
    let best = null;
    for (const m of MODELS) {
      if (st.vision && !m.vision) continue;
      const q = m.quality ?? 1;
      const frontier = st.kind === 'write' || st.kind === 'edit';
      if (frontier ? q < 4 : q < 2) continue;
      const inputT = st.estInput + (m.vision ? imageTokenCount(m, 1024, 1024, 'high') : 0);
      const cost = inputT * (m.input / 1e6) + st.estOutput * (m.output / 1e6);
      if (!best || cost < best.cost) best = { name: m.name, cost, id: m.id, tokenizer: m.tokenizer };
    }
    return best ?? { name: 'no valid model', cost: 0, id: null, tokenizer: '—' };
  };
  const splitSteps = planSteps.map((st) => ({ ...st, pick: pickForStep(st) }));
  const splitCost = splitSteps.reduce((a, s) => a + s.pick.cost, 0) * (plan?.volume ?? 1);
  const singleRoute = (() => {
    const imageCost = planSteps
      .filter((st) => st.kind === 'image')
      .reduce((a, st) => {
        const g = GEN_MODELS[0];
        const tier = st.quality === 'high' ? 'high' : 'medium';
        const refTokens = st.mode === 'edit' ? imageTokens : 0;
        return a + refTokens * (g.imageInput / 1e6) + (g.perImage[tier]?.square ?? g.perImage.medium.square);
      }, 0);
    let bestModel = null;
    let bestCost = Infinity;
    for (const m of MODELS) {
      const canDo = planSteps.every(
        (st) => st.kind === 'image' || (st.vision ? m.vision : true),
      );
      if (!canDo) continue;
      const cost =
        imageCost +
        planSteps
          .filter((st) => st.kind !== 'image')
          .reduce((a, st) => {
            const inputT = st.estInput + (m.vision ? imageTokenCount(m, 1024, 1024, 'high') : 0);
            return a + inputT * (m.input / 1e6) + st.estOutput * (m.output / 1e6);
          }, 0);
      if (cost < bestCost) {
        bestCost = cost;
        bestModel = m;
      }
    }
    return { cost: bestCost, name: bestModel?.name ?? 'no model' };
  })();
  const splitSave =
    singleRoute.cost > 0 ? Math.max(0, Math.round((1 - splitCost / singleRoute.cost) * 100)) : 0;

  // ---- assumptions ledger (spec: labeled, never silent, all editable) ----
  const assumptions = [
    { label: 'Output length profile', value: `${TEXT_PROFILES[profile].label} (${profileTpw} tok/word)`, prov: 'task-type prior, editable' },
    { label: 'Output P90 spread', value: `P90 = P50 × ${num(p90Ratio) || 1.5}`, prov: 'observed-range heuristic, editable' },
    { label: 'Reasoning tokens', value: `P50 ${fmtInt(reasonP50)} · P90 ${fmtInt(reasonP90)}`, prov: 'usage.completion_tokens_details prior, editable' },
    { label: 'Cache hit ratio', value: `${Math.round(hitRatio * 100)}%`, prov: 'workflow-shape default, editable' },
    { label: 'Cache write premium', value: writeRatePerM != null ? `yes ($${writeRatePerM}/1M first write)` : 'not published — omitted (refuse to invent)', prov: 'provider rate card' },
    { label: 'History strategy', value: `${hist.label}${histSavePct ? ` (−${histSavePct}% vs FULL_HISTORY)` : ''}`, prov: 'editable' },
    { label: 'GPU utilization', value: `${num(utilPct)}%`, prov: 'user-owned — the honest FinOps lever' },
    { label: 'Effective tokens/sec', value: `${num(tps)} tok/s`, prov: 'hardware + serving stack dependent, editable' },
  ];

  const applyStep = (stepsAr, language, index) => {
    const st = stepsAr?.[index];
    if (!st) return;
    setEstIn(String(st.estInput));
    const profKey = st.code ? 'code' : language === 'non-english' ? 'multilingual' : 'prose';
    const outWordsT = Math.max(
      1,
      Math.round(st.estOutput / TEXT_PROFILES[profKey].tokensPerWord),
    );
    setOutWords(String(outWordsT));
    setProfile(profKey);
    if (st.vision && images.length === 0 && model.vision) {
      setImages((prev) => [
        ...prev,
        {
          id: `synthetic-${Date.now()}`,
          url: null,
          name: 'detected image · default 1024×1024',
          w: 1024,
          h: 1024,
          detail: 'high',
        },
      ]);
    }
  };

  const handleParse = () => {
    const p = parseTask(quickText);
    setPlan(p);
    applyStep(p.steps, p.language, 0);
  };

  const handleRecommend = async () => {
    setRecLoading(true);
    try {
      const textOnly = [text, system, tools].join('\n');
      const counts = await countAllTokenizers(textOnly);
      setRec(
        recommendModels(MODELS, {
          counts,
          outputTokens: billableP50,
          imageTokens: model.vision ? imageTokens : 0,
          needsVision: imageTokens > 0,
          cached: hitRatio > 0.5,
        }),
      );
    } finally {
      setRecLoading(false);
    }
  };

  const onFiles = (files) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        setImages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            url,
            name: f.name,
            w: img.naturalWidth,
            h: img.naturalHeight,
            detail: 'auto',
          },
        ]);
      };
      img.src = url;
    }
  };

  const removeImage = (id) => {
    setImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.url);
      return prev.filter((i) => i.id !== id);
    });
  };

  const opts = visionOptions(model);
  const claude = model.vision === 'claude';

  // ---- method + confidence provenance for every rendered figure ----
  const textMethod = model.approx
    ? { m: 'EXACT_PROXY', c: 'LOW' }
    : model.newTokenizer && newTok
      ? { m: 'TOKENIZER×1.30', c: 'MEDIUM' }
      : { m: 'EXACT_TOKENIZER', c: 'HIGH' };
  const userTag = { m: 'USER_SUPPLIED', c: 'HIGH' };
  const formulaTag = { m: 'PROVIDER_FORMULA', c: 'HIGH' };
  const calcTag = { m: 'DERIVED', c: 'MEDIUM' };
  const heurTag = { m: 'CALIBRATED_HEURISTIC', c: 'LOW' };
  const reasonTag = reasoning.trim()
    ? { m: 'USER_SUPPLIED', c: 'HIGH' }
    : model.reasoning
      ? { m: 'PRIOR_ESTIMATE', c: 'LOW' }
      : { m: 'CALIBRATED_HEURISTIC', c: 'LOW' };

  return (
    <div className="tab-body">
      <div className="pane input-pane">
        <ModelPicker modelId={modelId} onChange={setModelId} />
        {model.note ? <div className="note inline">{model.note}</div> : null}

        <div className="field">
          <span className="field-label">Cost model</span>
          <Segmented
            options={[
              { value: 'managed', label: 'Managed API (per token)' },
              { value: 'selfhost', label: 'Self-hosted (GPU $/hr)' },
            ]}
            value={hosting}
            onChange={setHosting}
          />
        </div>

        <Section
          title="Describe the task → exact API calls"
          hint="reads intent, assets, volume, language"
        >
          <textarea
            rows={2}
            placeholder='e.g. "Upload a Chinese contract PDF, summarize it for me, then generate a featured image for the article."'
            value={quickText}
            onChange={(e) => setQuickText(e.target.value)}
          />
          <div className="row">
            <button type="button" className="btn" onClick={handleParse}>
              Estimate workflow
            </button>
            <button
              type="button"
              className="btn ghost-btn"
              onClick={() => {
                setPlan(null);
                setEstIn('0');
              }}
            >
              Clear
            </button>
          </div>
          {plan ? (
            <>
              <div className="steps">
                {splitSteps.map((st, i) => (
                  <div key={st.id} className="step-card">
                    <div className="step-kind">{st.kind}{st.code ? '·code' : ''}</div>
                    <div className="step-body">
                      <div className="step-raw">{st.raw}</div>
                      <div className="step-meta">
                        ~{fmtInt(st.estInput)} in · ~{fmtInt(st.estOutput)} out
                        {st.vision ? ' · vision @1024²' : ''} · {st.note}
                      </div>
                      <div className="step-meta">
                        handled by <strong>{st.pick.name}</strong>
                        {st.pick.tokenizer !== 'per image' ? ` (${st.pick.tokenizer})` : ''} ·{' '}
                        {usd(st.pick.cost)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn ghost-btn"
                      onClick={() => applyStep(plan.steps, plan.language, i)}
                    >
                      Load
                    </button>
                  </div>
                ))}
              </div>
              <div className="note">
                ≈ {fmtInt(plan.calls)} API calls across {plan.steps.length} step
                {plan.steps.length > 1 ? 's' : ''} ×{plan.volume} volume · workflow cost under{' '}
                {getModel(modelId).name}: <strong>{usd(planTotal)}</strong> · split-routing cost:{' '}
                <strong>{usd(splitCost)}</strong>{' '}
                {splitSave > 0 ? `(−${splitSave}% vs one model)` : ''}
                {plan.language === 'non-english' ? ' · non-English ≈ 2×' : ''}
              </div>
              <div className="note">
                Call types → token shape (read = input-heavy, write/edit = delta-heavy, image =
                per-image); each call's <em>handling LLM</em> sets the per-token rate. Paste the real
                code in the Prompt field to upgrade these to exact tokenizer counts.
              </div>
            </>
          ) : null}
        </Section>

        <Section title="Prompt / input text" hint={tokenizerLabel(model.tokenizer)}>
          <div className="field">
            <textarea
              rows={7}
              placeholder="Paste your prompt, code, document, or chat message here…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {(text || system || tools).trim() ? (
            <div className="note inline">
              Counted: text {fmtInt(counts.value?.text ?? 0)} · system{' '}
              {fmtInt(counts.value?.system ?? 0)} · tools {fmtInt(counts.value?.tools ?? 0)}
              {' + '}resources in the input pane below.
            </div>
          ) : null}
          <div className="row">
            <Field
              label="Estimated input tokens (no text pasted?)"
              hint="task defaults / doc length"
            >
              <input
                type="number"
                min={0}
                step={1}
                value={estIn}
                onChange={(e) => setEstIn(e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="System prompt & hidden tokens" hint="framing, vocab, EOS">
          <Field label="System prompt" hint={`distinct tokens, counted at ${fmtInt(1)} token`}>
            <textarea
              rows={3}
              placeholder="System prompt / framing syntax, pre-pended to every request…"
              value={system}
              onChange={(e) => setSystem(e.target.value)}
            />
          </Field>
          <div className="row">
            <Field label="Framing / vocab tokens (per turn)">
              <input
                type="number"
                min={0}
                step={1}
                value={overhead}
                onChange={(e) => setOverhead(e.target.value)}
              />
            </Field>
            <Field label="EOS / framing output tokens">
              <input
                type="number"
                min={0}
                step={1}
                value={eosStr}
                onChange={(e) => setEosStr(e.target.value)}
              />
            </Field>
          </div>
          <div className="note">
            System prompts, chat framing syntax, and EOS markers are hidden tokens the tokenizer
            never shows you.
          </div>
        </Section>

        <Section title="Tools & function calling" hint="JSON schemas consume input before you type">
          <textarea
            rows={3}
            placeholder="Paste tool / function JSON schemas injected into the request…"
            value={tools}
            onChange={(e) => setTools(e.target.value)}
          />
          <div className="note">Tool definitions count toward input on every call — even empty ones.</div>
        </Section>

        <Section title="Conversation history" hint="every turn re-feeds prior output">
          <div className="row">
            <Field label="Prior turns">
              <input
                type="number"
                min={0}
                step={1}
                value={historyTurns}
                onChange={(e) => setHistoryTurns(e.target.value)}
              />
            </Field>
            <Field label="Tokens per turn (input + output)">
              <input
                type="number"
                min={0}
                step={1}
                value={historyPerTurn}
                onChange={(e) => setHistoryPerTurn(e.target.value)}
              />
            </Field>
          </div>
          <div className="row">
            <Field label="History strategy">
              <Segmented
                options={[
                  { value: 'full', label: 'Full' },
                  { value: 'sliding', label: 'Sliding window' },
                  { value: 'rollup', label: 'Summarize/rollup' },
                ]}
                value={histStrategy}
                onChange={setHistStrategy}
              />
            </Field>
            {histStrategy === 'sliding' ? (
              <Field label="Keep last k turns">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={histK}
                  onChange={(e) => setHistK(e.target.value)}
                />
              </Field>
            ) : null}
            {histStrategy === 'rollup' ? (
              <Field label="Keep raw for" hint="older turns → 15% summary">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={histEvery}
                  onChange={(e) => setHistEvery(e.target.value)}
                />
              </Field>
            ) : null}
          </div>
          <div className="note">
            Context compounds: previous replies become the next request's input. Current strategy{' '}
            {hist.label} = {fmtInt(historyTokens)} tokens
            {fullHist > 0 && historyTokens < fullHist
              ? ` (−${histSavePct}% vs FULL_HISTORY, ${usd((fullHist - historyTokens) * inputRate)} saved per request)`
              : ''}.
          </div>
        </Section>

        <div className="field">
          <span className="field-label">
            Images (vision){model.vision ? '' : ' — this model has no vision'}
          </span>
          {!model.vision ? (
            <div className="note inline">Open models count text only.</div>
          ) : (
            <>
              <ImageDrop onFiles={onFiles} />
              <div className="img-list">
                {imageRows.map((img) => (
                  <div key={img.id} className="img-row" title={img.name}>
                    {img.url ? (
                    <img src={img.url} alt="" className="thumb" />
                  ) : (
                    <div className="thumb thumb-ghost">512²</div>
                  )}
                    <div className="img-meta">
                      <div className="img-name">
                        {img.name} · {img.w}×{img.h}
                      </div>
                      <div className="img-tokens">
                        {claude
                          ? `~${fmtInt(img.tokens)} tokens (${model.visionTier === 'high' ? '2576px' : '1568px'} tier)`
                          : `~${fmtInt(img.tokens)} tokens`}
                      </div>
                    </div>
                    {opts.length > 0 ? (
                      <select
                        value={img.detail}
                        onChange={(e) =>
                          setImages((prev) =>
                            prev.map((p) =>
                              p.id === img.id ? { ...p, detail: e.target.value } : p,
                            ),
                          )
                        }
                      >
                        {opts.map((o) => (
                          <option key={o} value={o}>
                            {o === 'auto' ? 'detail: auto' : `detail: ${o}`}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <button type="button" className="ghost" onClick={() => removeImage(img.id)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <Section title="Output & reasoning" hint="P50/P90, clamped by max_tokens">
          <div className="row">
            <Field label="Estimated output words">
              <input
                type="number"
                min={0}
                step={1}
                value={outWords}
                onChange={(e) => setOutWords(e.target.value)}
              />
            </Field>
            <Field label="Output text type">
              <Dropdown
                value={profile}
                onChange={setProfile}
                options={Object.entries(TEXT_PROFILES).map(([k, v]) => ({
                  value: k,
                  label: `${v.label} (~${v.tokensPerWord}/word)`,
                }))}
              />
            </Field>
          </div>
          <div className="row">
            <Field label="max_tokens (cap)" hint="ignores any above it">
              <input
                type="number"
                min={0}
                step={1}
                value={maxTok}
                placeholder="none"
                onChange={(e) => setMaxTok(e.target.value)}
              />
            </Field>
            <Field label="P90 spread ×" hint="P90 = P50 × this">
              <input
                type="number"
                min={1}
                step={0.1}
                value={p90Ratio}
                onChange={(e) => setP90Ratio(e.target.value)}
              />
            </Field>
          </div>
          <div className="row">
            <Field label="Reasoning P50 tokens" hint="hidden compute before the answer">
              <input
                type="number"
                min={0}
                step={1}
                value={reasoning}
                onChange={(e) => setReasoning(e.target.value)}
              />
            </Field>
            <Field label="Reasoning P90 spread ×">
              <input
                type="number"
                min={1}
                step={0.1}
                value={reasonP90Ratio}
                onChange={(e) => setReasonP90Ratio(e.target.value)}
              />
            </Field>
          </div>
          <div className="note">
            {isReasoner
              ? `Reasoning models burn tokens you never see — read usage.completion_tokens_details. They invoice as output tokens and are as unpredictable as the answer: hence P50/P90.`
              : `For reasoning models (o1/o3, DeepSeek R1): add hidden thinking tokens here — they invoice as output tokens.`}
            {truncation || overCap
              ? ' Warning: the distribution exceeds max_tokens — the clamp cost is what you will actually be billed.'
              : ''}
          </div>
        </Section>

        <Section title="Cache & billing" hint="split: uncached × read × cache-write">
          <div className="row">
            <Field label="Cache hit ratio %" hint="fraction of input billed at cached rate">
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={cacheHit}
                onChange={(e) => setCacheHit(e.target.value)}
              />
            </Field>
            {model.cacheWriteInput != null ? (
              <Field label="Cache write premium" hint={`first write @ $${model.cacheWriteInput}/1M`}>
                <Toggle checked={cacheWrite} onChange={setCacheWrite} label="charged" />
              </Field>
            ) : null}
          </div>
          {model.cacheWriteInput == null ? (
            <div className="note">
              {model.name} publishes no cache-write rate — refused to invent one, so first-time
              writes are billed at the read rate.
            </div>
          ) : null}
          <div className="toggles">
            {hasLong ? (
              <Toggle
                checked={longCtx}
                onChange={setLongCtx}
                label={`Long-context rate (>${fmtInt(model.longThreshold)})`}
              />
            ) : null}
            {model.newTokenizer ? (
              <Toggle
                checked={newTok}
                onChange={setNewTok}
                label={`Apply new-tokenizer estimate (×${CLAUDE_TOKENIZER_MULTIPLIER})`}
              />
            ) : null}
          </div>
        </Section>
      </div>

      <div className="pane results-pane">
        <Disclaimer />

        {selfhost ? (
          <>
            <div className="price-editor">
              <div className="price-editor-title">Self-hosted infrastructure</div>
              <div className="price-grid">
                <label className="price-field">
                  <span>GPU rental $/hr</span>
                  <input type="number" step="any" value={gpuCph} onChange={(e) => setGpuCph(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>Effective tokens/sec</span>
                  <input type="number" step="any" value={tps} onChange={(e) => setTps(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>Overhead secs/call</span>
                  <input type="number" step="any" value={overheadSecs} onChange={(e) => setOverheadSecs(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>GPU utilization %</span>
                  <input type="number" step="any" value={utilPct} onChange={(e) => setUtilPct(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>Quantization</span>
                  <select value={quant} onChange={(e) => setQuant(e.target.value)}>
                    {Object.entries(QUANTIZATION).map(([k, v]) => (
                      <option key={k} value={k}>{v.label}</option>
                    ))}
                  </select>
                </label>
                <label className="price-field">
                  <span>Requests/day</span>
                  <input type="number" step="any" value={requestsPerDay} onChange={(e) => setRequestsPerDay(e.target.value)} />
                </label>
              </div>
            </div>

            <div className="price-editor">
              <div className="price-editor-title">Capital (owned GPUs)</div>
              <div className="price-grid">
                <label className="price-field">
                  <span>VRAM / GPU GB</span>
                  <input type="number" step="any" value={gpuVram} onChange={(e) => setGpuVram(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>GPU count</span>
                  <input type="number" step="any" value={gpuCount} onChange={(e) => setGpuCount(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>Usable VRAM %</span>
                  <input type="number" step="any" value={usablePct} onChange={(e) => setUsablePct(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>Idle + amortization $/mo</span>
                  <input type="number" step="any" value={fixedIdle} onChange={(e) => setFixedIdle(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>Model storage $/mo</span>
                  <input type="number" step="any" value={fixedStorage} onChange={(e) => setFixedStorage(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>Egress $/mo</span>
                  <input type="number" step="any" value={egressGb} onChange={(e) => setEgressGb(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>Egress $/GB</span>
                  <input type="number" step="any" value={egressRate} onChange={(e) => setEgressRate(e.target.value)} />
                </label>
                <label className="price-field">
                  <span>Ops / labour $/mo</span>
                  <input type="number" step="any" value={opsMonthly} onChange={(e) => setOpsMonthly(e.target.value)} />
                </label>
              </div>
              <div className={`vram-gate ${feasible == null ? 'unavail' : feasible ? 'ok' : 'fail'}`}>
                {feasible == null
                  ? `VRAM ${archNote}`
                  : feasible
                    ? `VRAM feasible: needs ≈ ${vram.toFixed(1)} GB (${QUANTIZATION[quant].label} weights + KV @ ${fmtInt(totalTokens)} ctx), have ${fmtInt(num(gpuCount) * num(gpuVram))} GB.`
                    : `VRAM insufficient: needs ≈ ${vram.toFixed(1)} GB, have ${fmtInt(num(gpuCount) * num(gpuVram))} GB — reduce {quant, ctx} or raise capacity.`}
              </div>
            </div>
          </>
        ) : (
          <PriceEditor model={model} price={price} onChange={setPrice} />
        )}

        <div className="stats-grid">
          <Stat
            label="Input · text"
            value={counts.loading ? 'counting…' : counts.error ? '—' : fmtInt(counts.value?.text ?? 0)}
            tag={textMethod}
          />
          <Stat
            label="Input · system + tools"
            value={counts.loading ? '…' : fmtInt((counts.value?.system ?? 0) + (counts.value?.tools ?? 0))}
            tag={textMethod}
          />
          <Stat label="Input · task defaults" value={fmtInt(estTokens)} tag={userTag} />
          <Stat
            label="Input · images"
            value={fmtInt(imageTokens)}
            tag={formulaTag}
          />
          <Stat label="Input · framing + history" value={fmtInt(framingTokens + historyTokens)} tag={calcTag} />
          {tools.trim() ? (
            <Stat label="Tools schema (own line)" value={counts.loading ? '…' : fmtInt(counts.value?.tools ?? 0)} tag={textMethod} accent />
          ) : null}
          <Stat label="Input · TOTAL" value={fmtInt(inputTokens)} accent tag={calcTag} />
          <Stat label="Output P50" value={fmtInt(eosTokens + outP50)} tag={heurTag} />
          <Stat label="Output P90" value={fmtInt(eosTokens + outP90)} tag={heurTag} />
          <Stat label="Reasoning P50" value={fmtInt(reasonP50)} tag={reasonTag} />
          <Stat label="Reasoning P90" value={fmtInt(reasonP90)} tag={reasonTag} />
          <Stat label="Context est. (P90)" value={fmtInt(contextTotal)} accent />
        </div>

        {model.newTokenizer && counts.loading === false ? (
          <div className="note">
            {model.name} uses the tokenizer introduced with Opus 4.7 (≈1.30× more tokens per
            text). Counts shown are the legacy-tokenizer count scaled by ×1.30.
          </div>
        ) : null}

        {over128 ? (
          <div className="note warn">
            Estimated context ({fmtInt(contextTotal)} tokens) crosses the {fmtInt(model.longThreshold)}
            -token threshold — the long-context rate is NOW billing this request.
          </div>
        ) : near128 ? (
          <div className="note warn">
            Near the {fmtInt(model.longThreshold)}-token threshold ({Math.round((contextTotal / model.longThreshold) * 100)}
            %) — long-context pricing may apply on a single heavy request.
          </div>
        ) : null}

        {(truncation || overCap) && !selfhost ? (
          <div className="note warn">
            Output P90 ({fmtInt(eosTokens + outP90 + reasonP90)} tokens) exceeds max_tokens — the
            clamped totals below are what the API will actually bill.
          </div>
        ) : null}

        <div className="cost-card">
          {selfhost ? (
            <>
              <div className="cost-row">
                <span>Managed per-request (reference, P50)</span>
                <span>{usd(apiPerReq)}</span>
              </div>
              <div className="cost-row">
                <span>GPU time ({fmtInt(calls)} call{calls > 1 ? 's' : ''} ≈ {selfSecs.toFixed(1)} sec)</span>
                <span>{usd(selfCost)}</span>
              </div>
              <div className="cost-row">
                <span>GPU time monthly</span>
                <span>{usd(selfPerRequest * callsPerMonth)}</span>
              </div>
              <div className="cost-row">
                <span>Fixed monthly (idle/storage/egress/ops)</span>
                <span>{usd(fixedMonthly)}</span>
              </div>
            </>
          ) : (
            <>
              <div className="cost-row">
                <span>
                  Input · uncached ({fmtInt(uncachedTokens)})
                </span>
                <span>{usd(uncachedTokens * inputRate)}</span>
              </div>
              <div className="cost-row">
                <span>
                  Input · cached ({fmtInt(cachedTokens)} @ {readRatePerM}/1M)
                </span>
                <span>{usd(cachedTokens * (readRatePerM / 1e6))}</span>
              </div>
              {writeRatePerM != null ? (
                <div className="cost-row">
                  <span>Input · cache writes (first write @ {writeRatePerM}/1M)</span>
                  <span>{usd(cachedTokens * (writeRatePerM / 1e6))}</span>
                </div>
              ) : null}
              <div className="cost-row">
                <span>Output P50 ({fmtInt(eosTokens + outP50 + reasonP50)} tok @ output rate)</span>
                <span>{usd(outputCostP50)}</span>
              </div>
              <div className="cost-row">
                <span>Output P90 ({fmtInt(eosTokens + outP90 + reasonP90)} tok)</span>
                <span>{usd(outputCostP90)}</span>
              </div>
            </>
          )}
          <div className="cost-row total">
            <span>{selfhost ? 'Self-host ~monthly' : 'Estimated cost'}</span>
            <span>{selfhost ? usd(selfMonthly) : usd(totalP50)}</span>
          </div>
          {!selfhost ? (
            <div className="cost-row">
              <span>P90 ("worst real month")</span>
              <span>{usd(totalP90)}</span>
            </div>
          ) : null}
        </div>

        {selfhost ? (
          <div className="price-editor breakeven">
            <div className="price-editor-title">
              API vs self-host — breakeven at ≈ {fmtInt(breakeven)} requests/mo
            </div>
            <table>
              <thead>
                <tr>
                  <th>requests/mo</th>
                  <th>managed</th>
                  <th>self-host</th>
                  <th>Δ</th>
                </tr>
              </thead>
              <tbody>
                {[100, 1000, 10000, 100000].map((n) => {
                  const api = apiPerReq * n;
                  const self = selfPerRequest * n + fixedMonthly;
                  return (
                    <tr key={n}>
                      <td>{fmtInt(n)}</td>
                      <td>{usd(api)}</td>
                      <td>{usd(self)}</td>
                      <td className={self <= api ? 'pos' : ''}>{self <= api ? `${usd(api - self)} cheaper` : `+${usd(self - api)}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="note">
              Utilization is the honest lever: raising it ({utilPct}% now) flattens the self-host line
              without touching any rate card.
            </div>
          </div>
        ) : null}

        <div className="price-editor">
          <div className="price-editor-title">
            Routing — Option A (cheapest) vs Option B (best performance)
          </div>
          <div className="row">
            <button type="button" className="btn" onClick={handleRecommend} disabled={recLoading}>
              {recLoading ? 'Analyzing across providers…' : rec ? 'Re-run across providers' : 'Recommend a model for this task'}
            </button>
          </div>
          {rec ? (
            <div className="rec-table">
              {rec.rows.slice(0, 6).map((r) => {
                const tag =
                  r.model.id === rec.cheapest.model.id
                    ? 'A'
                    : r.model.id === rec.best.model.id
                      ? 'B'
                      : null;
                return (
                  <div key={r.model.id} className={tag ? `rec-row rec-${tag}` : 'rec-row'}>
                    <span className={tag ? `badge badge-${tag}` : 'badge badge-none'}>
                      {tag ?? '·'}
                    </span>
                    <span className="rec-name" title={r.model.provider}>
                      {modelHeadsUp(r.model)}
                      <span className="rec-stars">{QUALITY_STARS(r.quality)}</span>
                      {r.model.vision ? <span className="rec-tag">vision</span> : null}
                      {r.model.reasoning ? <span className="rec-tag">reasoning</span> : null}
                    </span>
                    <span className="rec-cost">
                      {usd(r.cost)}
                      <span className="rec-rate">
                        ${r.rate}/1M in · ${r.model.output}/1M out
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn ghost-btn"
                      onClick={() => setModelId(r.model.id)}
                    >
                      Use
                    </button>
                  </div>
                );
              })}
              {rec.rows.length === 0 ? (
                <div className="note">
                  No candidate model supports vision — add an image-able model or lighten the task.
                </div>
              ) : null}
            </div>
          ) : null}
          {rec ? (
            <div className="note">
              A = cheapest for this exact token mix · B = best quality that can still do the
              task. Rationale — A: cost {usd(rec.rationale.A.observed_value)} vs {rec.rationale.A.threshold}{' '}
              ({rec.rationale.A.evidence_ref}); B: {rec.rationale.B.observed_value} vs{' '}
              {rec.rationale.B.threshold} ({rec.rationale.B.evidence_ref}).
            </div>
          ) : null}
        </div>

        {plan && planSteps.some((s) => s.kind !== 'image') ? (
          <div className="price-editor split">
            <div className="price-editor-title">
              Split routing — per-task model assignment
            </div>
            <div className="steps">
              {splitSteps.map((st, i) => (
                <div key={st.id} className="step-card">
                  <div className="step-kind">{st.kind}</div>
                  <div className="step-body">
                    <div className="step-raw">{st.raw}</div>
                    <div className="step-meta">
                      → <strong>{st.pick.name}</strong> · {usd(st.pick.cost)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="note">
              Reads route to cheap capable models (quality ≥ 2); writes/edits route to quality ≥ 4
              ("assets you can't afford to regenerate"); images always go to gpt-image. Split total{' '}
              <strong>{usd(splitCost)}</strong> vs one-model-everything{' '}
              <strong>{usd(singleRoute.cost)}</strong> ({splitSave > 0 ? `−${splitSave}%` : 'no savings'})
              using {singleRoute.name}.
            </div>
          </div>
        ) : null}

        <div className="price-editor assumptions">
          <div className="price-editor-title">Assumptions — every one editable above</div>
          <table>
            <thead>
              <tr>
                <th>assumption</th>
                <th>value</th>
                <th>provenance</th>
              </tr>
            </thead>
            <tbody>
              {assumptions.map((a) => (
                <tr key={a.label}>
                  <td>{a.label}</td>
                  <td>{a.value}</td>
                  <td>{a.prov}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="note">
          {selfhost
            ? 'Self-hosted costs come from GPU hours, not tokens: to lower the unit cost you raise '
              + 'throughput (utilization, batching, quantization, smaller models) rather than negotiating rates.'
            : `Per ${fmtInt(1_000_000)} input tokens at $${price.input} → ${usd(1e6 * inputRate)}. ` +
              `${TEXT_PROFILES[profile].label} ≈ ${profileTpw} tokens/word for the output estimate. ` +
              'Tokenizers match each provider (o200k/cl100k for OpenAI, Claude BPE for Anthropic); every number above carries its method + confidence.'}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- generate tab

function GenTab() {
  const [genId, setGenId] = useState(GEN_MODELS[0].id);
  const [quality, setQuality] = useState('medium');
  const [size, setSize] = useState('square');
  const [countStr, setCountStr] = useState('1');
  const [prompt, setPrompt] = useState('');
  const [system, setSystem] = useState('');
  const [refs, setRefs] = useState([]);
  const [cached, setCached] = useState(false);
  const [overrides, setOverrides] = useState({});

  const model = GEN_MODELS.find((m) => m.id === genId) ?? GEN_MODELS[0];
  const price = overrides[genId] ?? {
    input: model.input,
    cachedInput: model.cachedInput,
    imageInput: model.imageInput,
    imageOutput: model.imageOutput,
  };
  const setPrice = (key, v) =>
    setOverrides((p) => ({
      ...p,
      [genId]: {
        input: model.input,
        cachedInput: model.cachedInput,
        imageInput: model.imageInput,
        imageOutput: model.imageOutput,
        ...(p[genId] ?? {}),
        [key]: v,
      },
    }));

  const promptCount = useCount(
    async () => {
      const p = prompt.trim() ? countTokensByTokenizer('o200k', prompt) : 0;
      const s = system.trim() ? countTokensByTokenizer('o200k', system) : 0;
      return { prompt: p, system: s };
    },
    prompt + '\u0000' + system,
  );

  const count = Math.max(0, Math.floor(num(countStr)));
  const perImage = model.perImage[quality]?.[size] ?? 0;
  const promptTokens =
    (promptCount.value?.prompt ?? 0) + (promptCount.value?.system ?? 0);
  const refTokens = refs.reduce(
    (a, r) => a + openAIVisionTokens(r.w, r.h, 'auto', IMAGE_INPUT_TILE),
    0,
  );

  const promptCost = promptTokens * ((cached ? price.cachedInput : price.input) / 1e6);
  const refCost = refTokens * (price.imageInput / 1e6);
  const outCost = count * perImage;
  const total = promptCost + refCost + outCost;

  const onFiles = (files) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        setRefs((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            url,
            name: f.name,
            w: img.naturalWidth,
            h: img.naturalHeight,
          },
        ]);
      };
      img.src = url;
    }
  };

  return (
    <div className="tab-body">
      <div className="pane input-pane">
        <ModelPicker modelId={genId} onChange={setGenId} gen />
        <div className="row">
          <Segmented
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
            value={quality}
            onChange={setQuality}
          />
          <Segmented
            options={[
              { value: 'square', label: 'Square 1024²' },
              { value: 'wide', label: 'Portrait / landscape 1024×1536' },
            ]}
            value={size}
            onChange={setSize}
          />
        </div>

        <div className="row">
          <Field label="Number of images">
            <input
              type="number"
              min={0}
              step={1}
              value={countStr}
              onChange={(e) => setCountStr(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Prompt text" hint="o200k_base (OpenAI)">
          <textarea
            rows={5}
            placeholder="Describe the image you want…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        <Field label="System prompt (optional)" hint="counted as input tokens">
          <textarea
            rows={2}
            placeholder="System framing for the generation call…"
            value={system}
            onChange={(e) => setSystem(e.target.value)}
          />
        </Field>

        <div className="field">
          <span className="field-label">Reference / edit image (optional)</span>
          <ImageDrop onFiles={onFiles} />
          {refs.length > 0 ? (
            <div className="img-list">
              {refs.map((r) => (
                <div key={r.id} className="img-row" title={r.name}>
                  <img src={r.url} alt="" className="thumb" />
                  <div className="img-meta">
                    <div className="img-name">
                      {r.name} · {r.w}×{r.h}
                    </div>
                    <div className="img-tokens">
                      ~{fmtInt(openAIVisionTokens(r.w, r.h, 'auto', IMAGE_INPUT_TILE))} image input
                      tokens
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      setRefs((prev) => {
                        const ref = prev.find((x) => x.id === r.id);
                        if (ref) URL.revokeObjectURL(ref.url);
                        return prev.filter((x) => x.id !== r.id);
                      })
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="toggles">
          <Toggle checked={cached} onChange={setCached} label="Bill prompt at cached rate" />
        </div>
      </div>

      <div className="pane results-pane">
        <Disclaimer />
        <PriceEditor model={null} price={price} onChange={setPrice} gen />

        <div className="stats-grid">
          <Stat label="Prompt tokens" value={promptCount.loading ? 'counting…' : fmtInt(promptTokens)} />
          <Stat label="Ref. image tokens" value={fmtInt(refTokens)} />
          <Stat label="Images × count" value={`${count} × ${usd(perImage)}`} />
        </div>

        <div className="cost-card">
          <div className="cost-row">
            <span>Prompt text</span>
            <span>{usd(promptCost)}</span>
          </div>
          <div className="cost-row">
            <span>Reference images</span>
            <span>{usd(refCost)}</span>
          </div>
          <div className="cost-row">
            <span>{fmtInt(count)} × {usd(perImage)}</span>
            <span>{usd(outCost)}</span>
          </div>
          <div className="cost-row total">
            <span>Estimated cost</span>
            <span>{usd(total)}</span>
          </div>
        </div>

        <div className="note">
          Per-image prices are from OpenAI's published rate card at each quality tier. Image / prompt
          tokens billed separately. Output images are measured in tokens (~272 low / ~1056 medium /
          ~4160 high per 1024² image) but billed per-image on the rate card.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- reference tab

const $m = (n) =>
  n == null ? '—' : '$' + (n % 1 ? (n < 1 ? n.toFixed(2) : n.toFixed(1)) : n.toFixed(0));
const $g = (n) => '$' + (n < 1 ? n.toFixed(3) : n % 1 ? n.toFixed(1) : n.toFixed(0));

const VISION_LABEL = {
  claude: (m) => (m.visionTier === 'high' ? 'Claude 2576px tier' : 'Claude 1568px tier'),
  gpt5: () => 'GPT-5.x area budget',
  tile: () => 'GPT-4o tile grid (512px)',
};

const LEGEND = [
  { m: 'EXACT_TOKENIZER', c: 'HIGH', meaning: 'Real count from the provider\'s own BPE/WASM tokenizer, run locally.' },
  { m: 'TOKENIZER×1.30', c: 'MEDIUM', meaning: 'Legacy-tokenizer count scaled by the Opus-4.7+ BPE factor (provider-published ~1.30×).' },
  { m: 'EXACT_PROXY', c: 'LOW', meaning: 'Counted with a stand-in tokenizer (Llama 3 ≈ DeepSeek/Mistral); close, not identical.' },
  { m: 'PROVIDER_FORMULA', c: 'HIGH', meaning: 'Provider-documented image-token formula (tiles / patch grid / area budget).' },
  { m: 'CALIBRATED_HEURISTIC', c: 'LOW', meaning: 'Statistic over task types (tokens/word × words), not an exact measurement.' },
  { m: 'USER_SUPPLIED', c: 'HIGH', meaning: 'You typed it (estimates, overrides, GPU util).' },
  { m: 'DERIVED', c: 'MEDIUM', meaning: 'Computed from the above — confidence inherits the weakest input.' },
  { m: 'UNAVAILABLE', c: '—', meaning: 'No published data; refusing to guess rather than fabricate.' },
];

const FORMULAS = [
  {
    name: 'Claude vision (tile → patch grid)',
    consts: '28px patches; standard tier ≤1568px / 1568 tok, high tier ≤2576px / 4784 tok',
    calc: '⌈w/28⌉ × ⌈h/28⌉, binary-search scaled long edge to stay under the cap',
    source: 'src/lib/images.js → claudeVisionTokens',
  },
  {
    name: 'GPT-4o / 4.1 vision (tile grid)',
    consts: '512px tiles, short side 768, base 85 + 170/tile (low = 85), mini cap 2833',
    calc: 'scale to 2048 edge → 85 + 170 × ⌈w/512⌉ × ⌈h/512⌉',
    source: 'src/lib/images.js → openAIVisionTokens',
  },
  {
    name: 'GPT-image input (reference images)',
    consts: '512px tiles, short side 512, base 65 + 129/tile (low = 65)',
    calc: 'scale to 2048 edge → 65 + 129 × tiles',
    source: 'src/data/models.js → IMAGE_INPUT_TILE',
  },
  {
    name: 'GPT-5.x vision (area budget)',
    consts: 'high: min(2500, area/1024) @2048 · auto: min(10000, area/1024) @6000',
    calc: 'pixels ÷ 1024, capped by budget',
    source: 'src/lib/images.js → gpt5VisionTokens',
  },
  {
    name: 'New-tokenizer estimate (Claude 4.7+)',
    consts: `multiplier ×${CLAUDE_TOKENIZER_MULTIPLIER}`,
    calc: 'legacy Claude BPE count × 1.30',
    source: 'src/data/models.js → CLAUDE_TOKENIZER_MULTIPLIER',
  },
];

function ReferenceTab() {
  const byProvider = [...MODELS].sort((a, b) =>
    a.provider === b.provider ? b.quality - a.quality : a.provider.localeCompare(b.provider),
  );
  const stale =
    new Date(PRICE_META?.asOf ?? '1970-01-01').getTime() < Date.now() - 45 * 864e5;
  return (
    <div className="tab-body ref-tab">
      <div className="pane">
        <div className="price-editor snapshot">
          <div className="price-editor-title">
            Price snapshot · {PRICE_META?.asOf ?? '—'}
            {PRICE_META?.verified ? ' · live-verified' : ' · manual / unverified'}
          </div>
          <div className="snapshot-line">
            Quick start: <code>npm run refresh</code> re-verifies rates against provider pages
            (real token-billed plot). Offline runs still apply the manifest.
          </div>
          {PRICE_META?.sources?.map((s) => (
            <div className="snapshot-source" key={s.url + s.name}>
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.name}
              </a>
              — {s.verified ? 'verified online' : s.reason}
            </div>
          ))}
          {stale ? (
            <div className="note warn">
              Snapshot is older than 45 days — run <code>npm run refresh</code>.
            </div>
          ) : null}
          <div className="note">
            Single source of truth: <code>scripts/rates/rates.json</code> (curated) →{' '}
            <code>src/data/rates.generated.js</code> (auto-generated by{' '}
            <code>scripts/refresh-rates.mjs</code>). Edit the manifest — never the generated file.
            Anything you override in-app lives in memory only.
          </div>
        </div>

        <div className="price-editor">
          <div className="price-editor-title">Chat / text model registry — $ per 1M tokens</div>
          <table>
            <thead>
              <tr>
                <th>model</th>
                <th>in</th>
                <th>out</th>
                <th>cache read</th>
                <th>cache write</th>
                <th>long ctx</th>
                <th>vision</th>
                <th>tok</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {byProvider.map((m) => (
                <tr key={m.id}>
                  <td>
                    <span className="ref-name">
                      {modelHeadsUp(m)} <span className="rec-stars">{QUALITY_STARS(m.quality)}</span>
                    </span>
                    <span className="ref-prov">{m.provider}</span>
                    {m.note ? <span className="ref-note">{m.note}</span> : null}
                    <br />
                    <span className="ref-id">{m.id}</span>
                  </td>
                  <td>{$m(m.input)}</td>
                  <td>{$m(m.output)}</td>
                  <td>{m.cachedInput != null ? $m(m.cachedInput) : '—'}</td>
                  <td>{m.cacheWriteInput != null ? $m(m.cacheWriteInput) : 'n/a'}</td>
                  <td>
                    {m.longThreshold != null
                      ? `>${fmtInt(m.longThreshold)} → ${$m(m.longInput)}/${$m(m.longOutput)}`
                      : '—'}
                  </td>
                  <td>{m.vision ? (VISION_LABEL[m.vision]?.(m) ?? m.vision) : '—'}</td>
                  <td>{m.tokenizer}</td>
                  <td>{m.reasoning ? 'yes' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="note">
            OpenAI rates: true for OpenAI models; Anthropic new-tokenizer models count ×{CLAUDE_TOKENIZER_MULTIPLIER}.
            Cache-write is only priced where the provider publishes it (GPT-6 Astra, $12.50) — never invented.
          </div>
        </div>

        <div className="price-editor">
          <div className="price-editor-title">Image generation (gpt-image) — $ per image</div>
          <table>
            <thead>
              <tr>
                <th>model</th>
                <th>text $/1M</th>
                <th>image input $/1M</th>
                <th>low · sq / wide</th>
                <th>medium · sq / wide</th>
                <th>high · sq / wide</th>
                <th>quality</th>
              </tr>
            </thead>
            <tbody>
              {GEN_MODELS.map((g) => (
                <tr key={g.id}>
                  <td>
                    <span className="ref-name">{g.name}</span>
                    <br />
                    <span className="ref-id">{g.id}</span>
                  </td>
                  <td>{$m(g.input)}</td>
                  <td>{$m(g.imageInput)}</td>
                  <td>
                    {$g(g.perImage.low.square)} / {$g(g.perImage.low.wide)}
                  </td>
                  <td>
                    {$g(g.perImage.medium.square)} / {$g(g.perImage.medium.wide)}
                  </td>
                  <td>
                    {$g(g.perImage.high.square)} / {$g(g.perImage.high.wide)}
                  </td>
                  <td>{'★'.repeat(g.quality)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="note">
            Output images are metered in tokens (~272 low / ~1056 medium / ~4160 high per 1024²) but
            billed per image from the rate card. Image-to-image edits bill the source image(s) as
            image-input tokens first.
          </div>
        </div>

        <div className="price-editor">
          <div className="price-editor-title">Formulas &amp; constants</div>
          <table>
            <thead>
              <tr>
                <th>formula</th>
                <th>constants / tiers</th>
                <th>calculation</th>
                <th>source</th>
              </tr>
            </thead>
            <tbody>
              {FORMULAS.map((f) => (
                <tr key={f.name}>
                  <td className="ref-formula">{f.name}</td>
                  <td>{f.consts}</td>
                  <td>{f.calc}</td>
                  <td className="ref-src">{f.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="note">
            Output-length conversion: {Object.entries(TEXT_PROFILES).map(([k, v]) => `${v.label.split('/')[0].trim()} ${v.tokensPerWord} tok/word`).join(' · ')}. Long-context premium applies on the whole request once context passes {fmtInt(MODELS[0].longThreshold)} tokens.
          </div>
        </div>

        <div className="price-editor">
          <div className="price-editor-title">Self-hosted hardware (VRAM gate)</div>
          <table>
            <thead>
              <tr>
                <th>open model</th>
                <th>params</th>
                <th>layers</th>
                <th>KV heads</th>
                <th>head dim</th>
                <th>fp16 weights</th>
                <th>int4 weights</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(OPEN_ARCH).map(([id, a]) => (
                <tr key={id}>
                  <td className="ref-id">{id}</td>
                  <td>{a.paramsB}B</td>
                  <td>{a.layers}</td>
                  <td>{a.kvHeads}</td>
                  <td>{a.headDim}</td>
                  <td>{a.paramsB * 2} GB</td>
                  <td>{a.paramsB * 0.5} GB</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="note">
            VRAM ≈ weights + KV cache (layers × KV heads × head dim × 2 × bytes/token × tokens) + ~4 GB
            overhead. Quantization bytes: {Object.entries(QUANTIZATION).map(([k, v]) => `${v.label} = ${v.bytes}B`).join(' · ')}.
            Models without a signed arch are marked UNAVAILABLE, never guessed.
          </div>
        </div>

        <div className="price-editor">
          <div className="price-editor-title">Method &amp; confidence legend</div>
          <table>
            <thead>
              <tr>
                <th>method</th>
                <th>confidence</th>
                <th>meaning</th>
              </tr>
            </thead>
            <tbody>
              {LEGEND.map((l) => (
                <tr key={l.m}>
                  <td><span className="tag tag-exact">{l.m}</span></td>
                  <td>{l.c}</td>
                  <td>{l.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="note">
            Every number in the calculator carries one of these — a figure without a method is a bug
            (spec: "refusing to guess is a feature, not a limitation").
          </div>
        </div>

        <div className="note">
          Model structure &amp; architecture (tokenizer, vision, quality, KV layout) live in{' '}
          <code>src/data/models.js</code> and are never overwritten by rate refreshes — only prices
          are overlaid from the manifest. In-app overrides stay in memory until you reload.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- app shell

export default function App() {
  const [tab, setTab] = useState('read');
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <div className="logo">⊘</div>
          <div>
            <h1>LLM Token &amp; Cost Calculator</h1>
            <p>Tokens + true cost for any task — text, reading, editing, and generating images.</p>
          </div>
        </div>
        <Segmented
          options={[
            { value: 'read', label: 'Read / Edit / Illustrate' },
            { value: 'gen', label: 'Generate images' },
            { value: 'ref', label: 'Reference / costing' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </header>
      {tab === 'read' ? <ReadTab /> : tab === 'gen' ? <GenTab /> : <ReferenceTab />}
      <footer>
        Everything runs locally in your browser. Tokenizer packages: gpt-tokenizer,
        @anthropic-ai/tokenizer (WASM), llama-tokenizer-js. Prices reflect the{' '}
        {PRICE_META?.asOf ?? '—'} snapshot
        {PRICE_META?.verified ? ' (verified against provider pages)' : ' (manual — run npm run refresh to verify)'}{' '}
        and are editable. Image counts are estimates, not invoices — use the providers'
        count_tokens endpoints when an exact number matters.
      </footer>
    </div>
  );
}