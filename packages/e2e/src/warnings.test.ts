// /packages/e2e/src/warnings.test.ts
//
// The defect the chain exists to catch, frozen so it cannot grow.
//
// `WarningCode` has 32 members. Eighteen of them are declared and raised NOWHERE in
// production code. That is not laziness in any one module: each module signals in
// its own local shape — `context.ts` returns a `near_threshold` object, `media.ts`
// and `selfhosted.ts` push ad-hoc string arrays, `vision.ts` returns an
// `AssetDisposition` — and nothing translates those into `EstimateOutput.warnings`.
//
// It is invisible to unit tests by construction. Every module is correct against
// its own contract; `context.ts` computes the near-threshold band correctly and has
// a passing test for it, and `NEAR_CONTEXT_TIER_THRESHOLD` still never reaches an
// estimate, so the user never sees a warning whose math is already right.
//
// This file does two things:
//   1. records every unraised code with the reason it is unraised, and fails if a
//      NEW one appears or an old one is quietly fixed without the list being
//      updated — so the enum can no longer grow a member nothing emits;
//   2. proves the surfacing mechanism on one real code, end to end.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Registry, WarningCode, type ModelRow } from '@tokenomics/contracts';
import { parseL1 } from '@tokenomics/parser';
import {
  assembleCandidate,
  assembleEstimate,
  buildLine,
  exactRange,
  selectContextTier,
} from '@tokenomics/estimator';

/* ═══════════════════════ 1. the ledger ═══════════════════════ */

/**
 * Codes nothing raises, and why. Split by whether the module that should raise it
 * EXISTS — a warning for a layer nobody has built is a plan; a warning for a
 * module that is shipping and computing the right answer is a defect.
 */
const NOT_YET_RAISED: Record<string, string> = {
  // ── the layer does not exist yet. Legitimately unraised. ────────────────────
  PRICE_CHANGED_SINCE_LAST_RUN: '§A6 ingestion (backlog 1.3) — needs two runs to compare.',
  RATE_CONFLICT_UNRESOLVED: '§A6 ingestion (backlog 1.3). VERIFY #7 shows a single source can conflict with itself, so this will be reachable sooner than ingestion — but nothing reads `Rate.conflict` yet.',
  PROXY_TOKENIZER_IN_USE: '§A4.5 tier 2 (backlog 1.5) — no proxy tokenizer exists.',
  PROXY_SCRIPT_MISMATCH: '§A4.5 tier 2 (backlog 1.5).',
  PROXY_DRIFT_EXCEEDED: '§A4.5 tier 2 (backlog 1.5).',
  REROUTED_FOR_ASSET_CONSTRAINT: 'The asset-constraint reroute is not built.',
  REROUTE_BLOCKED_BY_RESIDENCY: 'The asset-constraint reroute is not built.',
  HEURISTIC_ON_UNCALIBRATED_SCRIPT: '§A4.5 tier 3 padding is not built; text.ts refuses instead, so there is no padded heuristic to warn about.',

  // ── unreachable by construction. Not a defect, and not fixable by emitting it. ──
  CACHE_KEY_MISSING_TOKENIZER_REVISION:
    'UNREACHABLE. `EstimateLine` REJECTS a cache outcome whose key omits the tokenizer revision — a ZodError, not a warning — so the data can never exist to warn about. Prevention beats notification, which makes this enum member dead weight rather than a gap. Remove it or keep it documented; do not "fix" it by emitting it somewhere it cannot fire.',
};

function productionSources(): string {
  const root = join(__dirname, '..', '..', '..');
  const files = execSync("git ls-files 'packages/*/src/*.ts'", { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.endsWith('.test.ts'));
  const all = files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
  // ⚠️ Strip the enum's own declaration before searching. Every member appears
  // there as a quoted string, so a naive scan reports all 32 as raised and the
  // ledger below silently passes — which is precisely the failure this file is
  // written to prevent, and it happened on the first run. Excluding the whole of
  // `estimate.ts` would be the blunter fix; this removes only the declaration.
  const start = all.indexOf('export const WarningCode = z.enum([');
  if (start === -1) throw new Error('WarningCode declaration not found — this scan is now lying.');
  const end = all.indexOf(']);', start);
  return all.slice(0, start) + all.slice(end);
}

describe('every WarningCode is raised, or recorded as not raised and why', () => {
  const sources = productionSources();
  const codes = WarningCode.options as readonly string[];
  const raised = (c: string) => sources.includes(`'${c}'`) || sources.includes(`"${c}"`);

  it('no code is unraised without a written reason', () => {
    const silent = codes.filter((c) => !raised(c) && !(c in NOT_YET_RAISED));
    expect(
      silent,
      'A WarningCode nothing emits is a warning the user never sees. Raise it, or add it to NOT_YET_RAISED with the reason.',
    ).toEqual([]);
  });

  it('no reason outlives the defect it describes', () => {
    const fixed = Object.keys(NOT_YET_RAISED).filter((c) => raised(c));
    expect(
      fixed,
      'These are now raised in production code. Delete their NOT_YET_RAISED entries — a ledger that only grows stops being a ledger.',
    ).toEqual([]);
  });

  it('every recorded code is actually a member of the enum', () => {
    const unknown = Object.keys(NOT_YET_RAISED).filter((c) => !codes.includes(c));
    expect(unknown, 'NOT_YET_RAISED names a code the enum does not have.').toEqual([]);
  });

  it('the ledger is 9 of 36, and that ratio is the point', () => {
    // Not a vanity assertion. If this number moves without somebody editing the
    // list above, the enum grew a member nothing emits — the exact way the
    // original eighteen accumulated.
    //
    // History, because the shape of the fix is the useful part: §A11 found 18 of 32
    // unraised. Nine were layers nobody had built. Of the nine that were defects,
    // eight are now raised — VISUAL_TOKENS_DOMINATE_CONTEXT (#20), six in #21, and
    // the §A12 media guard (#22) — and one turned out to be unreachable because the
    // contract refuses the data outright. The enum grew to 35 when #20 gave the
    // three cache conditions codes they had never had, and to 36 when MODEL_DEPRECATED
    // was added for a model that is still callable but has an announced shutdown.
    // §A5.4's capture path raised CALIBRATION_SAMPLE_TOO_SMALL — the prior builder
    // says how many samples stand behind a LOW prior, which was the layer that had
    // not been built.
    expect(Object.keys(NOT_YET_RAISED)).toHaveLength(9);
    expect(codes).toHaveLength(36);
  });
});

/* ═══════════ 2. the mechanism, proven on one real code ═══════════ */

const REGISTRY_PATH = join(__dirname, '..', '..', '..', 'registry', 'registry.json');
const registry = Registry.parse(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')));
const gemini: ModelRow = registry.models.find((m) => m.model_id === 'gemini-2.5-pro')!;

describe('a module signal reaches EstimateOutput.warnings', () => {
  const SEED = [
    { doc_class: 'long_form' as const, input_tokens: 190_000, output_tokens: 2_000, image_width_px: null, image_height_px: null, image_detail: null, source: 'USER_SUPPLIED_BASELINE' as const },
  ];

  it('NEAR_CONTEXT_TIER_THRESHOLD survives the trip from context.ts to the estimate', () => {
    const tiers = gemini.text_rates[0]!.context_tiers!;
    const selected = selectContextTier(tiers, 195_000);
    if (selected.status !== 'SELECTED') throw new Error(selected.status);

    // The band is real and the module got it right — this is the assertion that
    // already passes inside the estimator's own suite.
    expect(selected.near_threshold).not.toBeNull();
    expect(selected.near_threshold!.upper_bound_tokens).toBe(200_000);

    // …and this is the part nothing in the estimator does. The translation lives
    // at the seam, which is why no unit test could have caught its absence.
    const line = buildLine({
      task_id: 't1',
      component: 'prompt_input',
      quantity: exactRange(195_000),
      unit: 'tokens',
      rate_amount: selected.input_rate.amount / 1_000_000,
      rate_record_id: 'gemini-2.5-pro:input:tier0',
      method: 'PROVIDER_FORMULA',
      confidence: 'HIGH',
    });
    const parsed = parseL1({ text: 'summarize the report', seed: SEED });
    if (parsed.status !== 'PARSED') throw new Error(parsed.reason);

    const estimate = assembleEstimate({
      estimate_id: 'e-near',
      generated_at: '2026-09-09T00:00:00.000Z',
      pricing_snapshot_id: 'snap-1',
      workflow: parsed.workflow,
      candidates: [
        assembleCandidate({
          model_id: gemini.model_id,
          provider_id: gemini.provider,
          deployment_mode: 'API_MANAGED',
          currency: 'USD',
          lines: [line],
        }),
      ],
      evidence: [],
      warnings: [{
        code: 'NEAR_CONTEXT_TIER_THRESHOLD',
        message: `${selected.near_threshold!.headroom_tokens} tokens of headroom before the ${selected.near_threshold!.upper_bound_tokens}-token tier, where the WHOLE prompt reprices.`,
        severity: 'WARN',
      }],
    });

    const codes = estimate.warnings.map((w) => w.code);
    expect(codes).toContain('NEAR_CONTEXT_TIER_THRESHOLD');
    // A WARN does not force review; only BLOCKING and a blocking gap do.
    expect(estimate.warnings.find((w) => w.code === 'NEAR_CONTEXT_TIER_THRESHOLD')!.severity).toBe('WARN');
  });
});
