// /packages/ingest/src/port.ts
//
// §A4.2 — a pull of a pricing source. The second package in the repo allowed to
// do I/O, for the same reason `tokenizers` was the first: the estimator receives
// values, and something has to go and get them.
//
// Written against a PORT rather than `fetch`, as `tokenizers/port.ts` is, and for
// the same two reasons: the tests must never touch the network, and one shape has
// to serve LiteLLM, OpenRouter and whoever else publishes a feed.
//
// The port is a GET that returns text. A source that needs a POST, a header or a
// credential gets its own port shape when it arrives; widening this one in
// advance would be an interface for a source nobody has read.

export interface FetchRequest {
  url: string;
}

export interface FetchResponse {
  status: number;
  text: string;
}

/**
 * The seam. A real implementation wraps `fetch`; tests pass a function that
 * answers from a fixture. It returns a response rather than throwing on a non-2xx,
 * because a 404 and a 429 are different facts about a source.
 */
export type FetchPort = (req: FetchRequest) => Promise<FetchResponse>;

/** One of the two places `fetch` appears in this repo; the other is tokenizers/port.ts. */
export const fetchPort: FetchPort = async (req) => {
  const res = await fetch(req.url, { method: 'GET' });
  return { status: res.status, text: await res.text() };
};

/**
 * A port that answers each URL from a map and refuses anything else. Refuses
 * rather than returning an empty body, so a test that reaches for a URL its
 * fixture does not cover fails at the seam and not three assertions later.
 */
export function fixturePort(bodies: Readonly<Record<string, string>>): FetchPort {
  return async (req) => {
    const text = bodies[req.url];
    if (text === undefined) {
      throw new Error(`fixturePort: no fixture for ${req.url}. The test is reaching past its evidence.`);
    }
    return { status: 200, text };
  };
}
