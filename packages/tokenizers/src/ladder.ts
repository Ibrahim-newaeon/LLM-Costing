// /packages/tokenizers/src/ladder.ts
//
// §A4.5 — walking the tiers, and reporting which one actually answered.
//
// Project rule 4: "every number carries method + confidence describing the tier
// that ACTUALLY produced it — never the tier requested." That sentence is the whole
// reason this function exists rather than each caller writing its own try/fallback:
// a ladder written inline is one where the eventual answer gets labelled with the
// tier somebody hoped for.
//
// For Anthropic the ladder is 0 -> 1 -> 3. There is no tier 2: the model has no
// local tokenizer, so there is nothing to fall back to between the count endpoint
// and the calibrated heuristic. That gap is the reason a failed tier-1 call is a
// real event for this provider rather than a minor slowdown — it drops two rungs.

import type { Confidence, EstimateWarning, Method } from '@tokenomics/contracts';
import { CountCache, fingerprint, type CachedCount } from './cache';
import {
  countTokensAnthropic,
  type CountTokensInput,
  type CountTokensOptions,
} from './anthropic';

export interface LadderResult {
  /** Where the answer came from THIS time. 0 means it was already known. */
  served_from: 0 | 1;
  tokens: number;
  method: Method;
  confidence: Confidence;
  /** The tier that PRODUCED the number, which is not always `served_from`. */
  tier: 0 | 1 | 2 | 3;
  covers: 'PROMPT_ONLY' | 'WHOLE_REQUEST';
  note: string | null;
}

export interface LadderFailure {
  status: 'FELL_THROUGH';
  /** Why tier 1 did not answer, verbatim, so the caller can decide about retrying. */
  reason: string;
  retryable: boolean;
  /**
   * §A11 found this one. Falling through is the CORRECT behaviour and had a passing
   * test — but it was silent, so an estimate that quietly dropped a rung looked
   * exactly like one that never needed it. §A12 asks for the tier actually used to
   * be re-tagged AND for ESCALATION_FAILED to be raised; only the first half was true.
   */
  warnings: EstimateWarning[];
}

export type LadderOutcome = ({ status: 'OK' } & LadderResult) | LadderFailure;

export interface LadderOptions extends CountTokensOptions {
  cache?: CountCache;
}

/**
 * Tier 0, then tier 1. Never tier 3 — that is the estimator's job and it needs
 * calibration data this package does not have.
 *
 * A miss returns `FELL_THROUGH` rather than a number, so the caller passes no
 * `exact` to `countTextTokens` and the heuristic runs with its own lower
 * confidence. Silently substituting anything here would be rule 4's exact
 * violation: an answer labelled with the tier that was asked for.
 */
export async function countWithLadder(
  input: CountTokensInput,
  opts: LadderOptions,
): Promise<LadderOutcome> {
  const key = { model_id: input.model_id, fingerprint: fingerprint(requestShape(input)) };

  const cached = opts.cache?.get(key) ?? null;
  if (cached !== null) {
    return {
      status: 'OK',
      served_from: 0,
      tokens: cached.tokens,
      // Carried through unchanged. A cached tier-1 count is still tier 1; a cached
      // tier-3 heuristic is still tier 3. Tier 0 says where it was FETCHED from.
      method: cached.method,
      confidence: cached.confidence,
      tier: cached.tier,
      covers: cached.covers,
      note: cached.note,
    };
  }

  const counted = await countTokensAnthropic(input, opts);
  if (counted.status === 'UNAVAILABLE') {
    return {
      status: 'FELL_THROUGH',
      reason: counted.reason,
      retryable: counted.retryable,
      warnings: [{
        code: 'ESCALATION_FAILED',
        message: `Tier 1 did not answer, so the count falls to the estimator's own heuristic at its lower confidence. ${counted.reason}`,
        severity: 'WARN',
      }],
    };
  }

  const entry: CachedCount = {
    tokens: counted.tokens,
    method: counted.method,
    confidence: counted.confidence,
    tier: counted.tier,
    covers: counted.covers,
    note: counted.note,
    stored_at: counted.verified_at,
  };
  opts.cache?.set(key, entry);

  return {
    status: 'OK',
    served_from: 1,
    tokens: entry.tokens,
    method: entry.method,
    confidence: entry.confidence,
    tier: entry.tier,
    covers: entry.covers,
    note: entry.note,
  };
}

/**
 * The parts of the input that change the count.
 *
 * `thinking` is in here deliberately: the vendor documents thinking blocks as
 * counted, so two otherwise identical requests with different thinking
 * configuration are different counts and must not share a cache entry.
 */
const requestShape = (i: CountTokensInput) => ({
  messages: i.messages,
  system: i.system ?? null,
  tools: i.tools ?? null,
  thinking: i.thinking ?? null,
});
