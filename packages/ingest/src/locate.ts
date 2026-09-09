// /packages/ingest/src/locate.ts
//
// Which `Rate` on a registry row a `RateKey` names. One function, used by both
// the comparison (read) and the apply step (write), so the two cannot disagree
// about where a figure lives.

import type { ModelRow, Rate, RateKey, TextRateProfile } from '@tokenomics/contracts';

export type Located =
  | { status: 'FOUND'; rate: Rate; path: string }
  /** The row has the slot and it is empty — the registry never sourced this figure. */
  | { status: 'UNSOURCED'; path: string }
  /** The row has no such slot at all — no profile for the variant, no tier at that boundary. */
  | { status: 'NO_SLOT'; reason: string };

export function locateRate(row: ModelRow, key: RateKey): Located {
  const profile = row.text_rates.find((t) => t.variant === key.variant);
  if (!profile) {
    return { status: 'NO_SLOT', reason: `no text_rates profile with variant "${key.variant}"` };
  }
  const base = `text_rates[${key.variant}]`;

  if (key.above_tokens !== null) return locateInTier(profile, key, base);

  switch (key.direction) {
    case 'input': {
      const modality = key.modality ?? 'text';
      const r = profile.input_rate_by_modality[modality];
      const path = `${base}.input_rate_by_modality.${modality}`;
      return r ? { status: 'FOUND', rate: r, path } : { status: 'UNSOURCED', path };
    }
    case 'output':
      return { status: 'FOUND', rate: profile.output_rate, path: `${base}.output_rate` };
    case 'reasoning_output': {
      const path = `${base}.reasoning_output_rate`;
      return profile.reasoning_output_rate
        ? { status: 'FOUND', rate: profile.reasoning_output_rate, path }
        : { status: 'UNSOURCED', path };
    }
    case 'cache_write':
    case 'cache_read': {
      const path = `${base}.cache.${key.direction === 'cache_write' ? 'write_rate' : 'read_rate'}`;
      if (!profile.cache) return { status: 'UNSOURCED', path };
      const r = key.direction === 'cache_write' ? profile.cache.write_rate : profile.cache.read_rate;
      return r ? { status: 'FOUND', rate: r, path } : { status: 'UNSOURCED', path };
    }
  }
}

/**
 * A source says "above N tokens"; the registry says "up to N tokens" per tier
 * (§A5.7 `upper_bound_tokens`). The tier that applies above N is the one AFTER the
 * tier whose upper bound is N — so a boundary the registry does not draw is a
 * missing slot, not a near miss to be rounded to the closest tier.
 */
function locateInTier(profile: TextRateProfile, key: RateKey, base: string): Located {
  const tiers = profile.context_tiers;
  if (!tiers || tiers.length === 0) {
    return { status: 'NO_SLOT', reason: `row has no context tiers; source states a rate above ${key.above_tokens} tokens` };
  }
  const idx = tiers.findIndex((t) => t.upper_bound_tokens === key.above_tokens);
  if (idx === -1 || idx + 1 >= tiers.length) {
    return { status: 'NO_SLOT', reason: `row draws no tier boundary at ${key.above_tokens} tokens` };
  }
  const tier = tiers[idx + 1]!;
  const path = `${base}.context_tiers[${idx + 1}]`;
  switch (key.direction) {
    case 'input':
      return { status: 'FOUND', rate: tier.input_rate, path: `${path}.input_rate` };
    case 'output':
      return { status: 'FOUND', rate: tier.output_rate, path: `${path}.output_rate` };
    case 'cache_read':
      return tier.cache_read_rate
        ? { status: 'FOUND', rate: tier.cache_read_rate, path: `${path}.cache_read_rate` }
        : { status: 'UNSOURCED', path: `${path}.cache_read_rate` };
    default:
      return { status: 'NO_SLOT', reason: `a context tier carries no ${key.direction} rate` };
  }
}
