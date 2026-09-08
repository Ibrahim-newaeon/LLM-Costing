// /packages/contracts/src/request.test.ts
//
// The §A5.10 request-level shapes. Refinements only — the behaviour that consumes
// them is tested in packages/estimator/src/request.test.ts.
//
//   pnpm vitest src/request.test.ts     # offline, free

import { describe, it, expect } from 'vitest';
import { RequestOptions, RequestMultipliers, ServerToolUse } from './request';
import { ImageMetrics } from './workflow';

describe('RequestOptions', () => {
  it('defaults to the standard tier with no region and no tools', () => {
    const r = RequestOptions.parse({});
    expect(r.service_tier).toBe('standard');
    expect(r.region).toBeNull();
    expect(r.tool_choice_mode).toBeNull();
    expect(r.server_tools).toEqual([]);
  });

  it('refuses the same server tool twice — two entries double-bill it', () => {
    expect(() =>
      RequestOptions.parse({
        server_tools: [
          { tool: 'web_search', calls_per_execution: 1 },
          { tool: 'web_search', calls_per_execution: 2 },
        ],
      }),
    ).toThrow(/may appear once/);
  });

  it('keeps null distinct from zero on month-to-date usage', () => {
    // Zero says the allowance is untouched; null says nobody knows. Collapsing them
    // hands the customer a discount nobody verified.
    const known = ServerToolUse.parse({ tool: 'web_search', calls_per_execution: 1, calls_used_this_month: 0 });
    const unknown = ServerToolUse.parse({ tool: 'web_search', calls_per_execution: 1 });
    expect(known.calls_used_this_month).toBe(0);
    expect(unknown.calls_used_this_month).toBeNull();
  });
});

describe('RequestMultipliers', () => {
  const base = {
    service_tier: 'priority' as const,
    service_tier_multiplier: 2,
    region: 'me-central',
    residency_uplift_pct: 0.15,
    confidence: 'HIGH' as const,
  };

  it('accepts the product of the two layers', () => {
    expect(RequestMultipliers.parse({ ...base, combined_factor: 2 * 1.15 }).combined_factor).toBeCloseTo(2.3, 12);
  });

  it('refuses a factor that silently dropped the uplift', () => {
    expect(() => RequestMultipliers.parse({ ...base, combined_factor: 2 })).toThrow(
      /combined_factor must equal/,
    );
  });

  it('refuses a factor that silently dropped the tier multiplier', () => {
    expect(() => RequestMultipliers.parse({ ...base, combined_factor: 1.15 })).toThrow(
      /combined_factor must equal/,
    );
  });
});

describe('ImageMetrics.candidates_per_accepted_image (§A5.10 re-rolls)', () => {
  const m = (over: Record<string, unknown> = {}) =>
    ImageMetrics.parse({ dimensions_source: 'USER_STATED', operation: 'generate', ...over });

  it('defaults to 1, which §A5.10 records as almost never the real figure', () => {
    expect(m().candidates_per_accepted_image).toBe(1);
  });

  it('accepts a real candidate count on a generating operation', () => {
    expect(m({ candidates_per_accepted_image: 4 }).candidates_per_accepted_image).toBe(4);
  });

  it('refuses a candidate count on an analysed image — that would multiply a vision bill', () => {
    expect(() => m({ operation: 'analyze', candidates_per_accepted_image: 3 })).toThrow(
      /generation, not analysis/,
    );
  });
});
