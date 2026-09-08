// /packages/tokenizers/src/cache.ts
//
// §A4.5 tier 0 — "check the cache before spending a call".
//
// The whole content of this file is the CACHE KEY, and the key is the part that is
// easy to get wrong in a way nothing detects.
//
// A count is not a property of the text. Anthropic's own documentation says newer
// models "use a tokenizer producing ~30% more tokens than earlier models for the
// same content" and instructs you to "always count against the specific model you
// plan to use". A cache keyed on the content hash alone would serve one model's
// count for another model's request and be wrong by roughly a third — consistently,
// in one direction, on every hit. That is the failure mode §A4.5.3 already warns
// about for proxy tokenizers, arriving through the back door.
//
// So the key is (model_id, request fingerprint), and `model_id` is not optional.
//
// The second rule: a cached value keeps the tier and method it was STORED with.
// §A4.5 is explicit that a cached tier-3 heuristic is still a tier-3 heuristic. It
// does not become tier 0 by having been remembered — tier 0 describes where the
// answer was fetched from, not how it was produced, and re-tagging it would let a
// guessed number acquire a provider's confidence by sitting in a map.

import type { Confidence, Method } from '@tokenomics/contracts';

export interface CachedCount {
  tokens: number;
  /** The method that PRODUCED the number, carried through unchanged. */
  method: Method;
  confidence: Confidence;
  /** The tier that produced it. Never rewritten to 0 on the way out. */
  tier: 0 | 1 | 2 | 3;
  covers: 'PROMPT_ONLY' | 'WHOLE_REQUEST';
  note: string | null;
  stored_at: string;
}

export interface CountCacheKey {
  /** Required. See the header — omitting it is a ~30% error across generations. */
  model_id: string;
  /** A stable fingerprint of the exact request that was counted. */
  fingerprint: string;
}

export const cacheKey = (k: CountCacheKey): string => `${k.model_id} ${k.fingerprint}`;

/**
 * A deliberately boring in-memory store.
 *
 * No eviction policy and no TTL, because neither can be chosen honestly here: a
 * count for a fixed (model, request) pair does not go stale on a clock, it goes
 * stale when the vendor changes the tokenizer — and that is a registry event, not a
 * timer. Whoever wires this to a persistent store owns the invalidation.
 */
export class CountCache {
  private readonly map = new Map<string, CachedCount>();

  get(k: CountCacheKey): CachedCount | null {
    return this.map.get(cacheKey(k)) ?? null;
  }

  set(k: CountCacheKey, v: CachedCount): void {
    this.map.set(cacheKey(k), v);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * A fingerprint of the request as it will be sent.
 *
 * Order-sensitive on purpose: two message arrays with the same items in a different
 * order are different prompts and tokenize differently. Key order within an object
 * is normalized, because that is a serialization artifact rather than a difference
 * in the request.
 */
export function fingerprint(value: unknown): string {
  return hash(stableStringify(value));
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`;
}

/**
 * FNV-1a, 64-bit, as hex.
 *
 * Not cryptographic and not trying to be — this is a cache key for content the
 * caller already holds, so a collision costs a wrong count rather than a security
 * property, and 64 bits is far past what a per-session prompt cache will exercise.
 * Named here so nobody later mistakes it for a content-addressed store.
 */
function hash(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i += 1) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}
