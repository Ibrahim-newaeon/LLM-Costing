// /packages/contracts/src/request.ts
//
// The request-level layer §A5.8's token identity does not cover.
//
// §A5.10 is explicit about where these live: "These belong on the request, not on
// the model row — the same model priced under two service tiers is two different
// answers from one registry entry." A row-level registry has nowhere to put a
// service tier, which is exactly why the term goes missing.
//
//   FINAL_COST = ( TOKEN_TERMS(§A5.8)
//                + cache_storage_tokens x storage_rate x hours_held
//                + tool_use_system_prompt_tokens x input_rate
//                + Σ server_tool_calls x per_call_fee )
//              x service_tier_multiplier
//              x (1 + residency_uplift_pct)
//
// `RequestOptions` is the input half — what the caller chose. `RequestMultipliers`
// is the output half — what was actually applied, recorded on the Candidate so a
// total that does not match the sum of its published rates can be explained.
//
// Spec anchors: §A5.10 (this whole file) · §A6 (residency) · §A3.3 (traceable)

import { z } from 'zod';
import { ServiceTier } from './pricing';
import { Confidence } from './provenance';

/* ─────────────────────────── server tools ─────────────────────────── */

/**
 * A server-side tool the request will call: web search, file search, a code
 * container. §A5.10 — "not token-priced at all", so a token-only estimator returns
 * zero for them, and "an agentic workflow with search enabled can have a majority
 * of its cost here."
 */
export const ServerToolUse = z
  .object({
    /** Must match a `ServerToolFee.tool` on the model row, or the fee is unknown. */
    tool: z.string().min(1),
    /** Calls per execution of the task, not per workflow. */
    calls_per_execution: z.number().nonnegative(),
    /**
     * Calls already made this billing month, for models that publish a free
     * allowance.
     *
     * Null is NOT zero. Zero says the allowance is untouched and the first calls
     * are free; null says nobody knows, and the estimator then bills every call and
     * says it did — a discount that cannot be verified is not applied silently in
     * the customer's favour.
     */
    calls_used_this_month: z.number().nonnegative().nullable().default(null),
  })
  .refine((t) => t.calls_per_execution === 0 || t.tool.trim().length > 0, {
    message: 'A server tool with calls must name the tool the fee is looked up by.',
    path: ['tool'],
  });
export type ServerToolUse = z.infer<typeof ServerToolUse>;

/* ─────────────────────────── the request ─────────────────────────── */

/**
 * How this particular request is to be served. Not a property of the model, not a
 * property of the workflow the analyzer read — a choice made at estimate time, and
 * the natural axis for a scenario sweep.
 */
export const RequestOptions = z
  .object({
    service_tier: ServiceTier.default('standard'),
    /**
     * The endpoint region actually used. Drives the residency uplift, which is
     * invisible until a contract requires the regional endpoint — §A5.10 notes this
     * "binds directly on Gulf routing": the compliant option is not the same price
     * as the default, and a router that filters on residency without applying the
     * uplift understates the compliant path it just recommended.
     */
    region: z.string().min(1).nullable().default(null),
    /**
     * Which tool-choice mode is enabled, for the §A5.10 system-prompt lookup. Null
     * means tools are off; it does not mean the injection is free.
     */
    tool_choice_mode: z.string().min(1).nullable().default(null),
    server_tools: z.array(ServerToolUse).default([]),
  })
  .refine(
    (r) => {
      const names = r.server_tools.map((t) => t.tool);
      return new Set(names).size === names.length;
    },
    {
      message: 'A server tool may appear once — two entries for one tool double-bill it.',
      path: ['server_tools'],
    },
  );
export type RequestOptions = z.infer<typeof RequestOptions>;

/* ─────────────────────────── what was applied ─────────────────────────── */

/** Relative tolerance for the product check below. Float multiplication, not slack. */
const FACTOR_EPSILON = 1e-9;

/**
 * The record of the two multiplicative layers, carried on the Candidate.
 *
 * Without it a total cannot be reconciled against the published rates: every line
 * has been scaled, and nothing on the line says by how much or why. §A3.3 —
 * traceable — is not satisfied by a correct number nobody can reproduce.
 */
export const RequestMultipliers = z
  .object({
    service_tier: ServiceTier,
    /**
     * ⚠️ NOT shared across vendors. §A5.10 records one provider's premium tier at
     * 1.8x where two others use 2x, which is why this arrives from the model row's
     * `ServiceTierProfile` and never from a constant in code (§A3.1).
     */
    service_tier_multiplier: z.number().positive(),
    region: z.string().min(1).nullable().default(null),
    /** Applies to ALL categories, cache reads and writes included (§A5.10). */
    residency_uplift_pct: z.number().min(0),
    /**
     * The single factor applied to every line, so that
     * `total_cost == Σ(base line cost) x combined_factor` still holds and the
     * line decomposition survives the multipliers.
     */
    combined_factor: z.number().positive(),
    /** Floored by the weakest of the two multipliers' own provenance (§A3.7). */
    confidence: Confidence,
  })
  .superRefine((m, ctx) => {
    const expected = m.service_tier_multiplier * (1 + m.residency_uplift_pct);
    if (Math.abs(m.combined_factor - expected) > expected * FACTOR_EPSILON) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `combined_factor must equal service_tier_multiplier x (1 + residency_uplift_pct): expected ${expected}, got ${m.combined_factor}.`,
        path: ['combined_factor'],
      });
    }
  });
export type RequestMultipliers = z.infer<typeof RequestMultipliers>;

/** The neutral pair. Not a default anyone should reach for — a starting point. */
export const IDENTITY_FACTOR = 1;
