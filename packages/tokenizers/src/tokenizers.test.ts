// /packages/tokenizers/src/tokenizers.test.ts
//
// Every test here runs against a STUB transport. Nothing in this file touches the
// network and no API key exists anywhere in the repo — CI must not depend on a
// vendor's uptime or on a credential somebody committed.
//
// The interesting cases are the failures and the cache key, not the happy path.
//
//   pnpm vitest packages/tokenizers     # offline, free

import { describe, it, expect } from 'vitest';
import {
  countTokensAnthropic,
  countWithLadder,
  CountCache,
  cacheKey,
  fingerprint,
  ANTHROPIC_COUNT_URL,
  COUNT_CAVEAT,
  type CountRequest,
  type CountResponse,
  type CountTokensPort,
} from './index';

const KEY = 'sk-test-not-a-real-key-0000';

/** A transport that records what it was asked and answers from a script. */
function stub(answers: CountResponse[] | ((req: CountRequest) => CountResponse)) {
  const seen: CountRequest[] = [];
  let i = 0;
  const port: CountTokensPort = async (req) => {
    seen.push(req);
    if (typeof answers === 'function') return answers(req);
    const a = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return a!;
  };
  return { port, seen, calls: () => seen.length };
}

const ok = (input_tokens: number): CountResponse => ({
  status: 200,
  json: { input_tokens },
  text: JSON.stringify({ input_tokens }),
});

const INPUT = {
  model_id: 'claude-opus-5',
  messages: [{ role: 'user', content: 'Summarize this contract.' }],
};

const opts = (port: CountTokensPort) => ({
  port,
  apiKey: KEY,
  now: () => new Date('2026-09-08T04:16:10.000Z'),
});

/* ══════════════ the request the vendor documents ══════════════ */

describe('countTokensAnthropic builds the documented request', () => {
  it('posts model and messages to the count endpoint', async () => {
    const s = stub([ok(1234)]);
    const r = await countTokensAnthropic(INPUT, opts(s.port));
    expect(r.status).toBe('COUNTED');
    expect(s.seen[0]!.url).toBe(ANTHROPIC_COUNT_URL);
    expect(s.seen[0]!.body).toMatchObject({
      model: 'claude-opus-5',
      messages: INPUT.messages,
    });
  });

  it('omits system, tools and thinking when they are absent rather than sending nulls', async () => {
    const s = stub([ok(10)]);
    await countTokensAnthropic(INPUT, opts(s.port));
    const body = s.seen[0]!.body as Record<string, unknown>;
    expect('system' in body).toBe(false);
    expect('tools' in body).toBe(false);
    expect('thinking' in body).toBe(false);
  });

  it('sends system, tools and thinking when supplied — all three are counted', async () => {
    const s = stub([ok(10)]);
    await countTokensAnthropic(
      { ...INPUT, system: 'You are terse.', tools: [{ name: 't' }], thinking: { type: 'adaptive' } },
      opts(s.port),
    );
    const body = s.seen[0]!.body as Record<string, unknown>;
    expect(body.system).toBe('You are terse.');
    expect(body.tools).toEqual([{ name: 't' }]);
    expect(body.thinking).toEqual({ type: 'adaptive' });
  });

  it('reads {input_tokens} and reports tier 1 at HIGH', async () => {
    const r = await countTokensAnthropic(INPUT, opts(stub([ok(1234)]).port));
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.tokens).toBe(1234);
    expect(r.tier).toBe(1);
    expect(r.method).toBe('PROVIDER_COUNT_API');
    expect(r.confidence).toBe('HIGH');
  });

  it('is WHOLE_REQUEST — the count already contains system, tools and framing', async () => {
    // This is the field that stops the estimator adding §A5.1.2 framing and §A5.1.3
    // tool schemas on top of a number that already has them in it.
    const r = await countTokensAnthropic(INPUT, opts(stub([ok(1234)]).port));
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.covers).toBe('WHOLE_REQUEST');
  });

  it('carries the vendor’s own caveats onto every count', async () => {
    const r = await countTokensAnthropic(INPUT, opts(stub([ok(1)]).port));
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.note).toBe(COUNT_CAVEAT);
    expect(r.note).toMatch(/not billed/);
    expect(r.source_url).toMatch(/token-counting$/);
  });
});

/* ══════════════ the failures, which are the point ══════════════ */

describe('countTokensAnthropic refuses instead of throwing', () => {
  it('a 200 with no usable input_tokens BLOCKS — a zero count reads as a free request', async () => {
    for (const bad of [{}, { input_tokens: null }, { input_tokens: '12' }, { input_tokens: 1.5 }, { input_tokens: -1 }]) {
      const r = await countTokensAnthropic(INPUT, opts(stub([{ status: 200, json: bad, text: '' }]).port));
      expect(r.status, JSON.stringify(bad)).toBe('UNAVAILABLE');
      if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/reads as a free request/);
    }
  });

  it('marks a 429 and a 5xx retryable, and a 400 not', async () => {
    const at = async (status: number) =>
      countTokensAnthropic(INPUT, opts(stub([{ status, json: null, text: 'nope' }]).port));
    expect((await at(429) as any).retryable).toBe(true);
    expect((await at(503) as any).retryable).toBe(true);
    expect((await at(400) as any).retryable).toBe(false);
  });

  it('does not spend a call with no key', async () => {
    const s = stub([ok(1)]);
    const r = await countTokensAnthropic(INPUT, { ...opts(s.port), apiKey: '  ' });
    expect(r.status).toBe('UNAVAILABLE');
    expect(s.calls()).toBe(0);
  });

  it('does not spend a call on an empty conversation', async () => {
    const s = stub([ok(1)]);
    const r = await countTokensAnthropic({ ...INPUT, messages: [] }, opts(s.port));
    expect(r.status).toBe('UNAVAILABLE');
    expect(s.calls()).toBe(0);
  });

  it('survives a transport that throws, and reports it retryable', async () => {
    const port: CountTokensPort = async () => {
      throw new Error('socket hang up');
    };
    const r = await countTokensAnthropic(INPUT, opts(port));
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') {
      expect(r.retryable).toBe(true);
      expect(r.reason).toMatch(/socket hang up/);
    }
  });

  it('never lets the key reach an error message, even when the vendor echoes it', async () => {
    const echo: CountTokensPort = async (req) => ({
      status: 401,
      json: null,
      text: `invalid x-api-key: ${(req.headers as Record<string, string>)['x-api-key']}`,
    });
    const r = await countTokensAnthropic(INPUT, opts(echo));
    if (r.status !== 'UNAVAILABLE') throw new Error('expected a refusal');
    expect(r.reason).not.toContain(KEY);
    expect(r.reason).toContain('[redacted]');
  });
});

/* ══════════════ tier 0 — the cache key is the whole file ══════════════ */

describe('the cache key includes the model, because counts are ~30% apart across generations', () => {
  it('does not serve one model’s count for another model’s request', async () => {
    // The documented trap: "newer models use a tokenizer producing ~30% more tokens
    // than earlier models for the same content... always count against the specific
    // model you plan to use." A content-only key would hit here and be a third out.
    const cache = new CountCache();
    const s = stub((req) => ok((req.body as any).model === 'claude-opus-5' ? 1000 : 1300));

    const a = await countWithLadder(INPUT, { ...opts(s.port), cache });
    const b = await countWithLadder({ ...INPUT, model_id: 'claude-haiku-4-5' }, { ...opts(s.port), cache });

    expect((a as any).tokens).toBe(1000);
    expect((b as any).tokens).toBe(1300);
    expect(s.calls()).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('the same model and the same request is one call', async () => {
    const cache = new CountCache();
    const s = stub([ok(777)]);
    const first = await countWithLadder(INPUT, { ...opts(s.port), cache });
    const second = await countWithLadder(INPUT, { ...opts(s.port), cache });
    expect(s.calls()).toBe(1);
    expect((first as any).served_from).toBe(1);
    expect((second as any).served_from).toBe(0);
    expect((second as any).tokens).toBe(777);
  });

  it('a different system prompt, tool set or thinking config is a different count', async () => {
    for (const variant of [
      { system: 'terse' },
      { tools: [{ name: 'search' }] },
      { thinking: { type: 'adaptive' } },
    ]) {
      const cache = new CountCache();
      const s = stub([ok(1)]);
      await countWithLadder(INPUT, { ...opts(s.port), cache });
      await countWithLadder({ ...INPUT, ...variant }, { ...opts(s.port), cache });
      expect(s.calls(), JSON.stringify(variant)).toBe(2);
    }
  });

  it('message ORDER changes the fingerprint; key order in an object does not', () => {
    const a = fingerprint([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);
    const b = fingerprint([{ role: 'user', content: 'b' }, { role: 'user', content: 'a' }]);
    expect(a).not.toBe(b);
    expect(fingerprint({ x: 1, y: 2 })).toBe(fingerprint({ y: 2, x: 1 }));
  });

  it('cacheKey is model-scoped', () => {
    expect(cacheKey({ model_id: 'a', fingerprint: 'f' })).not.toBe(
      cacheKey({ model_id: 'b', fingerprint: 'f' }),
    );
  });
});

/* ══════════════ rule 4 — the tier that ACTUALLY produced the number ══════════════ */

describe('countWithLadder reports the producing tier, not the serving one', () => {
  it('a cached tier-1 count stays tier 1; served_from says it came from the cache', async () => {
    const cache = new CountCache();
    const s = stub([ok(500)]);
    await countWithLadder(INPUT, { ...opts(s.port), cache });
    const hit = await countWithLadder(INPUT, { ...opts(s.port), cache });
    if (hit.status !== 'OK') throw new Error('expected a hit');
    expect(hit.served_from).toBe(0);
    expect(hit.tier).toBe(1);
    expect(hit.method).toBe('PROVIDER_COUNT_API');
  });

  it('a cached tier-3 heuristic is NOT promoted by having been remembered', async () => {
    // §A4.5 is explicit. Tier 0 says where the answer was fetched from, not how it
    // was produced; re-tagging would let a guess acquire a provider's confidence.
    const cache = new CountCache();
    cache.set(
      { model_id: 'claude-opus-5', fingerprint: fingerprint({ messages: INPUT.messages, system: null, tools: null, thinking: null }) },
      {
        tokens: 900, method: 'CALIBRATED_HEURISTIC', confidence: 'LOW', tier: 3,
        covers: 'PROMPT_ONLY', note: 'seeded', stored_at: '2026-09-08T00:00:00.000Z',
      },
    );
    const s = stub([ok(1)]);
    const r = await countWithLadder(INPUT, { ...opts(s.port), cache });
    if (r.status !== 'OK') throw new Error('expected a hit');
    expect(s.calls()).toBe(0);
    expect(r.served_from).toBe(0);
    expect(r.tier).toBe(3);
    expect(r.method).toBe('CALIBRATED_HEURISTIC');
    expect(r.confidence).toBe('LOW');
    expect(r.covers).toBe('PROMPT_ONLY');
  });

  it('falls THROUGH rather than substituting a number when tier 1 fails', async () => {
    // For Anthropic there is no tier 2 to catch this — the ladder drops from 1 to
    // the heuristic, which is the estimator's job and needs calibration this
    // package does not have. So it returns nothing rather than something.
    const s = stub([{ status: 500, json: null, text: 'upstream' }]);
    const r = await countWithLadder(INPUT, opts(s.port));
    expect(r.status).toBe('FELL_THROUGH');
    if (r.status === 'FELL_THROUGH') expect(r.retryable).toBe(true);
  });

  it('does not cache a failure', async () => {
    const cache = new CountCache();
    const s = stub([{ status: 500, json: null, text: 'upstream' }, ok(42)]);
    await countWithLadder(INPUT, { ...opts(s.port), cache });
    expect(cache.size).toBe(0);
    const retry = await countWithLadder(INPUT, { ...opts(s.port), cache });
    expect((retry as any).tokens).toBe(42);
  });

  it('works with no cache at all', async () => {
    const s = stub([ok(11), ok(11)]);
    await countWithLadder(INPUT, opts(s.port));
    const r = await countWithLadder(INPUT, opts(s.port));
    expect(s.calls()).toBe(2);
    expect((r as any).served_from).toBe(1);
  });
});
