// /packages/estimator/src/cache.ts
//
// Prompt caching (§A5.6) and the storage term §A5.10 added (§A5.10).
//
//   effective_input_cost =
//       cached_tokens   * cache_read_rate
//     + cache_write     * cache_write_rate
//     + uncached_tokens * standard_input_rate
//
// Two things this file refuses to do quietly.
//
// `cache_hit_ratio` is a user-editable ASSUMPTION, "defaulted per workflow shape …
// never silently set to a flattering number". So it is a required input here and it
// comes back as a labelled `Assumption` the caller must surface. A hit ratio nobody
// chose is the easiest way to make caching look free.
//
// And a cache can LOSE money. At least one provider bills cached content by the
// hour whether or not you call the model, so a long-lived cache on a low-traffic
// workload can cost more than it saves. Every cache model in this spec before v2.0
// assumed write-plus-read only; the estimator has to be able to show the loss.

import {
  minConfidence,
  type Assumption,
  type CacheProfile,
  type Confidence,
  type Rate,
  type EstimateWarning,
} from '@tokenomics/contracts';

export interface CacheInput {
  profile: CacheProfile;
  /** The standard (uncached) input rate, for the same unit and currency. */
  input_rate: Rate;
  /** Tokens in the reusable prefix — the part a cache could hold. */
  prefix_tokens: number;
  /** Tokens that vary per call and can never be cached. */
  variable_tokens: number;
  /** Assumed share of calls that hit a warm cache. 0..1, and it must be a choice. */
  hit_ratio: number;
  /** Why that ratio — "fixed system prompt + tools", "one-shot varied prompts". */
  hit_ratio_basis: string;
  calls: number;
  /** Wall-clock hours the cache is held, for providers that bill storage. */
  hours_cached?: number;
}

export interface CacheEvaluation {
  status: 'EVALUATED';
  /** Cost of the input side WITH caching, over `calls` calls. */
  cached_cost: number;
  /** Cost of the same input side with no caching at all. */
  uncached_cost: number;
  /** Positive = caching wins. Negative = it costs more than it saves. */
  net_saving: number;
  breakdown: {
    reads: number;
    writes: number;
    storage: number;
    uncacheable: number;
  };
  /** True where the storage term alone exceeds the read saving. */
  storage_dominates: boolean;
  assumptions: Assumption[];
  confidence: Confidence;
  warnings: EstimateWarning[];
}

export type CacheResult =
  | CacheEvaluation
  | { status: 'NOT_CACHEABLE'; reason: string }
  | { status: 'UNAVAILABLE'; reason: string };

export function evaluateCache(input: CacheInput): CacheResult {
  const { profile, input_rate, prefix_tokens, variable_tokens, hit_ratio, calls } = input;

  if (hit_ratio < 0 || hit_ratio > 1) {
    return { status: 'UNAVAILABLE', reason: 'hit_ratio must be between 0 and 1.' };
  }
  if (calls < 0 || prefix_tokens < 0 || variable_tokens < 0) {
    return { status: 'UNAVAILABLE', reason: 'calls and token counts must be >= 0.' };
  }
  if (input.hit_ratio_basis.trim() === '') {
    return {
      status: 'UNAVAILABLE',
      reason:
        'hit_ratio requires a stated basis. It is an assumption the user can edit, and an ' +
        'unexplained one is indistinguishable from a flattering default (§A5.6).',
    };
  }

  const minCacheable = profile.min_cacheable_tokens;
  if (minCacheable.value !== null && prefix_tokens < minCacheable.value) {
    return {
      status: 'NOT_CACHEABLE',
      reason:
        `The reusable prefix is ${prefix_tokens} tokens, below this provider's ` +
        `${minCacheable.value}-token minimum. Nothing is cached, so nothing is saved.`,
    };
  }

  const read = profile.read_rate;
  const write = profile.write_rate;
  if (read === null || write === null) {
    return {
      status: 'UNAVAILABLE',
      reason:
        'Cache read and write rates are unpublished for this model. A null rate is UNKNOWN and ' +
        'blocks the estimate; it is not zero, and it does not mean caching is free (rule 1).',
    };
  }
  if (
    read.unit !== input_rate.unit ||
    write.unit !== input_rate.unit ||
    read.list_currency !== input_rate.list_currency ||
    write.list_currency !== input_rate.list_currency
  ) {
    return {
      status: 'UNAVAILABLE',
      reason:
        'Cache rates are quoted in a different unit or currency from the input rate. Comparing ' +
        'them without conversion would be arithmetic on unlike quantities.',
    };
  }

  const warnings: EstimateWarning[] = [];
  const confidences: Confidence[] = [
    read.provenance.confidence,
    write.provenance.confidence,
    input_rate.provenance.confidence,
    minCacheable.provenance.confidence,
  ];

  const hits = calls * hit_ratio;
  const misses = calls - hits;

  // A miss writes the cache; a hit reads it. Providers differ on whether a write
  // costs a premium over the base input rate — several do.
  const reads = hits * prefix_tokens * read.amount;
  const writes = misses * prefix_tokens * write.amount;
  const uncacheable = calls * variable_tokens * input_rate.amount;

  let storage = 0;
  const storageRate = profile.storage_rate_per_hour;
  if (storageRate !== null) {
    const hours = input.hours_cached;
    if (hours === undefined) {
      return {
        status: 'UNAVAILABLE',
        reason:
          'This provider bills cached content by the hour, so hours_cached is required. Omitting ' +
          'it would silently price a storage term at zero and make caching look unconditionally good.',
      };
    }
    if (storageRate.unit !== input_rate.unit || storageRate.list_currency !== input_rate.list_currency) {
      return { status: 'UNAVAILABLE', reason: 'Cache storage rate is in an incompatible unit or currency.' };
    }
    storage = hours * prefix_tokens * storageRate.amount;
    confidences.push(storageRate.provenance.confidence);
  }

  const cachedCost = reads + writes + storage + uncacheable;
  const uncachedCost = calls * (prefix_tokens + variable_tokens) * input_rate.amount;
  const netSaving = uncachedCost - cachedCost;

  const readSaving = hits * prefix_tokens * (input_rate.amount - read.amount);
  const storageDominates = storage > readSaving && storage > 0;

  if (netSaving < 0) {
    warnings.push({
      code: 'CACHE_NET_LOSS',
      message:
        `Caching COSTS ${(-netSaving).toFixed(6)} more than it saves at a ${hit_ratio} hit ratio. ` +
        'The write premium and storage are not recovered at this call volume.',
      severity: 'WARN',
    });
  }
  if (storageDominates) {
    warnings.push({
      code: 'CACHE_STORAGE_DOMINATES',
      message:
        'The hourly storage charge exceeds the read saving. A long-lived cache on a low-traffic ' +
        'workload is a net loss, and this is the case the pre-v2.0 cache model could not express.',
      severity: 'WARN',
    });
  }
  if (write.amount > input_rate.amount) {
    warnings.push({
      code: 'CACHE_WRITE_PREMIUM',
      message:
        `This provider charges a PREMIUM to write the cache (${write.amount} vs ${input_rate.amount} ` +
        'base input). A low hit ratio makes caching actively worse than not caching.',
      severity: 'WARN',
    });
  }

  const assumptions: Assumption[] = [
    {
      id: 'cache_hit_ratio',
      task_id: null,
      field: 'cache_hit_ratio',
      value: hit_ratio,
      basis: input.hit_ratio_basis,
      seed_provenance: null,
      // The whole result flips sign on this number, so it is never cosmetic.
      impact_if_wrong: 'HIGH',
      user_editable: true,
      sensitivity_rank: null,
    },
  ];

  return {
    status: 'EVALUATED',
    cached_cost: cachedCost,
    uncached_cost: uncachedCost,
    net_saving: netSaving,
    breakdown: { reads, writes, storage, uncacheable },
    storage_dominates: storageDominates,
    assumptions,
    confidence: minConfidence(...confidences),
    warnings,
  };
}
