// /packages/calibrate/src/priors.ts
//
// §A5.4 — "each prior calibrated from observed runs, not invented." This is the
// only function that makes an `OutputPrior`, and it makes one from samples and
// from nothing else. There is no seed path here; a seed is `SEED_UNCALIBRATED` +
// LOW by contract and it enters through `defaults_seed`, not through this file.
//
// Pure. Takes the samples, returns the priors; the runner does the file I/O.

import {
  OutputPrior,
  type EstimateWarning,
  type OutputBand,
  type OutputSample,
} from '@tokenomics/contracts';

export interface BuildPriorsOptions {
  /**
   * Below this many samples a prior is LOW and raises CALIBRATION_SAMPLE_TOO_SMALL;
   * at or above it, MEDIUM — never HIGH, because a distribution measured on one
   * workload is a calibrated table, not a provider fact (`CALIBRATED_HEURISTIC`).
   *
   * Required, with no default. §A4.1 sets 200 as the minimum for the text corpus
   * buckets and says nothing about output priors; the operator chooses the figure
   * per run rather than inheriting one the spec did not state for this table.
   */
  min_samples: number;
  /** When the table was built. Injected — this package has no clock. */
  now: string;
}

export interface BuildPriorsResult {
  priors: OutputPrior[];
  warnings: EstimateWarning[];
  /** Groups that could not become a prior, and why. Never silently dropped. */
  refused: Array<{ model_id: string; band: OutputBand; reason: string }>;
  /** Samples set aside as duplicates of an earlier one with the same response_id. */
  duplicates: number;
}

const PERCENT = 100;
const P50 = 50;
const P90 = 90;

/**
 * Nearest-rank percentile on ascending values: the value at position
 * ceil(p/100 × n), 1-based. No interpolation — an interpolated percentile is a
 * value no response produced, and with small n it is mostly the interpolation.
 */
export function nearestRank(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) throw new Error('nearestRank on an empty sample.');
  const rank = Math.ceil((p / PERCENT) * sortedAsc.length);
  return sortedAsc[Math.max(1, rank) - 1]!;
}

const groupKey = (s: OutputSample): string => `${s.model_id}|${s.band}`;

export function buildOutputPriors(
  samples: readonly OutputSample[],
  opts: BuildPriorsOptions,
): BuildPriorsResult {
  if (!Number.isInteger(opts.min_samples) || opts.min_samples < 1) {
    throw new Error(`min_samples must be a positive integer; got ${opts.min_samples}.`);
  }

  // Dedupe on response_id where one was captured. Two samples with null ids are
  // two responses as far as anyone can tell.
  const seen = new Set<string>();
  let duplicates = 0;
  const kept: OutputSample[] = [];
  for (const s of samples) {
    if (s.response_id !== null) {
      const id = `${s.provider}|${s.response_id}`;
      if (seen.has(id)) { duplicates++; continue; }
      seen.add(id);
    }
    kept.push(s);
  }

  const groups = new Map<string, OutputSample[]>();
  for (const s of kept) {
    const k = groupKey(s);
    const g = groups.get(k);
    if (g) g.push(s); else groups.set(k, [s]);
  }

  const result: BuildPriorsResult = { priors: [], warnings: [], refused: [], duplicates };

  for (const [, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const { model_id, band } = g[0]!;
    const providers = new Set(g.map((s) => s.provider));
    if (providers.size > 1) {
      result.refused.push({ model_id, band, reason: `samples name ${providers.size} providers (${[...providers].join(', ')}) for one model — a mixed group is a mapping error, not a distribution` });
      continue;
    }

    const visible = g.map((s) => s.visible_output_tokens).sort((a, b) => a - b);
    const output_tokens = { p50: nearestRank(visible, P50), p90: nearestRank(visible, P90) };
    if (band === 'unbounded' && output_tokens.p90 === output_tokens.p50) {
      result.refused.push({ model_id, band, reason: `${g.length} sample(s) give a zero-width distribution (p50 = p90 = ${output_tokens.p50}); an unbounded band needs spread the samples do not show yet` });
      continue;
    }

    // Reasoning: a distribution only when EVERY sample reported the figure. One
    // unknown makes the whole term unknown — a partial reasoning distribution
    // understates in the direction the bill grows.
    const withReasoning = g.filter((s) => s.reasoning_tokens !== null);
    let reasoning_tokens: { p50: number; p90: number } | null = null;
    const notes: string[] = [];
    if (withReasoning.length === g.length) {
      const r = withReasoning.map((s) => s.reasoning_tokens as number).sort((a, b) => a - b);
      reasoning_tokens = { p50: nearestRank(r, P50), p90: nearestRank(r, P90) };
    } else {
      notes.push(`${g.length - withReasoning.length} of ${g.length} samples reported no reasoning figure; reasoning distribution withheld rather than built from the rest.`);
    }

    const tooSmall = g.length < opts.min_samples;
    if (tooSmall) {
      result.warnings.push({
        code: 'CALIBRATION_SAMPLE_TOO_SMALL',
        message: `${model_id} "${band}": ${g.length} sample(s) behind this prior, below the ${opts.min_samples} required for MEDIUM. It is LOW until more observed runs replace it.`,
        severity: 'WARN',
      });
    }

    const urls = [...new Set(g.map((s) => s.provenance.source_url).filter((u): u is string => u !== null))];
    if (urls.length > 1) notes.push(`samples cite ${urls.length} references; the first is recorded.`);

    result.priors.push(
      OutputPrior.parse({
        model_id,
        band,
        output_tokens,
        reasoning_tokens,
        n_samples: g.length,
        seed_provenance: 'CALIBRATED_FROM_OBSERVED',
        provenance: {
          method: 'CALIBRATED_HEURISTIC',
          confidence: tooSmall ? 'LOW' : 'MEDIUM',
          source_class: 'MEASURED',
          source_url: urls[0] ?? null,
          verified_at: opts.now,
          verified_by: null,
          notes: notes.length ? notes.join(' ') : null,
        },
      }),
    );
  }
  return result;
}
