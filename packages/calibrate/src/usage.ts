// /packages/calibrate/src/usage.ts
//
// §A5.4 — "reading usage.completion_tokens_details (or the provider's equivalent
// field) from real responses is what feeds this prior — wire that capture from day
// one." This file is the capture. Three adapters, one per provider, each turning
// the provider's own usage object into an `OutputSample`.
//
// The adapters exist because the providers do NOT agree on what "output tokens"
// contains, and the disagreement is exactly the invisible term §A5.4 is about:
//
//   Anthropic   output_tokens INCLUDES thinking. `output_tokens_details.thinking_tokens`
//               is "a breakdown of output tokens by category".        visible = output − thinking
//   OpenAI      output_tokens INCLUDES reasoning. `output_tokens_details.reasoning_tokens`
//               is the breakdown; max_output_tokens bounds both.      visible = output − reasoning
//   Google      candidatesTokenCount EXCLUDES thoughts. totalTokenCount is
//               "prompt + thoughts + response candidates".           visible = candidates
//
// A caller that mapped `output_tokens` → visible for all three would double-count
// reasoning on two providers and miss it on the third. Each mapping below cites the
// sentence it was read from, with the URL and the date it was read; a page that
// carried a publication date has it recorded, one that did not says so.
//
// Every adapter is pure: it takes the parsed usage object, not a response, and
// never touches the network. A key never appears here. The `provenance` on each
// sample says the count is the provider's (`PROVIDER_COUNT_API`) and points at the
// reference the mapping came from.

import { z } from 'zod';
import { OutputSample, type OutputBand, type Provenance } from '@tokenomics/contracts';

/** What every adapter needs beyond the usage object itself. */
export interface SampleContext {
  model_id: string;
  band: OutputBand;
  /** When the response was received. Injected — this package has no clock. */
  observed_at: string;
  response_id?: string | null;
}

const provenance = (source_url: string, ctx: SampleContext, notes: string | null): Provenance => ({
  method: 'PROVIDER_COUNT_API',
  confidence: 'HIGH',
  source_class: 'MEASURED',
  source_url,
  verified_at: ctx.observed_at,
  verified_by: null,
  notes,
});

const make = (
  provider: string,
  source_url: string,
  ctx: SampleContext,
  visible: number,
  reasoning: number | null,
  notes: string | null,
): OutputSample =>
  OutputSample.parse({
    model_id: ctx.model_id,
    band: ctx.band,
    provider,
    visible_output_tokens: visible,
    reasoning_tokens: reasoning,
    observed_at: ctx.observed_at,
    response_id: ctx.response_id ?? null,
    provenance: provenance(source_url, ctx, notes),
  });

/* ─────────────────────────── Anthropic ─────────────────────────── */

/**
 * https://platform.claude.com/docs/en/api/messages — `Usage` schema, read
 * 2026-09-09 (the page shows no publication date):
 *
 *   output_tokens: number           "The number of output tokens which were used."
 *   output_tokens_details:          "Breakdown of output tokens by category."
 *     OutputTokensDetails | null
 *   OutputTokensDetails.thinking_tokens: number
 *                                   "Number of output tokens the model generated as
 *                                    internal reasoning, including the thinking-block
 *                                    delimiter tokens."
 *
 * "Breakdown of output tokens by category" — thinking is a category OF
 * `output_tokens`, so the visible count is the difference. A null `details` means
 * the breakdown was not reported; the sample then carries `reasoning_tokens: null`
 * and its visible count is the whole of `output_tokens`, which may include thinking
 * nobody can see. The note on the sample says so.
 */
export const ANTHROPIC_USAGE_REFERENCE = 'https://platform.claude.com/docs/en/api/messages';

export const AnthropicUsage = z.looseObject({
  output_tokens: z.number().int().nonnegative(),
  output_tokens_details: z
    .looseObject({ thinking_tokens: z.number().int().nonnegative() })
    .nullable()
    .optional(),
});
export type AnthropicUsage = z.infer<typeof AnthropicUsage>;

export function sampleFromAnthropicUsage(usage: unknown, ctx: SampleContext): OutputSample {
  const u = AnthropicUsage.parse(usage);
  const details = u.output_tokens_details ?? null;
  if (details === null) {
    return make('anthropic', ANTHROPIC_USAGE_REFERENCE, ctx, u.output_tokens, null,
      'output_tokens_details was not reported; output_tokens is recorded whole as visible and may include thinking nobody can see.');
  }
  if (details.thinking_tokens > u.output_tokens) {
    throw new Error(
      `Anthropic usage: thinking_tokens (${details.thinking_tokens}) exceeds output_tokens (${u.output_tokens}), but thinking is documented as a category of output. Refusing to record a negative visible count.`,
    );
  }
  return make('anthropic', ANTHROPIC_USAGE_REFERENCE, ctx, u.output_tokens - details.thinking_tokens, details.thinking_tokens, null);
}

/* ─────────────────────────── OpenAI (Responses API) ─────────────────────────── */

/**
 * https://developers.openai.com/api/reference/resources/responses/methods/create —
 * read 2026-09-09 (the page shows no publication date). The example response
 * carries:
 *
 *   "usage": { "input_tokens": 8438, "input_tokens_details": { "cached_tokens": 0,
 *              "cache_write_tokens": 0 }, "output_tokens": 398,
 *              "output_tokens_details": { "reasoning_tokens": 0 }, "total_tokens": 8836 }
 *
 * and the request parameter reads:
 *
 *   max_output_tokens  "An upper bound for the number of tokens that can be generated
 *                       for a response, including visible output tokens and reasoning
 *                       tokens."
 *
 * The details object is a breakdown of `output_tokens`, so visible is the
 * difference — the same shape as Anthropic. The Chat Completions field the spec
 * names, `usage.completion_tokens_details`, is the older API's spelling of the same
 * breakdown; it is not read here because its reference page was not read for this
 * mapping, and a field mapped from memory is a guessed provider fact.
 */
export const OPENAI_RESPONSES_USAGE_REFERENCE =
  'https://developers.openai.com/api/reference/resources/responses/methods/create';

export const OpenAIResponsesUsage = z.looseObject({
  output_tokens: z.number().int().nonnegative(),
  output_tokens_details: z
    .looseObject({ reasoning_tokens: z.number().int().nonnegative() })
    .nullable()
    .optional(),
});
export type OpenAIResponsesUsage = z.infer<typeof OpenAIResponsesUsage>;

export function sampleFromOpenAIResponsesUsage(usage: unknown, ctx: SampleContext): OutputSample {
  const u = OpenAIResponsesUsage.parse(usage);
  const details = u.output_tokens_details ?? null;
  if (details === null) {
    return make('openai', OPENAI_RESPONSES_USAGE_REFERENCE, ctx, u.output_tokens, null,
      'output_tokens_details was not reported; output_tokens is recorded whole as visible and may include reasoning nobody can see.');
  }
  if (details.reasoning_tokens > u.output_tokens) {
    throw new Error(
      `OpenAI usage: reasoning_tokens (${details.reasoning_tokens}) exceeds output_tokens (${u.output_tokens}), but reasoning is documented as part of output. Refusing to record a negative visible count.`,
    );
  }
  return make('openai', OPENAI_RESPONSES_USAGE_REFERENCE, ctx, u.output_tokens - details.reasoning_tokens, details.reasoning_tokens, null);
}

/* ─────────────────────────── Google (Gemini API) ─────────────────────────── */

/**
 * https://ai.google.dev/api/generate-content#UsageMetadata — footer "Last updated
 * 2026-08-28 UTC", read 2026-09-09:
 *
 *   candidatesTokenCount  "Total number of tokens across all the generated response
 *                          candidates."
 *   thoughtsTokenCount    "Output only. Number of tokens of thoughts for thinking models."
 *   totalTokenCount       "Total token count for the generation request (prompt +
 *                          thoughts + response candidates)."
 *
 * Thoughts are ADDITIONAL to candidates — the total is the sum of three parts — so
 * visible is `candidatesTokenCount` as it stands and reasoning is
 * `thoughtsTokenCount`. The opposite of the other two providers.
 *
 * ⚠️ An absent `thoughtsTokenCount` is recorded as null, not zero. The API's JSON
 * omits zero-valued integers (proto3 JSON mapping), so "absent" is ambiguous between
 * "no thoughts" and "not a thinking model" and this adapter cannot tell them apart.
 * Null makes a reasoning model's prior refuse rather than assume a zero, which is the
 * safe direction; a caller that knows thinking was disabled for the request can pass
 * `thoughts_known_zero: true` in the context and the sample records 0.
 */
export const GEMINI_USAGE_REFERENCE = 'https://ai.google.dev/api/generate-content#UsageMetadata';

export const GeminiUsageMetadata = z.looseObject({
  candidatesTokenCount: z.number().int().nonnegative().optional(),
  thoughtsTokenCount: z.number().int().nonnegative().optional(),
});
export type GeminiUsageMetadata = z.infer<typeof GeminiUsageMetadata>;

export function sampleFromGeminiUsage(
  usageMetadata: unknown,
  ctx: SampleContext & { thoughts_known_zero?: boolean },
): OutputSample {
  const u = GeminiUsageMetadata.parse(usageMetadata);
  // candidatesTokenCount can itself be omitted when zero; an empty candidate list
  // is a real (if odd) response, so zero is the honest reading there.
  const visible = u.candidatesTokenCount ?? 0;
  const reasoning =
    u.thoughtsTokenCount !== undefined ? u.thoughtsTokenCount : ctx.thoughts_known_zero ? 0 : null;
  const notes =
    u.thoughtsTokenCount === undefined && !ctx.thoughts_known_zero
      ? 'thoughtsTokenCount was absent; the API omits zero-valued integers, so this is recorded as unknown (null), not zero.'
      : null;
  return make('google', GEMINI_USAGE_REFERENCE, ctx, visible, reasoning, notes);
}
