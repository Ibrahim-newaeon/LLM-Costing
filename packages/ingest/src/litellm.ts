// /packages/ingest/src/litellm.ts
//
// §A4.2 Tier A, first source — LiteLLM's `model_prices_and_context_window.json`.
// An AGGREGATOR: every observation it yields is capped at MEDIUM by the contract
// (§A3.8), and nothing here writes to the registry. It produces Observations; the
// comparison decides what they mean against the vendor-sourced row.
//
// Two things are deliberately NOT done here:
//
//   - No key is guessed. LiteLLM carries the same product under many keys —
//     `claude-opus-5`, `anthropic.claude-opus-5` (Bedrock), `vertex_ai/claude-opus-5`,
//     `openrouter/anthropic/claude-opus-5` — at different prices, because they are
//     different routes. Which key describes the registry row is a decision with a
//     reason, supplied by the caller as data.
//   - No unit is converted. LiteLLM quotes per token; the observation says so.
//     The comparison normalizes explicitly.

import { z } from 'zod';
import {
  Observation,
  confidenceCeiling,
  type Provenance,
  type Snapshot,
  type RateKey,
} from '@tokenomics/contracts';

/** Registry model_id → the one LiteLLM key that describes the same product, and why. */
export const LiteLLMKeyMap = z.record(
  z.string().min(1),
  z.object({ key: z.string().min(1), reason: z.string().min(1) }),
);
export type LiteLLMKeyMap = z.infer<typeof LiteLLMKeyMap>;

/**
 * The fields read. Loose: LiteLLM entries carry dozens of capability flags this
 * adapter has no opinion on, and refusing an entry for an unknown key would make
 * every upstream addition a red build. What IS refused is a known field with the
 * wrong shape — a cost that is not a number is not a cost.
 */
const LiteLLMEntry = z.looseObject({
  litellm_provider: z.string().optional(),
  input_cost_per_token: z.number().nonnegative().optional(),
  output_cost_per_token: z.number().nonnegative().optional(),
  cache_creation_input_token_cost: z.number().nonnegative().optional(),
  cache_read_input_token_cost: z.number().nonnegative().optional(),
  input_cost_per_audio_token: z.number().nonnegative().optional(),
  max_input_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  /** LiteLLM writes a bare date. */
  deprecation_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** LiteLLM's own note of where IT read the figure. Kept as a lead, not as our source. */
  source: z.string().optional(),
});
type LiteLLMEntry = z.infer<typeof LiteLLMEntry>;

/**
 * Context-tier fields are keyed by name: `input_cost_per_token_above_200k_tokens`.
 * Read by pattern so a source that adds a 128k or 1m boundary needs no code change.
 */
const ABOVE = /^(input|output|cache_read_input|cache_creation_input)_(?:cost_per_token|token_cost)_above_(\d+)k_tokens$/;
const TOKENS_PER_K = 1000;

export interface LiteLLMExtractInput {
  body: string;
  snapshot: Snapshot;
  keys: LiteLLMKeyMap;
  /**
   * The currency the feed quotes in. Not read from the feed, which does not state
   * it per entry; supplied by the caller with the rest of the source config, so
   * the claim has an owner.
   */
  currency: string;
}

export interface LiteLLMExtractResult {
  observations: Observation[];
  /** Mapped keys the feed no longer carries — the earliest signal of a withdrawal. */
  missing: Array<{ model_id: string; key: string }>;
  /** Entries present but not readable against the shape above. Reported, not skipped silently. */
  malformed: Array<{ model_id: string; key: string; issue: string }>;
}

/**
 * Read the feed for the mapped models only.
 *
 * Throws when the body is not a JSON object at all: §A4.2 says validate every
 * ingested aggregator document before it touches anything, and a feed that is not
 * a feed has nothing to observe.
 */
export function extractLiteLLM(input: LiteLLMExtractInput): LiteLLMExtractResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch (e) {
    throw new Error(`LiteLLM body is not JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('LiteLLM body is not a JSON object keyed by model.');
  }
  const feed = parsed as Record<string, unknown>;

  const out: LiteLLMExtractResult = { observations: [], missing: [], malformed: [] };
  for (const [model_id, { key }] of Object.entries(input.keys)) {
    const raw = feed[key];
    if (raw === undefined) {
      out.missing.push({ model_id, key });
      continue;
    }
    const entry = LiteLLMEntry.safeParse(raw);
    if (!entry.success) {
      out.malformed.push({ model_id, key, issue: entry.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      continue;
    }
    out.observations.push(...observe(model_id, key, entry.data, input));
  }
  return out;
}

function observe(
  model_id: string,
  key: string,
  e: LiteLLMEntry,
  input: LiteLLMExtractInput,
): Observation[] {
  const provenance: Provenance = {
    method: 'PROVIDER_FORMULA',
    confidence: confidenceCeiling('AGGREGATOR'),
    source_class: 'AGGREGATOR',
    source_url: input.snapshot.source_url,
    verified_at: input.snapshot.retrieved_at,
    verified_by: null,
    notes:
      `LiteLLM key "${key}"` +
      (e.litellm_provider ? ` (litellm_provider: ${e.litellm_provider})` : '') +
      (e.source ? `; LiteLLM cites ${e.source}` : ''),
  };
  const base = { model_id, snapshot_id: input.snapshot.snapshot_id, source_key: key, provenance };
  const rate = (k: RateKey, amount: number): Observation =>
    Observation.parse({ ...base, kind: 'RATE', key: k, amount, unit: 'per_token', currency: input.currency });

  const obs: Observation[] = [];
  if (e.input_cost_per_token !== undefined) {
    obs.push(rate({ direction: 'input', modality: 'text', variant: 'standard', above_tokens: null }, e.input_cost_per_token));
  }
  if (e.input_cost_per_audio_token !== undefined) {
    obs.push(rate({ direction: 'input', modality: 'audio', variant: 'standard', above_tokens: null }, e.input_cost_per_audio_token));
  }
  if (e.output_cost_per_token !== undefined) {
    obs.push(rate({ direction: 'output', modality: null, variant: 'standard', above_tokens: null }, e.output_cost_per_token));
  }
  if (e.cache_creation_input_token_cost !== undefined) {
    obs.push(rate({ direction: 'cache_write', modality: 'text', variant: 'standard', above_tokens: null }, e.cache_creation_input_token_cost));
  }
  if (e.cache_read_input_token_cost !== undefined) {
    obs.push(rate({ direction: 'cache_read', modality: 'text', variant: 'standard', above_tokens: null }, e.cache_read_input_token_cost));
  }

  // Context tiers, by field-name pattern.
  for (const [field, value] of Object.entries(e)) {
    const m = ABOVE.exec(field);
    if (!m || typeof value !== 'number') continue;
    const above_tokens = Number(m[2]) * TOKENS_PER_K;
    const direction =
      m[1] === 'input' ? 'input' : m[1] === 'output' ? 'output' : m[1] === 'cache_read_input' ? 'cache_read' : 'cache_write';
    const modality = direction === 'output' ? null : 'text';
    obs.push(rate({ direction, modality, variant: 'standard', above_tokens }, value));
  }

  if (e.max_input_tokens !== undefined) {
    obs.push(Observation.parse({ ...base, kind: 'LIMIT', which: 'context_window', value: e.max_input_tokens }));
  }
  if (e.max_output_tokens !== undefined) {
    obs.push(Observation.parse({ ...base, kind: 'LIMIT', which: 'max_output', value: e.max_output_tokens }));
  }
  if (e.deprecation_date !== undefined) {
    // The feed states a date; the contract wants an instant. Start of that day, UTC,
    // with the original string kept so nobody reads the midnight as published precision.
    obs.push(
      Observation.parse({
        ...base,
        provenance: { ...provenance, notes: `${provenance.notes}; feed states date only: ${e.deprecation_date}` },
        kind: 'LIFECYCLE',
        which: 'deprecation_date',
        value: `${e.deprecation_date}T00:00:00.000Z`,
      }),
    );
  }
  return obs;
}
