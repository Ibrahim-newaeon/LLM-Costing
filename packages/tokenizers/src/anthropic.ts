// /packages/tokenizers/src/anthropic.ts
//
// §A4.5 tier 1 for Anthropic: POST /v1/messages/count_tokens.
//
// Facts this adapter is built on, all from the vendor's own documentation
// (<https://platform.claude.com/docs/en/build-with-claude/token-counting>,
// retrieved 2026-09-08; the page displays no publication date):
//
//   - The endpoint "accepts the same structured inputs as creating a Message":
//     `model`, `messages`, and optionally `system`, `tools`, `thinking`.
//   - The response is a single field: `{ "input_tokens": <number> }`.
//   - The count "includes system prompts, tool definitions, messages, thinking
//     blocks, images and PDFs" — the WHOLE request. This is why the estimator's
//     exact hook needs `covers: 'WHOLE_REQUEST'`; adding §A5.1.2 framing or
//     §A5.1.3 tool schemas on top of this number bills the same tokens twice.
//   - "Token counting is free to use", with its own rate limits (5,000 / 10,000 /
//     20,000 RPM by usage tier) separate from message creation.
//
// Two caveats the vendor states, both carried onto the estimate rather than filed
// under "close enough":
//
//   1. "Token counts may include tokens added automatically by Anthropic for
//      system optimizations. You are not billed for system-added tokens."
//      -> the count can EXCEED what is billed. It is an upper bound in that
//         respect, and saying so is cheaper than explaining a discrepancy later.
//   2. "The token count is an estimate. In some cases, the actual number of input
//      tokens used when creating a message might differ by a small amount."
//
// §A4.5 assigns PROVIDER_COUNT_API a HIGH confidence and that is kept — it is the
// vendor's own count of the vendor's own tokenization, and nothing else available
// is closer. But the two caveats mean tier 1 is not the same claim as a local
// exact tokenizer, and the note records the difference. See the open finding in
// the README.

import type { Confidence, Method } from '@tokenomics/contracts';
import type { CountTokensPort } from './port';

export const ANTHROPIC_COUNT_URL = 'https://api.anthropic.com/v1/messages/count_tokens';

/**
 * The vendor's own words, attached to every count this adapter produces.
 *
 * Not a constant anybody should edit to make an estimate look tighter: it is a
 * quotation, and the source URL sits with it in the provenance.
 */
export const COUNT_CAVEAT =
  'Provider count. It may include system-added tokens that are not billed, and the vendor ' +
  'describes it as an estimate that can differ from actual usage by a small amount.';

/** Exactly the fields the endpoint documents. Nothing is invented here. */
export interface CountTokensInput {
  model_id: string;
  messages: ReadonlyArray<{ role: string; content: unknown }>;
  system?: string | ReadonlyArray<unknown> | null;
  tools?: ReadonlyArray<unknown> | null;
  thinking?: unknown;
}

export interface TierOneCount {
  status: 'COUNTED';
  tokens: number;
  method: Method;
  confidence: Confidence;
  tier: 1;
  /** Always WHOLE_REQUEST for this endpoint. Feeds countTextTokens directly. */
  covers: 'WHOLE_REQUEST';
  note: string;
  source_url: string;
  verified_at: string;
}

export interface TierOneFailure {
  status: 'UNAVAILABLE';
  reason: string;
  /** Set when the vendor answered; absent when the call never landed. */
  http_status: number | null;
  /** True for a 429 or a 5xx — the caller may retry; a 400 it may not. */
  retryable: boolean;
}

export type TierOneResult = TierOneCount | TierOneFailure;

export interface CountTokensOptions {
  port: CountTokensPort;
  /**
   * The API key. Passed in at the call site and never read from a module-level
   * constant, never logged, and never included in an error message — a failure
   * here returns the vendor's status and text, and this adapter does not echo the
   * headers it sent.
   */
  apiKey: string;
  anthropicVersion?: string;
  url?: string;
  /** Injected so a count is reproducible in a test. */
  now?: () => Date;
}

const REDACTED = '[redacted]';

/**
 * One tier-1 count.
 *
 * Refuses rather than throwing, because a failed count is a normal outcome the
 * estimator has a tier for: the ladder falls back to tier 2 or tier 3, and each
 * carries its own lower confidence. An exception here would be indistinguishable
 * from a bug, and the fallback would never happen.
 */
export async function countTokensAnthropic(
  input: CountTokensInput,
  opts: CountTokensOptions,
): Promise<TierOneResult> {
  if (opts.apiKey.trim() === '') {
    return {
      status: 'UNAVAILABLE',
      reason: 'No API key supplied, so tier 1 is unreachable for this call.',
      http_status: null,
      retryable: false,
    };
  }
  if (input.messages.length === 0) {
    return {
      status: 'UNAVAILABLE',
      reason: 'The endpoint requires at least one message; there is nothing to count.',
      http_status: null,
      retryable: false,
    };
  }

  // ⚠️ Documented, and it is not a rounding difference: newer models "use a
  // tokenizer producing ~30% more tokens than earlier models for the same
  // content", and the page says to "always count against the specific model you
  // plan to use". The model id therefore travels with the request and with the
  // cache key; a count is never a property of the text alone.
  const body: Record<string, unknown> = {
    model: input.model_id,
    messages: input.messages,
  };
  if (input.system !== undefined && input.system !== null) body.system = input.system;
  if (input.tools !== undefined && input.tools !== null) body.tools = input.tools;
  if (input.thinking !== undefined) body.thinking = input.thinking;

  const url = opts.url ?? ANTHROPIC_COUNT_URL;

  let res;
  try {
    res = await opts.port({
      url,
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': opts.anthropicVersion ?? '2023-06-01',
      },
      body,
    });
  } catch (e) {
    // The message is the transport's, not ours, and the key never travelled
    // through anything that formats it.
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: 'UNAVAILABLE',
      reason: `The count endpoint could not be reached: ${redact(message, opts.apiKey)}`,
      http_status: null,
      retryable: true,
    };
  }

  if (res.status !== 200) {
    return {
      status: 'UNAVAILABLE',
      reason: `The count endpoint returned ${res.status}: ${redact(truncate(res.text), opts.apiKey)}`,
      http_status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    };
  }

  const tokens = readInputTokens(res.json);
  if (tokens === null) {
    return {
      status: 'UNAVAILABLE',
      reason:
        'The count endpoint answered 200 with no usable `input_tokens`. A shape change here must ' +
        'block rather than resolve to zero — a zero token count reads as a free request.',
      http_status: res.status,
      retryable: false,
    };
  }

  return {
    status: 'COUNTED',
    tokens,
    method: 'PROVIDER_COUNT_API',
    confidence: 'HIGH',
    tier: 1,
    covers: 'WHOLE_REQUEST',
    note: COUNT_CAVEAT,
    source_url: 'https://platform.claude.com/docs/en/build-with-claude/token-counting',
    verified_at: (opts.now ?? (() => new Date()))().toISOString(),
  };
}

/**
 * `{ "input_tokens": <number> }`, and nothing else accepted.
 *
 * A non-integer, a negative, or a missing field returns null so the caller refuses.
 * Coercing would turn a vendor shape change into a silent zero, and a zero token
 * count is a free request.
 */
function readInputTokens(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) return null;
  const v = (json as Record<string, unknown>).input_tokens;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) return null;
  return v;
}

const truncate = (s: string, max = 300) => (s.length <= max ? s : `${s.slice(0, max)}…`);

/**
 * Belt and braces. The key is never deliberately placed in an error, but a
 * transport that echoes its request — or a vendor that quotes the offending header
 * back — would otherwise put it in a log.
 */
function redact(s: string, key: string): string {
  return key.length >= 8 ? s.split(key).join(REDACTED) : s;
}
