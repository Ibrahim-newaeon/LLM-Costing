// /packages/tokenizers/src/port.ts
//
// §A4.5 tier 1 — a provider's own count endpoint.
//
// This is the first package in the repo that is ALLOWED to do I/O. `estimator`
// states in its own index that it has "no I/O, no clock, no network"; that is what
// makes every estimate reproducible from its arguments. Tier 1 needs a network call,
// so the call lives here and the estimator receives its result as a plain value.
//
// Everything below is written against a PORT rather than `fetch` directly, for two
// reasons that are not style:
//
//   - the unit tests must never touch the network, or CI becomes dependent on a
//     vendor's uptime and on a credential nobody should be committing;
//   - the same adapter shape has to serve Anthropic, Google and whoever else
//     publishes a count endpoint, and they disagree on everything except the idea.

/** What the transport is asked to do. Deliberately not shaped like `fetch`. */
export interface CountRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}

export interface CountResponse {
  status: number;
  /** Parsed JSON, or null when the body was not JSON. */
  json: unknown;
  /** Raw text, for an error the caller has to be able to read. */
  text: string;
}

/**
 * The seam. A real implementation wraps `fetch`; tests pass a function.
 *
 * It returns a response rather than throwing on a non-2xx, because a 429 and a 400
 * mean different things to a cost estimator and both are information.
 */
export type CountTokensPort = (req: CountRequest) => Promise<CountResponse>;

/** The one place `fetch` appears in this repo. */
export const fetchPort: CountTokensPort = async (req) => {
  const res = await fetch(req.url, {
    method: 'POST',
    headers: { ...req.headers, 'content-type': 'application/json' },
    body: JSON.stringify(req.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
};
